jest.mock('@azure/functions', () => ({
    app: { http: jest.fn() }
}));
jest.mock('https');

const { app } = require('@azure/functions');
const https = require('https');
const {
    makeRequest,
    makeContext,
    playFabHttpsSuccess,
    routeHttps,
    getRegistration
} = require('../helpers/testUtils');

require('../../src/functions/bulkCreateStudents');

const options = getRegistration(app, 'bulkCreateStudents');
const handler = options.handler;

const ORIGINAL_ENV = process.env;

const VALID_BODY = {
    teacherSessionTicket: 'ticket-1',
    courseId: 'course-1',
    courseName: 'English I',
    courseCode: 'ENG1',
    students: [
        { firstName: 'Ana', lastName: 'Torres', email: 'ana@test.com', banner: 'A123456', ncr: '1234' }
    ]
};

function parseBody(response) {
    return response.jsonBody || JSON.parse(response.body);
}

function authTeacher() {
    return {
        path: '/Server/AuthenticateSessionTicket',
        respond: () => playFabHttpsSuccess({ UserInfo: { PlayFabId: 'T1' } })
    };
}

function teacherRole(role = 'teacher') {
    return {
        path: '/Server/GetUserData',
        when: body => Array.isArray(body.Keys) && body.Keys.includes('UserRole'),
        respond: () => playFabHttpsSuccess({ Data: { Role: { Value: role } } })
    };
}

describe('bulkCreateStudents', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        process.env = {
            ...ORIGINAL_ENV,
            PLAYFAB_TITLE_ID: 'TITLE1',
            PLAYFAB_SECRET_KEY: 'secret-key'
        };
    });

    afterAll(() => {
        process.env = ORIGINAL_ENV;
    });

    it('is registered as an anonymous route accepting GET and POST', () => {
        expect(options).toMatchObject({
            methods: ['GET', 'POST'],
            authLevel: 'anonymous',
            route: 'bulkCreateStudents'
        });
    });

    it('answers the GET health ping', async () => {
        const response = await handler(makeRequest(null, { method: 'GET' }), makeContext());

        expect(response.status).toBe(200);
        expect(parseBody(response).message).toBe('bulkCreateStudents is alive');
    });

    it('returns 400 when the teacher session ticket is missing', async () => {
        const response = await handler(
            makeRequest({ ...VALID_BODY, teacherSessionTicket: '' }),
            makeContext()
        );

        expect(response.status).toBe(400);
        expect(parseBody(response).message).toBe('Missing teacher session ticket.');
    });

    it('returns 400 when course data is missing', async () => {
        const response = await handler(
            makeRequest({ ...VALID_BODY, courseCode: '' }),
            makeContext()
        );

        expect(response.status).toBe(400);
        expect(parseBody(response).message).toBe('Missing course data.');
    });

    it('returns 400 when no students are provided', async () => {
        const response = await handler(
            makeRequest({ ...VALID_BODY, students: [] }),
            makeContext()
        );

        expect(response.status).toBe(400);
        expect(parseBody(response).message).toBe('No students were received.');
    });

    it('returns 500 with a clear message when configuration is missing', async () => {
        delete process.env.PLAYFAB_TITLE_ID;

        const response = await handler(makeRequest(VALID_BODY), makeContext());

        expect(response.status).toBe(500);
        expect(parseBody(response).message).toContain('PLAYFAB_TITLE_ID');
    });

    it('returns 401 when the teacher session is invalid', async () => {
        routeHttps(https, [
            {
                path: '/Server/AuthenticateSessionTicket',
                respond: () => playFabHttpsSuccess({ UserInfo: {} })
            }
        ]);

        const response = await handler(makeRequest(VALID_BODY), makeContext());

        expect(response.status).toBe(401);
        expect(parseBody(response).message).toBe('Invalid teacher session.');
    });

    it('returns 403 when the caller is not a teacher', async () => {
        routeHttps(https, [authTeacher(), teacherRole('student')]);

        const response = await handler(makeRequest(VALID_BODY), makeContext());

        expect(response.status).toBe(403);
        expect(parseBody(response).message).toBe('Only teacher accounts can import students.');
    });

    it('collects per-student validation errors without failing the whole import', async () => {
        routeHttps(https, [authTeacher(), teacherRole('teacher')]);

        const badStudent = {
            firstName: 'Sin',
            lastName: 'Correo',
            email: 'not-an-email',
            banner: 'A123456',
            ncr: '1234'
        };

        const response = await handler(
            makeRequest({ ...VALID_BODY, students: [badStudent] }),
            makeContext()
        );

        const body = parseBody(response);

        expect(response.status).toBe(200);
        expect(body.errorCount).toBe(1);
        expect(body.errors[0]).toContain('Invalid email.');
        expect(body.students).toHaveLength(0);
    });

    it('rejects a student row with an invalid NCR', async () => {
        routeHttps(https, [authTeacher(), teacherRole('teacher')]);

        const response = await handler(
            makeRequest({
                ...VALID_BODY,
                students: [{ ...VALID_BODY.students[0], ncr: '12' }]
            }),
            makeContext()
        );

        expect(parseBody(response).errors[0]).toContain('NCR');
    });
});
