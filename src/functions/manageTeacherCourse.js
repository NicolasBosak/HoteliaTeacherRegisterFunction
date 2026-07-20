const { app } = require('@azure/functions');
const { randomBytes } = require('node:crypto');

const TEACHER_COURSES_KEY = 'Hotelia_TeacherCourses';
const COURSE_REGISTRY_KEY = 'Hotelia_CourseRegistry';
const SUBJECT_CATALOG_KEY = 'Hotelia_SubjectCatalog';

const ROLE_KEY = 'Role';
const TEACHER_ROLE = 'teacher';

app.http('manageTeacherCourse', {
    methods: ['GET', 'POST'],
    authLevel: 'anonymous',
    route: 'manageTeacherCourse',

    handler: async (request, context) => {
        if (request.method === 'GET') {
            return jsonResponse(200, {
                success: true,
                message: 'manageTeacherCourse is alive.',
                timeUtc: new Date().toISOString()
            });
        }

        try {
            const body = await readJsonBody(request);

            const sessionTicket = normalizeText(
                body.sessionTicket ||
                body.teacherSessionTicket
            );

            const action = normalizeText(
                body.action
            ).toLowerCase();

            if (!sessionTicket) {
                return jsonResponse(400, {
                    success: false,
                    message: 'Missing teacher session ticket.'
                });
            }

            if (
                action !== 'save' &&
                action !== 'delete'
            ) {
                return jsonResponse(400, {
                    success: false,
                    message: 'Invalid course action.'
                });
            }

            const titleId = getRequiredEnv(
                'PLAYFAB_TITLE_ID'
            );

            const secretKey = getRequiredEnv(
                'PLAYFAB_SECRET_KEY'
            );

            const authenticatedTeacher =
                await authenticateSessionTicket(
                    titleId,
                    secretKey,
                    sessionTicket
                );

            if (
                !authenticatedTeacher ||
                !authenticatedTeacher.playFabId
            ) {
                return jsonResponse(401, {
                    success: false,
                    message:
                        'Invalid or expired teacher session.'
                });
            }

            const teacherPlayFabId =
                authenticatedTeacher.playFabId;

            const role = await getPlayerRole(
                titleId,
                secretKey,
                teacherPlayFabId
            );

            if (role !== TEACHER_ROLE) {
                return jsonResponse(403, {
                    success: false,
                    message:
                        'Only teacher accounts can manage courses.'
                });
            }

            if (action === 'delete') {
                return await deleteTeacherCourse(
                    titleId,
                    secretKey,
                    teacherPlayFabId,
                    normalizeText(body.courseId),
                    context
                );
            }

            return await saveTeacherCourse(
                titleId,
                secretKey,
                teacherPlayFabId,
                {
                    courseId:
                        normalizeText(body.courseId),

                    subjectCode:
                        normalizeText(body.subjectCode),

                    classCode:
                        normalizeText(body.classCode)
                },
                context
            );
        } catch (error) {
            const status =
                error && error.httpStatus
                    ? error.httpStatus
                    : 500;

            const publicMessage =
                error && error.publicMessage
                    ? error.publicMessage
                    : 'Internal server error.';

            context.error(
                'manageTeacherCourse failed: ' +
                (
                    error && error.message
                        ? error.message
                        : 'Unknown error.'
                )
            );

            return jsonResponse(status, {
                success: false,
                message: publicMessage
            });
        }
    }
});

