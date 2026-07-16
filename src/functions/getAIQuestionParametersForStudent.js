const { app } = require('@azure/functions');

const PLAYFAB_TITLE_ID = process.env.PLAYFAB_TITLE_ID;
const PLAYFAB_SECRET_KEY = process.env.PLAYFAB_SECRET_KEY;

const ROLE_KEY = 'Role';
const AI_PARAMS_KEY = 'Hotelia_AIQuestionParameters';
const CLASS_AI_REGISTRY_KEY = 'Hotelia_ClassAIRegistry';
const TEACHER_STUDENTS_KEY = 'Hotelia_TeacherStudents';

async function playfabRequest(path, body) {
    if (!PLAYFAB_TITLE_ID || !PLAYFAB_SECRET_KEY) {
        throw new Error('Missing PLAYFAB_TITLE_ID or PLAYFAB_SECRET_KEY app settings.');
    }

    const response = await fetch(`https://${PLAYFAB_TITLE_ID}.playfabapi.com/${path}`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'X-SecretKey': PLAYFAB_SECRET_KEY
        },
        body: JSON.stringify(body || {})
    });

    const text = await response.text();

    let json;

    try {
        json = JSON.parse(text);
    } catch {
        throw new Error(`Invalid PlayFab response: ${text}`);
    }

    if (!response.ok || json.code !== 200) {
        throw new Error(json.errorMessage || text);
    }

    return json.data;
}

function safeParseJson(value, fallback) {
    if (!value) return fallback;

    try {
        return JSON.parse(value);
    } catch {
        return fallback;
    }
}

function getUserDataValue(data, key) {
    if (!data || !data.Data || !data.Data[key]) {
        return '';
    }

    return data.Data[key].Value || '';
}

function normalizeText(value) {
    return typeof value === 'string' ? value.trim() : '';
}

function normalizeId(value) {
    return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function isActiveStatus(value) {
    const status = normalizeText(value || 'ACTIVE').toUpperCase();
    return status === 'ACTIVE';
}

function getAssignedStudentsArray(data) {
    if (!data) return [];

    if (Array.isArray(data.students)) {
        return data.students;
    }

    if (Array.isArray(data.assignedStudents)) {
        return data.assignedStudents;
    }

    return [];
}

function isStudentAssignedToClass(assignedStudents, studentPlayFabId, classItem, classCode) {
    if (!Array.isArray(assignedStudents)) return false;

    const targetStudentId = normalizeId(studentPlayFabId);
    const targetCourseId = normalizeId(classItem.courseId);
    const targetClassCode = normalizeId(classCode);

    return assignedStudents.some(student => {
        if (!student || !isActiveStatus(student.status)) {
            return false;
        }

        const savedStudentId =
            normalizeId(student.studentPlayFabId) ||
            normalizeId(student.playFabId) ||
            normalizeId(student.studentId);

        const savedCourseId = normalizeId(student.courseId);

        const savedClassCode =
            normalizeId(student.classCode) ||
            normalizeId(student.courseCode) ||
            normalizeId(student.nrc) ||
            normalizeId(student.ncr);

        const sameStudent = savedStudentId === targetStudentId;
        const sameCourse = savedCourseId === targetCourseId;
        const sameClass = savedClassCode === targetClassCode;

        return sameStudent && (sameCourse || sameClass);
    });
}

app.http('getAIQuestionParametersForStudent', {
    methods: ['POST'],
    authLevel: 'anonymous',
    handler: async (request, context) => {
        try {
            const body = await request.json();

            const sessionTicket = normalizeText(body.sessionTicket);
            const classCode = normalizeText(body.classCode);

            if (!sessionTicket) {
                return {
                    status: 400,
                    jsonBody: {
                        success: false,
                        message: 'Missing session ticket.'
                    }
                };
            }

            if (!classCode) {
                return {
                    status: 400,
                    jsonBody: {
                        success: false,
                        message: 'Missing class code.'
                    }
                };
            }

            const authData = await playfabRequest('Server/AuthenticateSessionTicket', {
                SessionTicket: sessionTicket
            });

            const studentPlayFabId =
                authData &&
                authData.UserInfo &&
                authData.UserInfo.PlayFabId
                    ? authData.UserInfo.PlayFabId
                    : '';

            if (!studentPlayFabId) {
                return {
                    status: 401,
                    jsonBody: {
                        success: false,
                        message: 'Invalid session ticket.'
                    }
                };
            }

            const roleData = await playfabRequest('Server/GetUserData', {
                PlayFabId: studentPlayFabId,
                Keys: [ROLE_KEY]
            });

            const role = getUserDataValue(roleData, ROLE_KEY);

            if (role !== 'student') {
                return {
                    status: 403,
                    jsonBody: {
                        success: false,
                        message: 'Only student accounts can load AI question parameters.'
                    }
                };
            }

            const registryData = await playfabRequest('Admin/GetTitleInternalData', {
                Keys: [CLASS_AI_REGISTRY_KEY]
            });

            const registryJson =
                registryData &&
                registryData.Data &&
                registryData.Data[CLASS_AI_REGISTRY_KEY]
                    ? registryData.Data[CLASS_AI_REGISTRY_KEY]
                    : '';

            const registry = safeParseJson(registryJson, { classes: [] });

            const classItem = Array.isArray(registry.classes)
                ? registry.classes.find(item =>
                    item.classCode === classCode &&
                    item.status === 'ACTIVE'
                )
                : null;

            if (!classItem) {
                return {
                    status: 404,
                    jsonBody: {
                        success: false,
                        message: 'No AI question parameters found for this class code.'
                    }
                };
            }

            const teacherStudentsData = await playfabRequest('Server/GetUserData', {
                PlayFabId: classItem.teacherPlayFabId,
                Keys: [TEACHER_STUDENTS_KEY]
            });

            const teacherStudentsJson = getUserDataValue(
                teacherStudentsData,
                TEACHER_STUDENTS_KEY
            );

            const teacherStudentsParsed = safeParseJson(teacherStudentsJson, {
                students: []
            });

            const assignedStudents = getAssignedStudentsArray(teacherStudentsParsed);

            const studentIsAssignedToClass = isStudentAssignedToClass(
                assignedStudents,
                studentPlayFabId,
                classItem,
                classCode
            );

            if (!studentIsAssignedToClass) {
                return {
                    status: 403,
                    jsonBody: {
                        success: false,
                        message: 'This student is not assigned to this class.'
                    }
                };
            }

            const teacherData = await playfabRequest('Server/GetUserData', {
                PlayFabId: classItem.teacherPlayFabId,
                Keys: [AI_PARAMS_KEY]
            });

            const paramsJson = getUserDataValue(teacherData, AI_PARAMS_KEY);
            const paramsData = safeParseJson(paramsJson, { parameters: [] });

            const parameters = Array.isArray(paramsData.parameters)
                ? paramsData.parameters.find(item =>
                    item.courseId === classItem.courseId &&
                    item.status === 'ACTIVE'
                )
                : null;

            if (!parameters) {
                return {
                    status: 404,
                    jsonBody: {
                        success: false,
                        message: 'AI parameters were not found in teacher data.'
                    }
                };
            }

            return {
                status: 200,
                jsonBody: {
                    success: true,
                    message: 'AI question parameters loaded.',
                    parameters
                }
            };
        } catch (error) {
            context.error(error);

            return {
                status: 500,
                jsonBody: {
                    success: false,
                    message: error.message || 'Internal server error.'
                }
            };
        }
    }
});