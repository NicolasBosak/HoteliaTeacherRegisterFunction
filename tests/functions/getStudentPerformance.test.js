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

require('../../src/functions/getStudentPerformance');

const options = getRegistration(app, 'getStudentPerformance');
const handler = options.handler;

const ORIGINAL_ENV = process.env;

const VALID_BODY = { teacherSessionTicket: 'ticket-1', studentPlayFabId: 'PF-STU' };

function authTeacher() {
    return {
        path: '/Server/AuthenticateSessionTicket',
        respond: () => playFabSuccess({ UserInfo: { PlayFabId: 'T1' } })
    };
}

function teacherRole(role = 'teacher') {
    return {
        path: '/Server/GetUserData',
        when: body => Array.isArray(body.Keys) && body.Keys.includes('Role'),
        respond: () => playFabSuccess({ Data: { Role: { Value: role } } })
    };
}

function assignments(students) {
    return {
        path: '/Server/GetUserData',
        when: body => Array.isArray(body.Keys) && body.Keys.includes('Hotelia_TeacherStudents'),
        respond: () => playFabSuccess({
            Data: { Hotelia_TeacherStudents: { Value: JSON.stringify({ students }) } }
        })
    };
}

describe('getStudentPerformance', () => {
    beforeEach(() => {
        process.env = {
            ...ORIGINAL_ENV,
            PLAYFAB_TITLE_ID: 'TITLE1',
            PLAYFAB_SECRET_KEY: 'secret-key'
        };
        global.fetch = jest.fn();
    });

    afterAll(() => {
        process.env = ORIGINAL_ENV;
    });

    it('is registered as an anonymous POST route', () => {
        expect(options).toMatchObject({
            methods: ['POST'],
            authLevel: 'anonymous',
            route: 'getStudentPerformance'
        });
    });

    it('returns 400 when the teacher session ticket is missing', async () => {
        const response = await handler(
            makeRequest({ studentPlayFabId: 'PF-STU' }),
            makeContext()
        );

        expect(response.status).toBe(400);
        expect(response.jsonBody.message).toBe('Missing teacher session ticket.');
    });

    it('returns 400 when the student id is missing', async () => {
        const response = await handler(
            makeRequest({ teacherSessionTicket: 'ticket-1' }),
            makeContext()
        );

        expect(response.status).toBe(400);
        expect(response.jsonBody.message).toBe('Missing student PlayFabId.');
    });

    it('returns 401 when the teacher session is invalid', async () => {
        routeFetch([
            {
                path: '/Server/AuthenticateSessionTicket',
                respond: () => playFabFailure('Invalid session ticket', { status: 401 })
            }
        ]);

        const response = await handler(makeRequest(VALID_BODY), makeContext());

        expect(response.status).toBe(401);
        expect(response.jsonBody.message).toBe('Invalid or expired teacher session.');
    });

    it('returns 403 for non-teacher accounts', async () => {
        routeFetch([authTeacher(), teacherRole('student')]);

        const response = await handler(makeRequest(VALID_BODY), makeContext());

        expect(response.status).toBe(403);
        expect(response.jsonBody.message).toBe('Only teacher accounts can view student performance.');
    });

    it('denies reading a student that is not assigned to this teacher', async () => {
        routeFetch([
            authTeacher(),
            teacherRole('teacher'),
            assignments([{ studentPlayFabId: 'PF-OTHER', status: 'ACTIVE' }])
        ]);

        const response = await handler(makeRequest(VALID_BODY), makeContext());

        expect(response.status).toBe(403);
        expect(response.jsonBody.message).toBe('This student is not assigned to the current teacher.');
    });

    it('returns the parsed game state and daily results for an assigned student', async () => {
        routeFetch([
            authTeacher(),
            teacherRole('teacher'),
            assignments([{ studentPlayFabId: 'PF-STU', status: 'ACTIVE' }]),
            {
                path: '/Server/GetUserData',
                when: body => Array.isArray(body.Keys) && body.Keys.includes('Hotelia_GameState'),
                respond: () => playFabSuccess({
                    Data: {
                        Hotelia_GameState: { Value: JSON.stringify({ hasStartedGame: true, currentDay: 3 }) },
                        Hotelia_DailyResults: { Value: JSON.stringify({ results: [{ day: 1, score: 80 }] }) }
                    }
                })
            }
        ]);

        const response = await handler(makeRequest(VALID_BODY), makeContext());

        expect(response.status).toBe(200);
        expect(response.jsonBody).toMatchObject({
            success: true,
            hasStartedGame: true,
            currentDay: 3,
            results: [{ day: 1, score: 80 }]
        });
    });

    it('returns defaults when the assigned student has no saved data', async () => {
        routeFetch([
            authTeacher(),
            teacherRole('teacher'),
            assignments([{ studentPlayFabId: 'PF-STU', status: 'ACTIVE' }]),
            {
                path: '/Server/GetUserData',
                when: body => Array.isArray(body.Keys) && body.Keys.includes('Hotelia_GameState'),
                respond: () => playFabSuccess({ Data: {} })
            }
        ]);

        const response = await handler(makeRequest(VALID_BODY), makeContext());

        expect(response.jsonBody).toMatchObject({
            success: true,
            hasStartedGame: false,
            currentDay: 0,
            results: []
        });
    });

    it('accepts an assignment stored under the "assignedStudents" key', async () => {
        global.fetch.mockClear();
        routeFetch([
            authTeacher(),
            teacherRole('teacher'),
            {
                path: '/Server/GetUserData',
                when: body => Array.isArray(body.Keys) && body.Keys.includes('Hotelia_TeacherStudents'),
                respond: () => playFabSuccess({
                    Data: {
                        Hotelia_TeacherStudents: {
                            Value: JSON.stringify({ assignedStudents: [{ studentId: 'PF-STU', status: 'ACTIVE' }] })
                        }
                    }
                })
            },
            {
                path: '/Server/GetUserData',
                when: body => Array.isArray(body.Keys) && body.Keys.includes('Hotelia_GameState'),
                respond: () => playFabSuccess({ Data: {} })
            }
        ]);

        const response = await handler(makeRequest(VALID_BODY), makeContext());

        expect(response.status).toBe(200);
        expect(response.jsonBody.success).toBe(true);
    });

    it('ignores an inactive assignment and denies access', async () => {
        routeFetch([
            authTeacher(),
            teacherRole('teacher'),
            assignments([{ studentPlayFabId: 'PF-STU', status: 'INACTIVE' }])
        ]);

        const response = await handler(makeRequest(VALID_BODY), makeContext());

        expect(response.status).toBe(403);
        expect(response.jsonBody.message).toBe('This student is not assigned to the current teacher.');
    });

    it('tolerates a malformed assignments blob and denies access', async () => {
        routeFetch([
            authTeacher(),
            teacherRole('teacher'),
            {
                path: '/Server/GetUserData',
                when: body => Array.isArray(body.Keys) && body.Keys.includes('Hotelia_TeacherStudents'),
                respond: () => playFabSuccess({
                    Data: { Hotelia_TeacherStudents: { Value: '{not-valid-json' } }
                })
            }
        ]);

        const response = await handler(makeRequest(VALID_BODY), makeContext());

        expect(response.status).toBe(403);
    });

    it('returns 400 when the teacher session ticket is missing (no PlayFab calls)', async () => {
        const response = await handler(
            makeRequest({ studentPlayFabId: 'PF-STU' }),
            makeContext()
        );

        expect(response.status).toBe(400);
        expect(response.jsonBody.message).toBe('Missing teacher session ticket.');
    });
});
