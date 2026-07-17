// saveAIQuestionParameters and getAIQuestionParametersForStudent read
// PLAYFAB_TITLE_ID / PLAYFAB_SECRET_KEY at module load, so the environment must
// be set before requiring them.
process.env.PLAYFAB_TITLE_ID = 'TITLE1';
process.env.PLAYFAB_SECRET_KEY = 'secret-key';

jest.mock('@azure/functions', () => ({
    app: { http: jest.fn() }
}));

const { app } = require('@azure/functions');
const {
    makeRequest,
    makeContext,
    playFabSuccess,
    playFabFailure,
    routeFetch,
    getRegistration
} = require('../helpers/testUtils');

require('../../src/functions/saveAIQuestionParameters');
require('../../src/functions/getAIQuestionParametersForStudent');

const saveOptions = getRegistration(app, 'saveAIQuestionParameters');
const getOptions = getRegistration(app, 'getAIQuestionParametersForStudent');
const saveHandler = saveOptions.handler;
const getHandler = getOptions.handler;

const VALID_SAVE_BODY = {
    sessionTicket: 'ticket-1',
    courseId: 'course-1',
    subjectCode: 'ENG',
    subjectName: 'English',
    classCode: 'NRC1234',
    scenarioParameters: 'Hotel check-in',
    focusInstructions: 'Practice greetings',
    questionGoal: 'Evaluate vocabulary',
    allowedTopicsCsv: 'greetings,rooms',
    correctKeywordsCsv: 'welcome,reservation',
    wrongKeywordsCsv: 'bye'
};

function authAs(playFabId) {
    return {
        path: 'AuthenticateSessionTicket',
        respond: () => playFabSuccess({ UserInfo: { PlayFabId: playFabId } })
    };
}

function roleIs(value) {
    return {
        path: 'GetUserData',
        when: body => Array.isArray(body.Keys) && body.Keys.length === 1 && body.Keys[0] === 'Role',
        respond: () => playFabSuccess({ Data: { Role: { Value: value } } })
    };
}

