const { app } = require('@azure/functions');
const https = require('https');

const OPENAI_HOSTNAME = 'api.openai.com';
const OPENAI_PATH = '/v1/responses';

const STUDENT_ROLE = 'student';
const ROLE_KEY = 'Role';

const REQUEST_TIMEOUT_MS = 30000;

const httpsAgent = new https.Agent({
    keepAlive: true,
    maxSockets: 20
});

app.http('generateNpcDialogue', {
    methods: ['POST'],
    authLevel: 'anonymous',
    route: 'generateNpcDialogue',

    handler: async (request, context) => {
        try {
            const body = await readJsonBody(request);

            const sessionTicket = normalizeText(body.sessionTicket);
            const prompt = normalizeText(body.prompt);

            if (!sessionTicket) {
                return npcResponse(
                    401,
                    false,
                    'Missing session ticket.',
                    ''
                );
            }

            if (!prompt) {
                return npcResponse(
                    400,
                    false,
                    'Missing prompt.',
                    ''
                );
            }

            if (prompt.length > 5000) {
                return npcResponse(
                    400,
                    false,
                    'Prompt too long.',
                    ''
                );
            }

            const titleId = getRequiredEnv(
                'PLAYFAB_TITLE_ID'
            );

            const secretKey = getRequiredEnv(
                'PLAYFAB_SECRET_KEY'
            );

            const apiKey = getRequiredEnv(
                'OPENAI_API_KEY'
            );

            const model =
                normalizeText(process.env.OPENAI_MODEL) ||
                'gpt-5.6-luna';

            /*
             * Validar la sesión del estudiante.
             */
            let studentPlayFabId = '';

            try {
                studentPlayFabId =
                    await authenticateSessionTicket(
                        titleId,
                        secretKey,
                        sessionTicket
                    );
            } catch (error) {
                context.error(
                    'PlayFab session validation failed: ' +
                    getSafeErrorMessage(error)
                );

                if (error && error.isPlayFabAuthError) {
                    return npcResponse(
                        401,
                        false,
                        'Invalid or expired session ticket.',
                        ''
                    );
                }

                return npcResponse(
                    502,
                    false,
                    'Could not connect to PlayFab to validate the session.',
                    ''
                );
            }

            /*
             * Comprobar el rol.
             */
            let role = '';

            try {
                role = await getPlayerRole(
                    titleId,
                    secretKey,
                    studentPlayFabId
                );
            } catch (error) {
                context.error(
                    'Could not read the PlayFab role: ' +
                    getSafeErrorMessage(error)
                );

                return npcResponse(
                    502,
                    false,
                    'Could not verify the student role in PlayFab.',
                    ''
                );
            }

            if (role !== STUDENT_ROLE) {
                return npcResponse(
                    403,
                    false,
                    'Only student accounts can generate NPC dialogue.',
                    ''
                );
            }

            /*
             * Llamar a OpenAI.
             */
            context.log(
                'Calling OpenAI model: ' + model
            );

            let openAiResult;

            try {
                openAiResult = await callOpenAI(
                    apiKey,
                    model,
                    prompt
                );
            } catch (error) {
                context.error(
                    'OpenAI connection failed: ' +
                    getSafeErrorMessage(error)
                );

                return npcResponse(
                    502,
                    false,
                    'Could not connect to OpenAI. Check the Azure Function logs.',
                    ''
                );
            }

            /*
             * OpenAI respondió, pero con error HTTP.
             */
            if (!openAiResult.ok) {
                const openAiMessage =
                    getOpenAIErrorMessage(
                        openAiResult.rawBody
                    );

                context.error(
                    'OpenAI error ' +
                    openAiResult.statusCode +
                    ': ' +
                    openAiMessage
                );

                return npcResponse(
                    502,
                    false,
                    'OpenAI request failed with status ' +
                    openAiResult.statusCode +
                    ': ' +
                    openAiMessage,
                    ''
                );
            }

            /*
             * Extraer el texto generado.
             */
            const npcText = extractOpenAIText(
                openAiResult.jsonBody
            );

            if (!npcText) {
                context.error(
                    'OpenAI returned no usable output text.'
                );

                return npcResponse(
                    502,
                    false,
                    'OpenAI returned empty text.',
                    ''
                );
            }

            return npcResponse(
                200,
                true,
                '',
                cleanResponse(npcText)
            );
        } catch (error) {
            context.error(
                'generateNpcDialogue exception: ' +
                getSafeErrorMessage(error)
            );

            const message =
                error && error.isConfigurationError
                    ? error.message
                    : 'Unexpected server error.';

            return npcResponse(
                500,
                false,
                message,
                ''
            );
        }
    }
});