async function saveTeacherCourse(
    titleId,
    secretKey,
    teacherPlayFabId,
    input,
    context
) {
    if (!/^\d{4}$/.test(input.classCode)) {
        return jsonResponse(400, {
            success: false,
            message:
                'NCR must contain exactly 4 numbers.'
        });
    }

    if (!input.subjectCode) {
        return jsonResponse(400, {
            success: false,
            message: 'Select a valid subject.'
        });
    }

    /*
     * La materia se valida contra Hotelia_SubjectCatalog.
     * Unity no decide el nombre ni el periodo.
     */
    const subject = await getActiveSubjectByCode(
        titleId,
        secretKey,
        input.subjectCode
    );

    if (!subject) {
        return jsonResponse(400, {
            success: false,
            message:
                'The selected subject does not exist or is not active.'
        });
    }

    const courseList = await getTeacherCourses(
        titleId,
        secretKey,
        teacherPlayFabId
    );

    let existingCourse = null;

    if (input.courseId) {
        existingCourse =
            courseList.courses.find(course =>
                course &&
                normalizeText(course.courseId) ===
                input.courseId
            ) || null;

        if (!existingCourse) {
            return jsonResponse(404, {
                success: false,
                message: 'Course not found.'
            });
        }

        const savedOwner = normalizeText(
            existingCourse.teacherPlayFabId
        );

        if (
            savedOwner &&
            savedOwner !== teacherPlayFabId
        ) {
            return jsonResponse(403, {
                success: false,
                message:
                    'This course belongs to another teacher.'
            });
        }
    }

    /*
     * Validación secundaria dentro de los cursos del
     * mismo profesor.
     */
    const duplicateInTeacherCourses =
        courseList.courses.find(course => {
            if (!course) {
                return false;
            }

            const savedCourseId =
                normalizeText(course.courseId);

            if (
                existingCourse &&
                savedCourseId ===
                existingCourse.courseId
            ) {
                return false;
            }

            return getCourseClassCode(course) ===
                input.classCode;
        });

    if (duplicateInTeacherCourses) {
        return jsonResponse(409, {
            success: false,
            message:
                'A course with NCR ' +
                input.classCode +
                ' already exists.'
        });
    }

    const courseId = existingCourse
        ? existingCourse.courseId
        : createCourseId();

    const previousClassCode = existingCourse
        ? getCourseClassCode(existingCourse)
        : '';

    /*
     * Registro global compartido entre todos los docentes.
     */
    const registry = await getCourseRegistry(
        titleId,
        secretKey
    );

    const currentRegistration =
        registry.coursesByNcr[input.classCode] ||
        null;

    if (currentRegistration) {
        const sameTeacher =
            normalizeText(
                currentRegistration.teacherPlayFabId
            ) === teacherPlayFabId;

        const sameCourse =
            normalizeText(
                currentRegistration.courseId
            ) === courseId;

        if (!sameTeacher) {
            return jsonResponse(409, {
                success: false,
                message:
                    'The NCR ' +
                    input.classCode +
                    ' already exists and is assigned to another teacher.'
            });
        }

        if (!sameCourse) {
            return jsonResponse(409, {
                success: false,
                message:
                    'A course with NCR ' +
                    input.classCode +
                    ' already exists.'
            });
        }
    }

    const now = new Date().toISOString();

    const savedCourse = {
        courseId,

        subjectName:
            normalizeText(subject.subjectName),

        subjectCode:
            normalizeText(subject.subjectCode),

        period:
            Number(subject.period) || 0,

        classCode:
            input.classCode,

        teacherPlayFabId,
        status: 'ACTIVE',

        /*
         * Campos de compatibilidad con tu código actual.
         */
        courseName:
            normalizeText(subject.subjectName),

        courseCode:
            input.classCode
    };

    const savedIndex =
        courseList.courses.findIndex(course =>
            course &&
            normalizeText(course.courseId) ===
            courseId
        );

    if (savedIndex >= 0) {
        courseList.courses[savedIndex] =
            savedCourse;
    } else {
        courseList.courses.push(
            savedCourse
        );
    }

    /*
     * Preparamos la nueva versión del registro.
     * Si cambió el NCR, liberamos el anterior únicamente
     * cuando pertenece al mismo curso y profesor.
     */
    const originalRegistryJson =
        JSON.stringify(registry);

    if (
        previousClassCode &&
        previousClassCode !== input.classCode
    ) {
        const previousRegistration =
            registry.coursesByNcr[
            previousClassCode
            ];

        if (
            previousRegistration &&
            normalizeText(
                previousRegistration.courseId
            ) === courseId &&
            normalizeText(
                previousRegistration.teacherPlayFabId
            ) === teacherPlayFabId
        ) {
            delete registry.coursesByNcr[
                previousClassCode
            ];
        }
    }

    registry.coursesByNcr[
        input.classCode
    ] = {
        courseId,
        teacherPlayFabId,

        subjectCode:
            savedCourse.subjectCode,

        subjectName:
            savedCourse.subjectName,

        classCode:
            savedCourse.classCode,

        status: 'ACTIVE',

        createdAtUtc:
            currentRegistration &&
                currentRegistration.createdAtUtc
                ? currentRegistration.createdAtUtc
                : now,

        updatedAtUtc: now
    };

    /*
     * Se guarda primero la reserva global del NCR.
     * Si luego falla el guardado del curso, se intenta
     * restaurar el registro anterior.
     */
    await setInternalJson(
        titleId,
        secretKey,
        COURSE_REGISTRY_KEY,
        registry
    );

    try {
        await saveTeacherCourses(
            titleId,
            secretKey,
            teacherPlayFabId,
            courseList
        );
    } catch (error) {
        context.error(
            'Course save failed. Attempting NCR registry rollback.'
        );

        try {
            await setInternalJson(
                titleId,
                secretKey,
                COURSE_REGISTRY_KEY,
                JSON.parse(originalRegistryJson)
            );
        } catch (rollbackError) {
            context.error(
                'Could not rollback course registry: ' +
                rollbackError.message
            );
        }

        throw error;
    }

    return jsonResponse(200, {
        success: true,

        message: existingCourse
            ? 'Course updated successfully.'
            : 'Course created successfully.',

        course: savedCourse
    });
}