describe('saveAIQuestionParameters', () => {
    beforeEach(() => {
        global.fetch = jest.fn();
    });

    it('is registered as an anonymous POST route', () => {
        expect(saveOptions).toMatchObject({
            methods: ['POST'],
            authLevel: 'anonymous'
        });
    });

    it('returns 400 when the session ticket is missing', async () => {
        const response = await saveHandler(
            makeRequest({ ...VALID_SAVE_BODY, sessionTicket: '' }),
            makeContext()
        );

        expect(response.status).toBe(400);
        expect(response.jsonBody.message).toBe('Missing session ticket.');
    });

    it('returns 400 when course information is missing', async () => {
        const response = await saveHandler(
            makeRequest({ ...VALID_SAVE_BODY, classCode: '' }),
            makeContext()
        );

        expect(response.status).toBe(400);
        expect(response.jsonBody.message).toBe('Missing course information.');
    });

    it('returns 400 when the pedagogical fields are incomplete', async () => {
        const response = await saveHandler(
            makeRequest({ ...VALID_SAVE_BODY, questionGoal: '' }),
            makeContext()
        );

        expect(response.status).toBe(400);
        expect(response.jsonBody.message).toContain('required');
    });

    it('returns 401 when the session ticket is rejected', async () => {
        routeFetch([
            {
                path: 'AuthenticateSessionTicket',
                respond: () => playFabSuccess({ UserInfo: {} })
            }
        ]);

        const response = await saveHandler(makeRequest(VALID_SAVE_BODY), makeContext());

        expect(response.status).toBe(401);
        expect(response.jsonBody.message).toBe('Invalid session ticket.');
    });

    it('rejects non-teacher accounts', async () => {
        routeFetch([authAs('S1'), roleIs('student')]);

        const response = await saveHandler(makeRequest(VALID_SAVE_BODY), makeContext());

        expect(response.status).toBe(403);
        expect(response.jsonBody.message).toBe('Only teacher accounts can save AI question parameters.');
    });

    it('returns 404 when the course does not belong to the teacher', async () => {
        routeFetch([
            authAs('T1'),
            roleIs('teacher'),
            {
                path: 'GetUserData',
                when: body => Array.isArray(body.Keys) && body.Keys.includes('Hotelia_TeacherCourses'),
                respond: () => playFabSuccess({ Data: {} })
            }
        ]);

        const response = await saveHandler(makeRequest(VALID_SAVE_BODY), makeContext());

        expect(response.status).toBe(404);
        expect(response.jsonBody.message).toBe('This course was not found for the current teacher.');
    });

    it('saves the parameters for a valid teacher course', async () => {
        const teacherCourses = {
            courses: [{ courseId: 'course-1', classCode: 'NRC1234', status: 'ACTIVE' }]
        };

        routeFetch([
            authAs('T1'),
            roleIs('teacher'),
            {
                path: 'GetUserData',
                when: body => Array.isArray(body.Keys) && body.Keys.includes('Hotelia_TeacherCourses'),
                respond: () => playFabSuccess({
                    Data: { Hotelia_TeacherCourses: { Value: JSON.stringify(teacherCourses) } }
                })
            },
            { path: 'UpdateUserData', respond: () => playFabSuccess({}) },
            { path: 'GetTitleInternalData', respond: () => playFabSuccess({ Data: {} }) },
            { path: 'SetTitleInternalData', respond: () => playFabSuccess({}) }
        ]);

        const response = await saveHandler(makeRequest(VALID_SAVE_BODY), makeContext());

        expect(response.status).toBe(200);
        expect(response.jsonBody.success).toBe(true);
        expect(response.jsonBody.parameters).toMatchObject({
            courseId: 'course-1',
            classCode: 'NRC1234',
            teacherPlayFabId: 'T1',
            status: 'ACTIVE'
        });
    });

    it('returns 409 when another teacher already owns the class code', async () => {
        const teacherCourses = {
            courses: [{ courseId: 'course-1', classCode: 'NRC1234', status: 'ACTIVE' }]
        };

        const registry = {
            classes: [{ classCode: 'NRC1234', teacherPlayFabId: 'OTHER-TEACHER', status: 'ACTIVE' }]
        };

        routeFetch([
            authAs('T1'),
            roleIs('teacher'),
            {
                path: 'GetUserData',
                when: body => Array.isArray(body.Keys) && body.Keys.includes('Hotelia_TeacherCourses'),
                respond: () => playFabSuccess({
                    Data: { Hotelia_TeacherCourses: { Value: JSON.stringify(teacherCourses) } }
                })
            },
            { path: 'UpdateUserData', respond: () => playFabSuccess({}) },
            {
                path: 'GetTitleInternalData',
                respond: () => playFabSuccess({
                    Data: { Hotelia_ClassAIRegistry: JSON.stringify(registry) }
                })
            }
        ]);

        const response = await saveHandler(makeRequest(VALID_SAVE_BODY), makeContext());

        expect(response.status).toBe(409);
        expect(response.jsonBody.message).toBe('This class code is already registered by another teacher.');
    });
});

