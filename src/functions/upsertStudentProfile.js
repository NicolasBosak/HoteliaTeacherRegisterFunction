const { app } = require('@azure/functions');

const STUDENT_INDEX_KEY = 'Hotelia_StudentIndex';
const ROLE_KEY = 'Role';
const STUDENT_ROLE = 'student';
const TEACHER_ROLE = 'teacher';

app.http('upsertStudentProfile', {
    methods: ['POST'],
    authLevel: 'anonymous',
    route: 'upsertStudentProfile',

    handler: async (request, context) => {
        try {
            const body = await readJsonBody(request);
            const sessionTicket = normalizeText(body.sessionTicket);

            if (!sessionTicket) {
                return profileResponse(
                    400,
                    false,
                    'Missing student session ticket.'
                );
            }

            const titleId = getRequiredEnv('PLAYFAB_TITLE_ID');
            const secretKey = getRequiredEnv('PLAYFAB_SECRET_KEY');

            /*
             * El PlayFabId se obtiene desde el ticket autenticado.
             * No se acepta un PlayFabId enviado libremente desde Unity.
             */
            const authenticatedUser = await authenticateSessionTicket(
                titleId,
                secretKey,
                sessionTicket
            );

            if (!authenticatedUser || !authenticatedUser.playFabId) {
                return profileResponse(
                    401,
                    false,
                    'Invalid or expired student session.'
                );
            }

            const playFabId = authenticatedUser.playFabId;

            /*
             * Consultar el rol guardado.
             */
            let role = await getPlayerRole(
                titleId,
                secretKey,
                playFabId
            );

            /*
             * Si la cuenta no tiene rol, se repara automáticamente
             * guardándola como estudiante.
             */
            if (!role) {
                context.log(
                    'No role found for authenticated account. ' +
                    'Saving Role=student for PlayFabId: ' +
                    playFabId
                );

                await setPlayerRole(
                    titleId,
                    secretKey,
                    playFabId,
                    STUDENT_ROLE
                );

                role = STUDENT_ROLE;
            }

            /*
             * Una cuenta de profesor nunca puede agregarse
             * al índice de estudiantes.
             */
            if (role === TEACHER_ROLE) {
                return profileResponse(
                    403,
                    false,
                    'Teacher accounts cannot be added to the student index.'
                );
            }

            /*
             * También se rechaza cualquier rol desconocido.
             */
            if (role !== STUDENT_ROLE) {
                return profileResponse(
                    403,
                    false,
                    'Only student accounts can be added to the student index.'
                );
            }

            /*
             * Obtener correo y nombre directamente desde PlayFab.
             */
            const accountInfo = await getUserAccountInfo(
                titleId,
                secretKey,
                playFabId
            );

            const email = getAccountEmail(
                accountInfo,
                authenticatedUser.userInfo
            );

            if (!email) {
                return profileResponse(
                    400,
                    false,
                    'The authenticated PlayFab account does not have an email address.'
                );
            }

            const displayName = getAccountDisplayName(
                accountInfo,
                authenticatedUser.userInfo,
                email
            );

            /*
             * Leer el índice general de estudiantes.
             */
            const indexData = await getInternalJson(
                titleId,
                secretKey,
                STUDENT_INDEX_KEY,
                {
                    students: []
                }
            );

            if (!Array.isArray(indexData.students)) {
                indexData.students = [];
            }

            const normalizedEmail = email
                .trim()
                .toLowerCase();

            /*
             * Buscar el estudiante por PlayFabId o por correo.
             */
            const existingIndex = indexData.students.findIndex(student => {
                if (!student) {
                    return false;
                }

                const savedPlayFabId = normalizeText(
                    student.playFabId
                );

                const savedEmail = normalizeText(
                    student.email
                ).toLowerCase();

                return savedPlayFabId === playFabId ||
                       savedEmail === normalizedEmail;
            });

            const existingProfile = existingIndex >= 0
                ? indexData.students[existingIndex]
                : null;

            const now = new Date().toISOString();

            /*
             * Crear o actualizar el perfil.
             */
            const studentProfile = {
                ...(existingProfile || {}),

                playFabId,
                email: normalizedEmail,
                displayName,
                status: 'ACTIVE',

                createdAtUtc:
                    existingProfile &&
                    existingProfile.createdAtUtc
                        ? existingProfile.createdAtUtc
                        : now,

                updatedAtUtc: now
            };

            if (existingIndex >= 0) {
                indexData.students[existingIndex] =
                    studentProfile;
            } else {
                indexData.students.push(
                    studentProfile
                );
            }

            /*
             * Guardar nuevamente el índice.
             */
            await setInternalJson(
                titleId,
                secretKey,
                STUDENT_INDEX_KEY,
                indexData
            );

            return {
                status: 200,

                jsonBody: {
                    success: true,
                    message: 'Student profile saved.',

                    profile: {
                        playFabId:
                            studentProfile.playFabId,

                        email:
                            studentProfile.email,

                        displayName:
                            studentProfile.displayName,

                        role:
                            STUDENT_ROLE
                    }
                }
            };
        } catch (error) {
            const message =
                error && error.message
                    ? error.message
                    : 'Unknown error.';

            context.error(
                'upsertStudentProfile failed: ' +
                message
            );

            return profileResponse(
                500,
                false,
                'Internal server error.'
            );
        }
    }
});