async function deleteTeacherCourse(
    titleId,
    secretKey,
    teacherPlayFabId,
    courseId,
    context
) {
    if (!courseId) {
        return jsonResponse(400, {
            success: false,
            message: 'Missing course ID.'
        });
    }

    const courseList = await getTeacherCourses(
        titleId,
        secretKey,
        teacherPlayFabId
    );

    const course = courseList.courses.find(item =>
        item &&
        normalizeText(item.courseId) === courseId
    );

    if (!course) {
        return jsonResponse(404, {
            success: false,
            message: 'Course not found.'
        });
    }

    const savedOwner = normalizeText(
        course.teacherPlayFabId
    );

    if (
        savedOwner &&
        savedOwner !== teacherPlayFabId
    ) {
        return jsonResponse(403, {
            success: false,
            message:
                'This course belongs to another teacher.'
        });
    }

    const classCode =
        getCourseClassCode(course);

    const registry = await getCourseRegistry(
        titleId,
        secretKey
    );

    const originalRegistryJson =
        JSON.stringify(registry);

    const registration =
        registry.coursesByNcr[classCode];

    if (
        registration &&
        normalizeText(registration.courseId) ===
        courseId &&
        normalizeText(
            registration.teacherPlayFabId
        ) === teacherPlayFabId
    ) {
        delete registry.coursesByNcr[
            classCode
        ];
    }

    courseList.courses =
        courseList.courses.filter(item =>
            !item ||
            normalizeText(item.courseId) !==
            courseId
        );

    await setInternalJson(
        titleId,
        secretKey,
        COURSE_REGISTRY_KEY,
        registry
    );

    try {
        await saveTeacherCourses(
            titleId,
            secretKey,
            teacherPlayFabId,
            courseList
        );
    } catch (error) {
        context.error(
            'Course delete failed. Attempting NCR registry rollback.'
        );

        try {
            await setInternalJson(
                titleId,
                secretKey,
                COURSE_REGISTRY_KEY,
                JSON.parse(originalRegistryJson)
            );
        } catch (rollbackError) {
            context.error(
                'Could not rollback course registry: ' +
                rollbackError.message
            );
        }

        throw error;
    }

    return jsonResponse(200, {
        success: true,
        message: 'Course deleted successfully.'
    });
}