describe('getAIQuestionParametersForStudent', () => {
    beforeEach(() => {
        global.fetch = jest.fn();
    });

    it('is registered as an anonymous POST route', () => {
        expect(getOptions).toMatchObject({
            methods: ['POST'],
            authLevel: 'anonymous'
        });
    });

    it('returns 400 when the session ticket is missing', async () => {
        const response = await getHandler(makeRequest({ classCode: 'NRC1234' }), makeContext());

        expect(response.status).toBe(400);
        expect(response.jsonBody.message).toBe('Missing session ticket.');
    });

    it('returns 400 when the class code is missing', async () => {
        const response = await getHandler(makeRequest({ sessionTicket: 'ticket-1' }), makeContext());

        expect(response.status).toBe(400);
        expect(response.jsonBody.message).toBe('Missing class code.');
    });

    it('rejects non-student accounts', async () => {
        routeFetch([authAs('T1'), roleIs('teacher')]);

        const response = await getHandler(
            makeRequest({ sessionTicket: 'ticket-1', classCode: 'NRC1234' }),
            makeContext()
        );

        expect(response.status).toBe(403);
        expect(response.jsonBody.message).toBe('Only student accounts can load AI question parameters.');
    });

    it('returns 404 when the class code is not registered', async () => {
        routeFetch([
            authAs('S1'),
            roleIs('student'),
            { path: 'GetTitleInternalData', respond: () => playFabSuccess({ Data: {} }) }
        ]);

        const response = await getHandler(
            makeRequest({ sessionTicket: 'ticket-1', classCode: 'NRC1234' }),
            makeContext()
        );

        expect(response.status).toBe(404);
        expect(response.jsonBody.message).toBe('No AI question parameters found for this class code.');
    });

    it('returns 500 when PlayFab fails', async () => {
        routeFetch([
            {
                path: 'AuthenticateSessionTicket',
                respond: () => playFabFailure('Service unavailable', { status: 503 })
            }
        ]);

        const response = await getHandler(
            makeRequest({ sessionTicket: 'ticket-1', classCode: 'NRC1234' }),
            makeContext()
        );

        expect(response.status).toBe(500);
        expect(response.jsonBody.success).toBe(false);
    });

    // ── Full flow: registry hit → assignment check → parameters ──────────

    const REGISTRY = {
        classes: [
            { classCode: 'NRC1234', teacherPlayFabId: 'T1', courseId: 'course-1', status: 'ACTIVE' }
        ]
    };

    function registryHit() {
        return {
            path: 'GetTitleInternalData',
            respond: () => playFabSuccess({
                Data: { Hotelia_ClassAIRegistry: JSON.stringify(REGISTRY) }
            })
        };
    }

    function teacherStudents(students) {
        return {
            path: 'GetUserData',
            when: body => Array.isArray(body.Keys) && body.Keys.includes('Hotelia_TeacherStudents'),
            respond: () => playFabSuccess({
                Data: { Hotelia_TeacherStudents: { Value: JSON.stringify({ students }) } }
            })
        };
    }

    function teacherParams(parameters) {
        return {
            path: 'GetUserData',
            when: body => Array.isArray(body.Keys) && body.Keys.includes('Hotelia_AIQuestionParameters'),
            respond: () => playFabSuccess({
                Data: { Hotelia_AIQuestionParameters: { Value: JSON.stringify({ parameters }) } }
            })
        };
    }

    it('denies a student that is not assigned to the class', async () => {
        routeFetch([
            authAs('S1'),
            roleIs('student'),
            registryHit(),
            teacherStudents([{ studentPlayFabId: 'S-OTHER', courseId: 'course-1', status: 'ACTIVE' }])
        ]);

        const response = await getHandler(
            makeRequest({ sessionTicket: 'ticket-1', classCode: 'NRC1234' }),
            makeContext()
        );

        expect(response.status).toBe(403);
        expect(response.jsonBody.message).toBe('This student is not assigned to this class.');
    });

    it('returns 404 when the class has no matching AI parameters', async () => {
        routeFetch([
            authAs('S1'),
            roleIs('student'),
            registryHit(),
            teacherStudents([{ studentPlayFabId: 'S1', courseId: 'course-1', status: 'ACTIVE' }]),
            teacherParams([{ courseId: 'other-course', status: 'ACTIVE' }])
        ]);

        const response = await getHandler(
            makeRequest({ sessionTicket: 'ticket-1', classCode: 'NRC1234' }),
            makeContext()
        );

        expect(response.status).toBe(404);
        expect(response.jsonBody.message).toBe('AI parameters were not found in teacher data.');
    });

    it('returns the parameters for an assigned student (happy path)', async () => {
        const parameter = {
            courseId: 'course-1',
            classCode: 'NRC1234',
            scenarioParameters: 'Hotel check-in',
            status: 'ACTIVE'
        };

        routeFetch([
            authAs('S1'),
            roleIs('student'),
            registryHit(),
            teacherStudents([{ studentPlayFabId: 'S1', courseId: 'course-1', status: 'ACTIVE' }]),
            teacherParams([parameter])
        ]);

        const response = await getHandler(
            makeRequest({ sessionTicket: 'ticket-1', classCode: 'NRC1234' }),
            makeContext()
        );

        expect(response.status).toBe(200);
        expect(response.jsonBody.success).toBe(true);
        expect(response.jsonBody.parameters).toMatchObject({ courseId: 'course-1', classCode: 'NRC1234' });
    });

    it('matches a student assigned by classCode/ncr instead of courseId', async () => {
        const parameter = { courseId: 'course-1', status: 'ACTIVE' };

        routeFetch([
            authAs('S1'),
            roleIs('student'),
            registryHit(),
            // No courseId on the enrollment, only the ncr — exercises the
            // alternate matching branch in isStudentAssignedToClass.
            teacherStudents([{ playFabId: 'S1', ncr: 'NRC1234', status: 'ACTIVE' }]),
            teacherParams([parameter])
        ]);

        const response = await getHandler(
            makeRequest({ sessionTicket: 'ticket-1', classCode: 'NRC1234' }),
            makeContext()
        );

        expect(response.status).toBe(200);
    });
});