async function readJsonBody(request) {
    try {
        return await request.json();
    } catch {
        return {};
    }
}

function profileResponse(
    status,
    success,
    message
) {
    return {
        status,

        jsonBody: {
            success,
            message
        }
    };
}

function normalizeText(value) {
    return typeof value === 'string'
        ? value.trim()
        : '';
}

function getRequiredEnv(name) {
    const value = normalizeText(
        process.env[name]
    );

    if (!value) {
        throw new Error(
            'Missing environment variable: ' +
            name
        );
    }

    return value;
}

/*
 * Autentica el SessionTicket y devuelve el PlayFabId real.
 */
async function authenticateSessionTicket(
    titleId,
    secretKey,
    sessionTicket
) {
    try {
        const data = await playFabPost(
            titleId,
            'Server/AuthenticateSessionTicket',
            {
                SessionTicket: sessionTicket
            },
            secretKey
        );

        const userInfo =
            data &&
            data.UserInfo
                ? data.UserInfo
                : null;

        const playFabId =
            userInfo &&
            userInfo.PlayFabId
                ? normalizeText(
                    userInfo.PlayFabId
                )
                : '';

        return {
            playFabId,
            userInfo
        };
    } catch {
        return null;
    }
}

/*
 * Lee el rol del usuario.
 * Devuelve vacío cuando no existe.
 */
async function getPlayerRole(
    titleId,
    secretKey,
    playFabId
) {
    const data = await playFabPost(
        titleId,
        'Server/GetUserData',
        {
            PlayFabId: playFabId,
            Keys: [ROLE_KEY]
        },
        secretKey
    );

    if (
        !data ||
        !data.Data ||
        !data.Data[ROLE_KEY]
    ) {
        return '';
    }

    return normalizeText(
        data.Data[ROLE_KEY].Value
    ).toLowerCase();
}

/*
 * Guarda Role=student cuando la cuenta no tiene rol.
 */
async function setPlayerRole(
    titleId,
    secretKey,
    playFabId,
    role
) {
    await playFabPost(
        titleId,
        'Server/UpdateUserData',
        {
            PlayFabId: playFabId,

            Data: {
                [ROLE_KEY]: role
            },

            Permission: 'Private'
        },
        secretKey
    );
}

/*
 * Obtiene la información privada de la cuenta.
 */
