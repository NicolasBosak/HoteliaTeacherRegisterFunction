const { app } = require('@azure/functions');

const {
    normalizeText,
    safeParseJson,
    getUserDataValue,
    playfabRequestFromEnv: playfabRequest
} = require('../lib/playfabClient');


const ROLE_KEY = 'Role';
const TEACHER_COURSES_KEY = 'Hotelia_TeacherCourses';
const AI_PARAMS_KEY = 'Hotelia_AIQuestionParameters';
const CLASS_AI_REGISTRY_KEY = 'Hotelia_ClassAIRegistry';





function findTeacherCourse(coursesData, courseId, classCode) {
    if (!coursesData || !Array.isArray(coursesData.courses)) {
        return null;
    }

    return coursesData.courses.find(course =>
        course &&
        course.courseId === courseId &&
        (course.classCode === classCode || course.courseCode === classCode) &&
        course.status === 'ACTIVE'
    );
}

function upsertParameter(parameters, parameter) {
    const index = parameters.findIndex(item => item.courseId === parameter.courseId);

    if (index >= 0) {
        parameters[index] = parameter;
    } else {
        parameters.push(parameter);
    }
}

function upsertRegistryItem(classes, item) {
    const index = classes.findIndex(existing => existing.classCode === item.classCode);

    if (index >= 0) {
        classes[index] = item;
    } else {
        classes.push(item);
    }
}

app.http('saveAIQuestionParameters', {
    methods: ['POST'],
    authLevel: 'anonymous',
    handler: async (request, context) => {
        try {
            const body = await request.json();

            const sessionTicket = normalizeText(body.sessionTicket);
            const courseId = normalizeText(body.courseId);
            const subjectCode = normalizeText(body.subjectCode);
            const subjectName = normalizeText(body.subjectName);
            const classCode = normalizeText(body.classCode);

            const scenarioParameters = normalizeText(body.scenarioParameters);
            const focusInstructions = normalizeText(body.focusInstructions);
            const questionGoal = normalizeText(body.questionGoal);
            const allowedTopicsCsv = normalizeText(body.allowedTopicsCsv);
            const correctKeywordsCsv = normalizeText(body.correctKeywordsCsv);
            const wrongKeywordsCsv = normalizeText(body.wrongKeywordsCsv);

            const npcRole = normalizeText(body.npcRole) || 'hotel guest';
            const answerLanguage = normalizeText(body.answerLanguage) || 'English';

            if (!sessionTicket) {
                return {
                    status: 400,
                    jsonBody: {
                        success: false,
                        message: 'Missing session ticket.'
                    }
                };
            }

            if (!courseId || !subjectCode || !subjectName || !classCode) {
                return {
                    status: 400,
                    jsonBody: {
                        success: false,
                        message: 'Missing course information.'
                    }
                };
            }

            if (!scenarioParameters || !focusInstructions || !questionGoal) {
                return {
                    status: 400,
                    jsonBody: {
                        success: false,
                        message: 'Scenario parameters, focus instructions and question goal are required.'
                    }
                };
            }

            if (!allowedTopicsCsv || !correctKeywordsCsv) {
                return {
                    status: 400,
                    jsonBody: {
                        success: false,
                        message: 'Allowed topics and correct keywords are required.'
                    }
                };
            }

            const authData = await playfabRequest('Server/AuthenticateSessionTicket', {
                SessionTicket: sessionTicket
            });

            const teacherPlayFabId =
                authData &&
                authData.UserInfo &&
                authData.UserInfo.PlayFabId
                    ? authData.UserInfo.PlayFabId
                    : '';

            if (!teacherPlayFabId) {
                return {
                    status: 401,
                    jsonBody: {
                        success: false,
                        message: 'Invalid session ticket.'
                    }
                };
            }

            const roleData = await playfabRequest('Server/GetUserData', {
                PlayFabId: teacherPlayFabId,
                Keys: [ROLE_KEY]
            });

            const role = getUserDataValue(roleData, ROLE_KEY);

            if (role !== 'teacher') {
                return {
                    status: 403,
                    jsonBody: {
                        success: false,
                        message: 'Only teacher accounts can save AI question parameters.'
                    }
                };
            }

            const teacherData = await playfabRequest('Server/GetUserData', {
                PlayFabId: teacherPlayFabId,
                Keys: [TEACHER_COURSES_KEY, AI_PARAMS_KEY]
            });

            const teacherCoursesJson = getUserDataValue(teacherData, TEACHER_COURSES_KEY);
            const teacherCoursesData = safeParseJson(teacherCoursesJson, { courses: [] });

            const teacherCourse = findTeacherCourse(teacherCoursesData, courseId, classCode);

            if (!teacherCourse) {
                return {
                    status: 404,
                    jsonBody: {
                        success: false,
                        message: 'This course was not found for the current teacher.'
                    }
                };
            }

            const existingParamsJson = getUserDataValue(teacherData, AI_PARAMS_KEY);
            const paramsData = safeParseJson(existingParamsJson, { parameters: [] });

            if (!Array.isArray(paramsData.parameters)) {
                paramsData.parameters = [];
            }

            const existingParameter = paramsData.parameters.find(item => item.courseId === courseId);

            const parameter = {
                parameterId: existingParameter && existingParameter.parameterId
                    ? existingParameter.parameterId
                    : `ai_params_${Date.now()}`,

                courseId,
                subjectCode,
                subjectName,
                classCode,
                teacherPlayFabId,

                scenarioParameters,
                focusInstructions,
                questionGoal,
                allowedTopicsCsv,
                correctKeywordsCsv,
                wrongKeywordsCsv,

                npcRole,
                answerLanguage,

                status: 'ACTIVE',
                updatedUtc: new Date().toISOString()
            };

            upsertParameter(paramsData.parameters, parameter);

            await playfabRequest('Server/UpdateUserData', {
                PlayFabId: teacherPlayFabId,
                Data: {
                    [AI_PARAMS_KEY]: JSON.stringify(paramsData)
                },
                Permission: 'Private'
            });

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

            if (!Array.isArray(registry.classes)) {
                registry.classes = [];
            }

            const existingClass = registry.classes.find(item => item.classCode === classCode);

            if (
                existingClass &&
                existingClass.teacherPlayFabId !== teacherPlayFabId &&
                existingClass.status === 'ACTIVE'
            ) {
                return {
                    status: 409,
                    jsonBody: {
                        success: false,
                        message: 'This class code is already registered by another teacher.'
                    }
                };
            }

            upsertRegistryItem(registry.classes, {
                classCode,
                teacherPlayFabId,
                courseId,
                subjectCode,
                subjectName,
                status: 'ACTIVE'
            });

            await playfabRequest('Admin/SetTitleInternalData', {
                Key: CLASS_AI_REGISTRY_KEY,
                Value: JSON.stringify(registry)
            });

            return {
                status: 200,
                jsonBody: {
                    success: true,
                    message: 'AI question parameters saved successfully.',
                    parameters: parameter
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