async function getActiveSubjectByCode(
    titleId,
    secretKey,
    subjectCode
) {
    const data = await playFabPost(
        titleId,
        'Server/GetTitleData',
        {
            Keys: [SUBJECT_CATALOG_KEY]
        },
        secretKey
    );

    const raw =
        data &&
            data.Data &&
            data.Data[SUBJECT_CATALOG_KEY]
            ? data.Data[SUBJECT_CATALOG_KEY]
            : '';

    if (!raw) {
        throw publicError(
            500,
            'Subject catalog was not found.'
        );
    }

    let parsed;

    try {
        parsed = JSON.parse(raw);
    } catch {
        throw publicError(
            500,
            'Subject catalog contains invalid JSON.'
        );
    }

    const subjects =
        parsed && Array.isArray(parsed.subjects)
            ? parsed.subjects
            : [];

    return subjects.find(subject =>
        subject &&
        normalizeText(subject.subjectCode) ===
        subjectCode &&
        normalizeText(subject.status).toUpperCase() ===
        'ACTIVE'
    ) || null;
}

async function getTeacherCourses(
    titleId,
    secretKey,
    teacherPlayFabId
) {
    const data = await playFabPost(
        titleId,
        'Server/GetUserData',
        {
            PlayFabId: teacherPlayFabId,
            Keys: [TEACHER_COURSES_KEY]
        },
        secretKey
    );

    const raw =
        data &&
            data.Data &&
            data.Data[TEACHER_COURSES_KEY]
            ? data.Data[TEACHER_COURSES_KEY].Value
            : '';

    if (!raw) {
        return {
            courses: []
        };
    }

    try {
        const parsed = JSON.parse(raw);

        return {
            courses:
                parsed &&
                    Array.isArray(parsed.courses)
                    ? parsed.courses
                    : []
        };
    } catch {
        return {
            courses: []
        };
    }
}

async function saveTeacherCourses(
    titleId,
    secretKey,
    teacherPlayFabId,
    courseList
) {
    await playFabPost(
        titleId,
        'Server/UpdateUserData',
        {
            PlayFabId: teacherPlayFabId,

            Data: {
                [TEACHER_COURSES_KEY]:
                    JSON.stringify(courseList)
            },

            Permission: 'Private'
        },
        secretKey
    );
}

async function getCourseRegistry(
    titleId,
    secretKey
) {
    const registry = await getInternalJson(
        titleId,
        secretKey,
        COURSE_REGISTRY_KEY,
        {
            coursesByNcr: {}
        }
    );

    if (
        !registry.coursesByNcr ||
        typeof registry.coursesByNcr !==
        'object' ||
        Array.isArray(registry.coursesByNcr)
    ) {
        registry.coursesByNcr = {};
    }

    return registry;
}

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
            data && data.UserInfo
                ? data.UserInfo
                : null;

        const playFabId =
            userInfo && userInfo.PlayFabId
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
        const message =
            result && result.errorMessage
                ? result.errorMessage
                : 'PlayFab request failed: ' +
                path;

        throw new Error(message);
    }

    return result.data || {};
}

async function readJsonBody(request) {
    try {
        return await request.json();
    } catch {
        return {};
    }
}

function jsonResponse(status, payload) {
    return {
        status,
        headers: {
            'Content-Type': 'application/json'
        },
        jsonBody: payload
    };
}

function normalizeText(value) {
    return typeof value === 'string'
        ? value.trim()
        : '';
}

function getCourseClassCode(course) {
    return normalizeText(
        course &&
        (
            course.classCode ||
            course.courseCode
        )
    );
}

function createCourseId() {
    return (
        'course_' +
        Date.now() +
        '_' +
        randomBytes(4).toString('hex')
    );
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

function publicError(
    status,
    message
) {
    const error = new Error(message);

    error.httpStatus = status;
    error.publicMessage = message;

    return error;
}