/*
 * Leer el JSON recibido desde Unity.
 */
async function readJsonBody(request) {
    try {
        return await request.json();
    } catch {
        return {};
    }
}

/*
 * Respuesta común de la función.
 */
function npcResponse(
    status,
    success,
    message,
    text
) {
    return {
        status,

        jsonBody: {
            success,
            message,
            text
        }
    };
}

function normalizeText(value) {
    return typeof value === 'string'
        ? value.trim()
        : '';
}

/*
 * Obtener una variable requerida de Azure.
 */
function getRequiredEnv(name) {
    const value = normalizeText(
        process.env[name]
    );

    if (!value) {
        const error = new Error(
            'Missing environment variable: ' +
            name
        );

        error.isConfigurationError = true;

        throw error;
    }

    return value;
}

/*
 * Validar el SessionTicket con PlayFab.
 */
async function authenticateSessionTicket(
    titleId,
    secretKey,
    sessionTicket
) {
    try {
        const data = await playFabPost(
            titleId,
            '/Server/AuthenticateSessionTicket',
            {
                SessionTicket: sessionTicket
            },
            secretKey
        );

        const playFabId =
            data &&
            data.UserInfo &&
            data.UserInfo.PlayFabId
                ? normalizeText(
                    data.UserInfo.PlayFabId
                )
                : '';

        if (!playFabId) {
            const error = new Error(
                'PlayFab did not return a PlayFabId.'
            );

            error.isPlayFabAuthError = true;

            throw error;
        }

        return playFabId;
    } catch (error) {
        /*
         * Los errores de red no significan que
         * el ticket sea inválido.
         */
        if (error && error.isNetworkError) {
            throw error;
        }

        if (isInvalidSessionError(error)) {
            error.isPlayFabAuthError = true;
        }

        throw error;
    }
}

/*
 * Determinar si PlayFab rechazó el SessionTicket.
 */
function isInvalidSessionError(error) {
    if (!error) {
        return false;
    }

    const message = getSafeErrorMessage(error)
        .toLowerCase();

    const playFabError =
        error.playFabResponse &&
        error.playFabResponse.error
            ? String(
                error.playFabResponse.error
            ).toLowerCase()
            : '';

    return (
        message.includes('session ticket') ||
        message.includes('invalid session') ||
        playFabError.includes('invalidsessionticket') ||
        playFabError.includes('sessionticketexpired')
    );
}

/*
 * Leer el rol del usuario.
 */
