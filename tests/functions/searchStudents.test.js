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

require('../../src/functions/searchStudents');

const options = getRegistration(app, 'searchStudents');
const handler = options.handler;

const ORIGINAL_ENV = process.env;

const TEACHER_SESSION = { teacherSessionTicket: 'ticket-1' };

function authAs(role, playFabId = 'T1') {
    return [
        {
            path: '/Server/AuthenticateSessionTicket',
            respond: () => playFabSuccess({ UserInfo: { PlayFabId: playFabId } })
        },
        {
            path: '/Server/GetUserData',
            respond: () => playFabSuccess({ Data: { Role: { Value: role } } })
        }
    ];
}

function studentIndex(students) {
    return {
        path: '/Admin/GetTitleInternalData',
        respond: () => playFabSuccess({
            Data: { Hotelia_StudentIndex: JSON.stringify({ students }) }
        })
    };
}

describe('searchStudents', () => {
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
            route: 'searchStudents'
        });
    });

    it('returns 400 when the teacher session ticket is missing', async () => {
        const response = await handler(makeRequest({}), makeContext());

        expect(response.status).toBe(400);
        expect(response.jsonBody).toEqual({
            success: false,
            message: 'Missing teacher session ticket.',
            students: []
        });
        expect(global.fetch).not.toHaveBeenCalled();
    });

    it('returns 401 when the session is invalid', async () => {
        routeFetch([
            {
                path: '/Server/AuthenticateSessionTicket',
                respond: () => playFabFailure('Invalid session ticket', { status: 401 })
            }
        ]);

        const response = await handler(makeRequest(TEACHER_SESSION), makeContext());

        expect(response.status).toBe(401);
        expect(response.jsonBody.message).toBe('Invalid or expired teacher session.');
    });

    it('returns 403 for non-teacher accounts', async () => {
        routeFetch(authAs('student'));

        const response = await handler(makeRequest(TEACHER_SESSION), makeContext());

        expect(response.status).toBe(403);
        expect(response.jsonBody.message).toBe('Only teacher accounts can search students.');
    });

    it('returns only active students when there is no query', async () => {
        routeFetch([
            ...authAs('teacher'),
            studentIndex([
                { playFabId: 'PF1', email: 'ana@test.com', displayName: 'Ana', status: 'ACTIVE' },
                { playFabId: 'PF2', email: 'luis@test.com', displayName: 'Luis', status: 'INACTIVE' },
                { playFabId: 'PF3', email: 'eva@test.com', displayName: 'Eva' }
            ])
        ]);

        const response = await handler(makeRequest(TEACHER_SESSION), makeContext());

        expect(response.status).toBe(200);
        expect(response.jsonBody.message).toBe('All students loaded.');
        expect(response.jsonBody.students.map(s => s.playFabId)).toEqual(['PF1', 'PF3']);
    });

    it('filters by email or display name', async () => {
        routeFetch([
            ...authAs('teacher'),
            studentIndex([
                { playFabId: 'PF1', email: 'ana@test.com', displayName: 'Ana Torres' },
                { playFabId: 'PF2', email: 'luis@test.com', displayName: 'Luis Vega' }
            ])
        ]);

        const response = await handler(
            makeRequest({ ...TEACHER_SESSION, query: 'TORRES' }),
            makeContext()
        );

        expect(response.jsonBody.message).toBe('Students found.');
        expect(response.jsonBody.students).toHaveLength(1);
        expect(response.jsonBody.students[0].playFabId).toBe('PF1');
    });

    it('exposes only the three whitelisted fields per student', async () => {
        routeFetch([
            ...authAs('teacher'),
            studentIndex([
                {
                    playFabId: 'PF1',
                    email: 'ana@test.com',
                    displayName: 'Ana',
                    banner: 'A123456',
                    ncr: '1234'
                }
            ])
        ]);

        const response = await handler(makeRequest(TEACHER_SESSION), makeContext());

        expect(Object.keys(response.jsonBody.students[0]).sort()).toEqual([
            'displayName',
            'email',
            'playFabId'
        ]);
    });

    it('returns an empty list when the index does not exist yet', async () => {
        routeFetch([
            ...authAs('teacher'),
            { path: '/Admin/GetTitleInternalData', respond: () => playFabSuccess({ Data: {} }) }
        ]);

        const response = await handler(makeRequest(TEACHER_SESSION), makeContext());

        expect(response.status).toBe(200);
        expect(response.jsonBody.students).toEqual([]);
    });

    it('returns 500 when PlayFab fails', async () => {
        routeFetch([
            ...authAs('teacher'),
            {
                path: '/Admin/GetTitleInternalData',
                respond: () => playFabFailure('API key invalid', { status: 401 })
            }
        ]);

        const response = await handler(makeRequest(TEACHER_SESSION), makeContext());

        expect(response.status).toBe(500);
        expect(response.jsonBody.message).toBe('Internal server error.');
    });
});