async function getUserAccountInfo(
    titleId,
    secretKey,
    playFabId
) {
    const data = await playFabPost(
        titleId,
        'Admin/GetUserAccountInfo',
        {
            PlayFabId: playFabId
        },
        secretKey
    );

    return data && data.UserInfo
        ? data.UserInfo
        : {};
}

/*
 * Obtiene el correo desde la cuenta autenticada.
 */
function getAccountEmail(
    accountInfo,
    authenticatedUserInfo
) {
    const accountEmail =
        accountInfo &&
        accountInfo.PrivateInfo &&
        accountInfo.PrivateInfo.Email
            ? accountInfo.PrivateInfo.Email
            : '';

    const authenticatedEmail =
        authenticatedUserInfo &&
        authenticatedUserInfo.PrivateInfo &&
        authenticatedUserInfo.PrivateInfo.Email
            ? authenticatedUserInfo.PrivateInfo.Email
            : '';

    return normalizeText(
        accountEmail ||
        authenticatedEmail
    ).toLowerCase();
}

/*
 * Obtiene el DisplayName.
 * Si no existe, genera uno a partir del correo.
 */
function getAccountDisplayName(
    accountInfo,
    authenticatedUserInfo,
    email
) {
    const accountDisplayName =
        accountInfo &&
        accountInfo.TitleInfo &&
        accountInfo.TitleInfo.DisplayName
            ? accountInfo.TitleInfo.DisplayName
            : '';

    const authenticatedDisplayName =
        authenticatedUserInfo &&
        authenticatedUserInfo.TitleInfo &&
        authenticatedUserInfo.TitleInfo.DisplayName
            ? authenticatedUserInfo.TitleInfo.DisplayName
            : '';

    const savedDisplayName = normalizeText(
        accountDisplayName ||
        authenticatedDisplayName
    );

    if (savedDisplayName) {
        return savedDisplayName;
    }

    const atIndex = email.indexOf('@');

    const emailName =
        atIndex > 0
            ? email.substring(0, atIndex)
            : email;

    const generatedName = emailName
        .replace(/[._-]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();

    return generatedName || 'Student';
}

/*
 * Lee datos internos del título.
 */
async function getInternalJson(
    titleId,
    secretKey,
    key,
    defaultValue
) {
    const data = await playFabPost(
        titleId,
        'Admin/GetTitleInternalData',
        {
            Keys: [key]
        },
        secretKey
    );

    if (
        !data ||
        !data.Data ||
        !data.Data[key]
    ) {
        return defaultValue;
    }

    try {
        return JSON.parse(
            data.Data[key]
        );
    } catch {
        return defaultValue;
    }
}

/*
 * Guarda datos internos del título.
 */
async function setInternalJson(
    titleId,
    secretKey,
    key,
    value
) {
    await playFabPost(
        titleId,
        'Admin/SetTitleInternalData',
        {
            Key: key,
            Value: JSON.stringify(value)
        },
        secretKey
    );
}

/*
 * Función común para solicitudes a PlayFab.
 */
async function playFabPost(
    titleId,
    path,
    body,
    secretKey
) {
    const response = await fetch(
        `https://${titleId}.playfabapi.com/${path}`,
        {
            method: 'POST',

            headers: {
                'Content-Type':
                    'application/json',

                'X-SecretKey':
                    secretKey
            },

            body: JSON.stringify(
                body || {}
            )
        }
    );

    const text = await response.text();

    let result;

    try {
        result = text
            ? JSON.parse(text)
            : {};
    } catch {
        throw new Error(
            'Invalid PlayFab response from ' +
            path +
            '.'
        );
    }

    if (
        !response.ok ||
        !result ||
        result.error ||
        result.code !== 200
    ) {
        const errorMessage =
            result &&
            result.errorMessage
                ? result.errorMessage
                : 'PlayFab request failed: ' +
                  path;

        throw new Error(
            errorMessage
        );
    }

    return result.data || {};
}