async function getPlayerRole(
    titleId,
    secretKey,
    playFabId
) {
    const data = await playFabPost(
        titleId,
        '/Server/GetUserData',
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
 * Solicitud común a PlayFab.
 */
async function playFabPost(
    titleId,
    path,
    body,
    secretKey
) {
    const result = await httpsPostJson({
        hostname:
            titleId + '.playfabapi.com',

        path,

        headers: {
            'X-SecretKey': secretKey
        },

        body,

        timeoutMs: REQUEST_TIMEOUT_MS
    });

    const responseBody =
        result.jsonBody || {};

    if (
        !result.ok ||
        responseBody.error ||
        responseBody.code !== 200
    ) {
        const errorMessage =
            responseBody.errorMessage ||
            (
                'PlayFab request failed with status ' +
                result.statusCode +
                '.'
            );

        const error = new Error(
            errorMessage
        );

        error.statusCode =
            result.statusCode;

        error.playFabResponse =
            responseBody;

        throw error;
    }

    return responseBody.data || {};
}

/*
 * Llamar a Responses API.
 */
async function callOpenAI(
    apiKey,
    model,
    prompt
) {
    return httpsPostJson({
        hostname: OPENAI_HOSTNAME,
        path: OPENAI_PATH,

        headers: {
            'Authorization':
                'Bearer ' + apiKey
        },

        body: {
            model,
            input: prompt,

            max_output_tokens: 150,

            reasoning: {
                effort: 'none'
            },

            text: {
                verbosity: 'low'
            },

            store: false
        },

        timeoutMs: REQUEST_TIMEOUT_MS
    });
}

/*
 * Solicitud HTTPS usando Node.
 *
 * Esta función reemplaza fetch().
 */
function httpsPostJson({
    hostname,
    path,
    headers,
    body,
    timeoutMs
}) {
    return new Promise(
        (resolve, reject) => {
            const jsonBody =
                JSON.stringify(body || {});

            const options = {
                hostname,
                path,
                method: 'POST',

                /*
                 * Evita ciertos problemas de resolución
                 * IPv6 en conexiones salientes.
                 */
                family: 4,

                agent: httpsAgent,

                headers: {
                    'Content-Type':
                        'application/json',

                    'Accept':
                        'application/json',

                    'Content-Length':
                        Buffer.byteLength(jsonBody),

                    ...(headers || {})
                }
            };

            const req = https.request(
                options,
                response => {
                    let rawBody = '';

                    response.setEncoding(
                        'utf8'
                    );

                    response.on(
                        'data',
                        chunk => {
                            rawBody += chunk;
                        }
                    );

                    response.on(
                        'end',
                        () => {
                            let jsonBody = null;

                            if (rawBody) {
                                try {
                                    jsonBody =
                                        JSON.parse(
                                            rawBody
                                        );
                                } catch {
                                    jsonBody = null;
                                }
                            }

                            resolve({
                                statusCode:
                                    response.statusCode ||
                                    0,

                                ok:
                                    response.statusCode >=
                                        200 &&
                                    response.statusCode <
                                        300,

                                rawBody,
                                jsonBody
                            });
                        }
                    );
                }
            );

            req.setTimeout(
                timeoutMs ||
                REQUEST_TIMEOUT_MS,

                () => {
                    const error =
                        new Error(
                            'HTTPS request timed out while connecting to ' +
                            hostname +
                            '.'
                        );

                    error.isNetworkError =
                        true;

                    req.destroy(error);
                }
            );

            req.on(
                'error',
                originalError => {
                    const error =
                        new Error(
                            'HTTPS request to ' +
                            hostname +
                            ' failed: ' +
                            getSafeErrorMessage(
                                originalError
                            )
                        );

                    error.isNetworkError =
                        true;

                    error.code =
                        originalError &&
                        originalError.code
                            ? originalError.code
                            : '';

                    reject(error);
                }
            );

            req.write(jsonBody);
            req.end();
        }
    );
}

/*
 * Obtener el mensaje real de error de OpenAI.
 */
function getOpenAIErrorMessage(
    responseText
) {
    if (!responseText) {
        return (
            'OpenAI returned an empty error response.'
        );
    }

    try {
        const parsed =
            JSON.parse(responseText);

        if (
            parsed &&
            parsed.error &&
            parsed.error.message
        ) {
            return parsed.error.message;
        }

        return responseText;
    } catch {
        return responseText;
    }
}

/*
 * Extraer output_text de Responses API.
 */
function extractOpenAIText(data) {
    if (!data) {
        return '';
    }

    if (
        typeof data.output_text === 'string' &&
        data.output_text.trim()
    ) {
        return data.output_text.trim();
    }

    if (!Array.isArray(data.output)) {
        return '';
    }

    const textParts = [];

    for (const item of data.output) {
        if (
            !item ||
            !Array.isArray(item.content)
        ) {
            continue;
        }

        for (const content of item.content) {
            if (
                content &&
                typeof content.text ===
                    'string' &&
                content.text.trim()
            ) {
                textParts.push(
                    content.text.trim()
                );
            }
        }
    }

    return textParts
        .join('\n')
        .trim();
}

/*
 * Limpiar etiquetas añadidas por el modelo.
 */
function cleanResponse(text) {
    if (!text) {
        return '';
    }

    return String(text)
        .replace(/Tourist:/gi, '')
        .replace(/Client:/gi, '')
        .replace(/NPC:/gi, '')
        .replace(/Hotel Worker:/gi, '')
        .replace(/Worker:/gi, '')
        .trim();
}

function getSafeErrorMessage(error) {
    if (!error) {
        return 'Unknown error.';
    }

    if (typeof error === 'string') {
        return error;
    }

    return error.message ||
        'Unknown error.';
}