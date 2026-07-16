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

require('../../src/functions/registerTeacher');

const options = getRegistration(app, 'registerTeacher');
const handler = options.handler;

const ORIGINAL_ENV = process.env;

const VALID_BODY = { email: 'a@b.c', password: 'x12345678', teacherCode: 'PROF-CODE' };

describe('registerTeacher', () => {
    beforeEach(() => {
        process.env = {
            ...ORIGINAL_ENV,
            PLAYFAB_TITLE_ID: 'TITLE1',
            PLAYFAB_SECRET_KEY: 'secret-key',
            TEACHER_ACCESS_CODE: 'PROF-CODE'
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
            route: 'registerTeacher'
        });
    });

    it('returns 400 when fields are missing', async () => {
        const response = await handler(makeRequest({ email: 'a@b.c' }), makeContext());

        expect(response.status).toBe(400);
        expect(response.jsonBody.message).toBe('Missing email, password, or teacher code.');
    });

    it('returns 500 when the server configuration is missing', async () => {
        delete process.env.TEACHER_ACCESS_CODE;

        const response = await handler(makeRequest(VALID_BODY), makeContext());

        expect(response.status).toBe(500);
        expect(response.jsonBody.message).toBe('Server configuration is missing.');
    });

    it('rejects an invalid teacher access code without calling PlayFab', async () => {
        const response = await handler(
            makeRequest({ ...VALID_BODY, teacherCode: 'WRONG' }),
            makeContext()
        );

        expect(response.status).toBe(200);
        expect(response.jsonBody).toEqual({
            success: false,
            message: 'Invalid teacher access code.'
        });
        expect(global.fetch).not.toHaveBeenCalled();
    });

    it('creates the account and stores the teacher role', async () => {
        routeFetch([
            { path: '/Client/RegisterPlayFabUser', respond: () => playFabSuccess({ PlayFabId: 'PF9' }) },
            { path: '/Server/UpdateUserData', respond: () => playFabSuccess({}) }
        ]);

        const response = await handler(makeRequest(VALID_BODY), makeContext());

        expect(response.status).toBe(200);
        expect(response.jsonBody).toEqual({
            success: true,
            message: 'Teacher account ready. Please log in.'
        });

        const roleCall = global.fetch.mock.calls.find(call => call[0].includes('/Server/UpdateUserData'));
        expect(roleCall[1].headers['X-SecretKey']).toBe('secret-key');
        expect(JSON.parse(roleCall[1].body)).toMatchObject({
            PlayFabId: 'PF9',
            Data: { Role: 'teacher' },
            Permission: 'Private'
        });
    });

    it('falls back to login when the email is already registered', async () => {
        routeFetch([
            {
                path: '/Client/RegisterPlayFabUser',
                respond: () => playFabFailure('Email address not available')
            },
            {
                path: '/Client/LoginWithEmailAddress',
                respond: () => playFabSuccess({ PlayFabId: 'PF3' })
            },
            { path: '/Server/UpdateUserData', respond: () => playFabSuccess({}) }
        ]);

        const response = await handler(makeRequest(VALID_BODY), makeContext());

        expect(response.jsonBody.success).toBe(true);
    });

    it('reports when the email exists but the password is wrong', async () => {
        routeFetch([
            {
                path: '/Client/RegisterPlayFabUser',
                respond: () => playFabFailure('Email address not available')
            },
            {
                path: '/Client/LoginWithEmailAddress',
                respond: () => playFabFailure('Invalid email address or password', { status: 401 })
            }
        ]);

        const response = await handler(makeRequest(VALID_BODY), makeContext());

        expect(response.status).toBe(200);
        expect(response.jsonBody).toEqual({
            success: false,
            message: 'This email is already registered. Log in with the correct password or use another email.'
        });
    });

    it('surfaces other PlayFab registration errors', async () => {
        routeFetch([
            { path: '/Client/RegisterPlayFabUser', respond: () => playFabFailure('Password too short') }
        ]);

        const response = await handler(makeRequest(VALID_BODY), makeContext());

        expect(response.status).toBe(200);
        expect(response.jsonBody).toEqual({ success: false, message: 'Password too short' });
    });

    it('reports a role-save failure without claiming success', async () => {
        routeFetch([
            { path: '/Client/RegisterPlayFabUser', respond: () => playFabSuccess({ PlayFabId: 'PF9' }) },
            {
                path: '/Server/UpdateUserData',
                respond: () => playFabFailure('Server API unavailable', { status: 503 })
            }
        ]);

        const response = await handler(makeRequest(VALID_BODY), makeContext());

        expect(response.status).toBe(200);
        expect(response.jsonBody.success).toBe(false);
        expect(response.jsonBody.message).toBe('Server API unavailable');
    });

    it('returns 500 on unexpected transport errors', async () => {
        global.fetch.mockRejectedValue(new TypeError('fetch failed'));

        const response = await handler(makeRequest(VALID_BODY), makeContext());

        expect(response.status).toBe(500);
        expect(response.jsonBody).toEqual({ success: false, message: 'Internal server error.' });
    });
});
