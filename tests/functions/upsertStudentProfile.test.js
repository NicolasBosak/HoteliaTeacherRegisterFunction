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

require('../../src/functions/upsertStudentProfile');

const options = getRegistration(app, 'upsertStudentProfile');
const handler = options.handler;

const ORIGINAL_ENV = process.env;

const VALID_BODY = { sessionTicket: 'ticket-1' };

function authAs(playFabId = 'PF1') {
    return {
        path: '/Server/AuthenticateSessionTicket',
        respond: () => playFabSuccess({ UserInfo: { PlayFabId: playFabId } })
    };
}

function role(value) {
    return {
        path: '/Server/GetUserData',
        respond: () => playFabSuccess(
            value ? { Data: { Role: { Value: value } } } : { Data: {} }
        )
    };
}

function accountInfo(email, displayName = 'Ana Torres') {
    return {
        path: 'GetUserAccountInfo',
        respond: () => playFabSuccess({
            UserInfo: {
                PlayFabId: 'PF1',
                PrivateInfo: { Email: email },
                TitleInfo: { DisplayName: displayName }
            }
        })
    };
}

describe('upsertStudentProfile', () => {
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
            route: 'upsertStudentProfile'
        });
    });

    it('returns 400 when the session ticket is missing', async () => {
        const response = await handler(makeRequest({}), makeContext());

        expect(response.status).toBe(400);
        expect(response.jsonBody.message).toBe('Missing student session ticket.');
        expect(global.fetch).not.toHaveBeenCalled();
    });

    it('returns 401 when the session ticket is invalid', async () => {
        routeFetch([
            {
                path: '/Server/AuthenticateSessionTicket',
                respond: () => playFabFailure('Invalid session ticket', { status: 401 })
            }
        ]);

        const response = await handler(makeRequest(VALID_BODY), makeContext());

        expect(response.status).toBe(401);
        expect(response.jsonBody.message).toBe('Invalid or expired student session.');
    });

    it('rejects teacher accounts', async () => {
        routeFetch([authAs(), role('teacher')]);

        const response = await handler(makeRequest(VALID_BODY), makeContext());

        expect(response.status).toBe(403);
        expect(response.jsonBody.message).toBe('Teacher accounts cannot be added to the student index.');
    });

    it('ignores a PlayFabId supplied by the client and uses the authenticated one', async () => {
        routeFetch([
            authAs('PF-REAL'),
            role('student'),
            accountInfo('ana@test.com'),
            { path: '/Admin/GetTitleInternalData', respond: () => playFabSuccess({ Data: {} }) },
            { path: '/Admin/SetTitleInternalData', respond: () => playFabSuccess({}) }
        ]);

        const response = await handler(
            makeRequest({ sessionTicket: 'ticket-1', playFabId: 'PF-SPOOFED' }),
            makeContext()
        );

        expect(response.status).toBe(200);

        const setCall = global.fetch.mock.calls.find(call => call[0].includes('/Admin/SetTitleInternalData'));
        const saved = JSON.parse(JSON.parse(setCall[1].body).Value);

        expect(saved.students[0].playFabId).toBe('PF-REAL');
        expect(JSON.stringify(saved)).not.toContain('PF-SPOOFED');
    });

    it('adds a new student to the index using PlayFab account data', async () => {
        routeFetch([
            authAs('PF1'),
            role('student'),
            accountInfo('ana@test.com', 'Ana Torres'),
            { path: '/Admin/GetTitleInternalData', respond: () => playFabSuccess({ Data: {} }) },
            { path: '/Admin/SetTitleInternalData', respond: () => playFabSuccess({}) }
        ]);

        const response = await handler(makeRequest(VALID_BODY), makeContext());

        expect(response.status).toBe(200);
        expect(response.jsonBody.success).toBe(true);

        const setCall = global.fetch.mock.calls.find(call => call[0].includes('/Admin/SetTitleInternalData'));
        const saved = JSON.parse(JSON.parse(setCall[1].body).Value);

        expect(saved.students).toHaveLength(1);
        expect(saved.students[0]).toMatchObject({
            playFabId: 'PF1',
            email: 'ana@test.com',
            status: 'ACTIVE'
        });
    });

    // A transport failure is swallowed inside authenticateSessionTicket, so an
    // unreachable PlayFab surfaces as "invalid session" rather than a 500.
    it('reports an unreachable PlayFab as an invalid session', async () => {
        global.fetch.mockRejectedValue(new TypeError('fetch failed'));

        const response = await handler(makeRequest(VALID_BODY), makeContext());

        expect(response.status).toBe(401);
        expect(response.jsonBody.success).toBe(false);
    });

    it('returns 500 when a required setting is missing', async () => {
        delete process.env.PLAYFAB_SECRET_KEY;

        const response = await handler(makeRequest(VALID_BODY), makeContext());

        expect(response.status).toBe(500);
        expect(response.jsonBody.success).toBe(false);
    });

    it('repairs a roleless account to student and then saves it', async () => {
        routeFetch([
            authAs('PF1'),
            role(null), // no Role stored → triggers the self-repair branch
            { path: '/Server/UpdateUserData', respond: () => playFabSuccess({}) },
            accountInfo('ana@test.com', 'Ana Torres'),
            { path: '/Admin/GetTitleInternalData', respond: () => playFabSuccess({ Data: {} }) },
            { path: '/Admin/SetTitleInternalData', respond: () => playFabSuccess({}) }
        ]);

        const response = await handler(makeRequest(VALID_BODY), makeContext());

        expect(response.status).toBe(200);
        expect(response.jsonBody.success).toBe(true);

        const roleWrite = global.fetch.mock.calls.find(call =>
            call[0].includes('/Server/UpdateUserData') &&
            JSON.parse(call[1].body).Data &&
            JSON.parse(call[1].body).Data.Role === 'student'
        );
        expect(roleWrite).toBeDefined();
    });

    it('rejects an account with an unknown role', async () => {
        routeFetch([authAs('PF1'), role('admin')]);

        const response = await handler(makeRequest(VALID_BODY), makeContext());

        expect(response.status).toBe(403);
        expect(response.jsonBody.message).toBe('Only student accounts can be added to the student index.');
    });

    it('returns 400 when the account has no email address', async () => {
        routeFetch([
            authAs('PF1'),
            role('student'),
            {
                path: 'GetUserAccountInfo',
                respond: () => playFabSuccess({
                    UserInfo: { PlayFabId: 'PF1', PrivateInfo: {}, TitleInfo: {} }
                })
            }
        ]);

        const response = await handler(makeRequest(VALID_BODY), makeContext());

        expect(response.status).toBe(400);
        expect(response.jsonBody.message).toBe('The authenticated PlayFab account does not have an email address.');
    });

    it('updates an existing student entry instead of duplicating it', async () => {
        routeFetch([
            authAs('PF1'),
            role('student'),
            accountInfo('ana@test.com', 'Ana Torres'),
            {
                path: '/Admin/GetTitleInternalData',
                respond: () => playFabSuccess({
                    Data: {
                        Hotelia_StudentIndex: JSON.stringify({
                            students: [{ playFabId: 'PF1', email: 'old@test.com', displayName: 'Old', status: 'ACTIVE' }]
                        })
                    }
                })
            },
            { path: '/Admin/SetTitleInternalData', respond: () => playFabSuccess({}) }
        ]);

        const response = await handler(makeRequest(VALID_BODY), makeContext());

        expect(response.status).toBe(200);

        const setCall = global.fetch.mock.calls.find(call => call[0].includes('/Admin/SetTitleInternalData'));
        const saved = JSON.parse(JSON.parse(setCall[1].body).Value);

        expect(saved.students).toHaveLength(1);
        expect(saved.students[0].email).toBe('ana@test.com');
    });
});
