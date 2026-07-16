jest.mock('@azure/functions', () => ({
    app: { http: jest.fn() }
}));
jest.mock('https');

const { app } = require('@azure/functions');
const https = require('https');
const {
    makeRequest,
    makeContext,
    httpsPayload,
    playFabHttpsSuccess,
    playFabHttpsFailure,
    routeHttps,
    getRegistration
} = require('../helpers/testUtils');

require('../../src/functions/generateNpcDialogue');

const options = getRegistration(app, 'generateNpcDialogue');
const handler = options.handler;

const ORIGINAL_ENV = process.env;

const VALID_BODY = { sessionTicket: 'ticket-1', prompt: 'Greet the player' };

function authStudent(role = 'student') {
    return [
        {
            path: '/Server/AuthenticateSessionTicket',
            respond: () => playFabHttpsSuccess({ UserInfo: { PlayFabId: 'PF-STU' } })
        },
        {
            path: '/Server/GetUserData',
            respond: () => playFabHttpsSuccess({ Data: { Role: { Value: role } } })
        }
    ];
}

describe('generateNpcDialogue', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        process.env = {
            ...ORIGINAL_ENV,
            PLAYFAB_TITLE_ID: 'TITLE1',
            PLAYFAB_SECRET_KEY: 'secret-key',
            OPENAI_API_KEY: 'sk-test',
            OPENAI_MODEL: 'gpt-5.4-mini'
        };
    });

    afterAll(() => {
        process.env = ORIGINAL_ENV;
    });

    it('is registered as an anonymous POST route', () => {
        expect(options).toMatchObject({
            methods: ['POST'],
            authLevel: 'anonymous',
            route: 'generateNpcDialogue'
        });
    });

    it('returns 401 when the session ticket is missing', async () => {
        const response = await handler(makeRequest({ prompt: 'Hi' }), makeContext());

        expect(response.status).toBe(401);
        expect(response.jsonBody.message).toBe('Missing session ticket.');
    });

    it('returns 400 when the prompt is missing', async () => {
        const response = await handler(makeRequest({ sessionTicket: 'ticket-1' }), makeContext());

        expect(response.status).toBe(400);
        expect(response.jsonBody.message).toBe('Missing prompt.');
    });

    it('returns 400 when the prompt is too long', async () => {
        const response = await handler(
            makeRequest({ sessionTicket: 'ticket-1', prompt: 'x'.repeat(5001) }),
            makeContext()
        );

        expect(response.status).toBe(400);
        expect(response.jsonBody.message).toBe('Prompt too long.');
    });

    it('returns 500 when a required setting is missing', async () => {
        delete process.env.OPENAI_API_KEY;

        const response = await handler(makeRequest(VALID_BODY), makeContext());

        expect(response.status).toBe(500);
        expect(response.jsonBody.success).toBe(false);
    });

    it('returns 401 when PlayFab rejects the session ticket', async () => {
        routeHttps(https, [
            {
                path: '/Server/AuthenticateSessionTicket',
                respond: () => playFabHttpsFailure('Invalid session ticket', { statusCode: 401 })
            }
        ]);

        const response = await handler(makeRequest(VALID_BODY), makeContext());

        expect(response.status).toBe(401);
        expect(response.jsonBody.message).toBe('Invalid or expired session ticket.');
    });

    it('returns 403 for non-student accounts', async () => {
        routeHttps(https, authStudent('teacher'));

        const response = await handler(makeRequest(VALID_BODY), makeContext());

        expect(response.status).toBe(403);
        expect(response.jsonBody.message).toBe('Only student accounts can generate NPC dialogue.');
    });

    it('calls OpenAI with the configured model and cleans the reply', async () => {
        routeHttps(https, [
            ...authStudent(),
            {
                path: '/v1/responses',
                respond: () => httpsPayload({ output_text: 'NPC: Welcome to the hotel!' })
            }
        ]);

        const response = await handler(makeRequest(VALID_BODY), makeContext());

        expect(response.status).toBe(200);
        expect(response.jsonBody).toEqual({
            success: true,
            message: '',
            text: 'Welcome to the hotel!'
        });

        const openAiCall = https.request.mock.calls.find(call => call[0].path === '/v1/responses');
        expect(openAiCall[0].hostname).toBe('api.openai.com');
        expect(openAiCall[0].headers.Authorization).toBe('Bearer sk-test');
    });

    it('extracts text from the structured output array', async () => {
        routeHttps(https, [
            ...authStudent(),
            {
                path: '/v1/responses',
                respond: () => httpsPayload({ output: [{ content: [{ text: 'Hello traveler' }] }] })
            }
        ]);

        const response = await handler(makeRequest(VALID_BODY), makeContext());

        expect(response.jsonBody.text).toBe('Hello traveler');
    });

    it('returns 502 when OpenAI responds with an HTTP error', async () => {
        routeHttps(https, [
            ...authStudent(),
            {
                path: '/v1/responses',
                respond: () => httpsPayload({ error: { message: 'Rate limit exceeded' } }, { statusCode: 429 })
            }
        ]);

        const response = await handler(makeRequest(VALID_BODY), makeContext());

        expect(response.status).toBe(502);
        expect(response.jsonBody.message).toContain('Rate limit exceeded');
    });

    it('returns 502 when OpenAI returns empty text', async () => {
        routeHttps(https, [
            ...authStudent(),
            { path: '/v1/responses', respond: () => httpsPayload({ output: [] }) }
        ]);

        const response = await handler(makeRequest(VALID_BODY), makeContext());

        expect(response.status).toBe(502);
        expect(response.jsonBody.message).toBe('OpenAI returned empty text.');
    });

    it('returns 502 when the OpenAI connection fails', async () => {
        routeHttps(https, [
            ...authStudent(),
            { path: '/v1/responses', networkError: 'socket hang up', respond: () => ({}) }
        ]);

        const response = await handler(makeRequest(VALID_BODY), makeContext());

        expect(response.status).toBe(502);
        expect(response.jsonBody.message).toContain('Could not connect to OpenAI');
    });
});
