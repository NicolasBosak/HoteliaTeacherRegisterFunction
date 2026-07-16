'use strict';

// Test doubles for the Azure Functions runtime and for the two outbound HTTP
// mechanisms the functions use: global fetch and the node https module.

function makeRequest(body, { method = 'POST' } = {}) {
    return {
        method,
        json: async () => {
            if (body instanceof Error) {
                throw body;
            }

            return body;
        }
    };
}

function makeContext() {
    return {
        log: jest.fn(),
        warn: jest.fn(),
        error: jest.fn()
    };
}

function getRegistration(app, name) {
    const call = app.http.mock.calls.find(entry => entry[0] === name);

    if (!call) {
        throw new Error('Function not registered: ' + name);
    }

    return call[1];
}

// ── fetch-based doubles ───────────────────────────────────────────────

function fetchResponse(payload, { status = 200 } = {}) {
    const raw = typeof payload === 'string' ? payload : JSON.stringify(payload);

    return {
        ok: status >= 200 && status < 300,
        status,
        text: async () => raw,
        json: async () => JSON.parse(raw)
    };
}

function playFabSuccess(data) {
    return fetchResponse({ code: 200, status: 'OK', data });
}

function playFabFailure(errorMessage, { status = 400, error = 'BadRequest', errorDetails } = {}) {
    const payload = { code: status, status: 'Error', error, errorMessage };

    if (errorDetails) {
        payload.errorDetails = errorDetails;
    }

    return fetchResponse(payload, { status });
}

// Routes fetch calls by URL fragment (and optionally by request body), so a
// test can describe a whole PlayFab conversation declaratively.
function routeFetch(routes) {
    global.fetch.mockImplementation(async (url, init) => {
        const body = init && init.body ? JSON.parse(init.body) : {};

        for (const route of routes) {
            if (url.includes(route.path) && (!route.when || route.when(body))) {
                return route.respond(body);
            }
        }

        throw new Error('Unexpected fetch call: ' + url + ' body: ' + JSON.stringify(body));
    });
}

// ── https-module doubles ──────────────────────────────────────────────

// Payload shape for routeHttps: { statusCode, body }
function httpsPayload(payload, { statusCode = 200 } = {}) {
    return {
        statusCode,
        body: typeof payload === 'string' ? payload : JSON.stringify(payload)
    };
}

function playFabHttpsSuccess(data) {
    return httpsPayload({ code: 200, status: 'OK', data });
}

function playFabHttpsFailure(errorMessage, { statusCode = 400, errorDetails } = {}) {
    const payload = { code: statusCode, status: 'Error', error: 'BadRequest', errorMessage };

    if (errorDetails) {
        payload.errorDetails = errorDetails;
    }

    return httpsPayload(payload, { statusCode });
}

// Emulates https.request(options, cb) closely enough for the functions that
// use the node core client: honours write/end, res.setEncoding, the
// data/end events, req.on('error') and req.setTimeout.
function routeHttps(https, routes) {
    https.request.mockImplementation((options, callback) => {
        const chunks = [];
        const errorHandlers = [];

        const req = {
            write(data) {
                chunks.push(data);
            },
            on(event, handler) {
                if (event === 'error') {
                    errorHandlers.push(handler);
                }

                return req;
            },
            setTimeout() {
                return req;
            },
            destroy() {
                return req;
            },
            end() {
                let body = {};

                try {
                    body = chunks.length ? JSON.parse(chunks.join('')) : {};
                } catch {
                    body = {};
                }

                const route = routes.find(
                    entry => String(options.path).includes(entry.path) && (!entry.when || entry.when(body))
                );

                if (!route) {
                    const error = new Error('Unexpected https call: ' + options.path);
                    process.nextTick(() => errorHandlers.forEach(handler => handler(error)));
                    return req;
                }

                if (route.networkError) {
                    const error = new Error(route.networkError);
                    error.code = 'ECONNRESET';
                    process.nextTick(() => errorHandlers.forEach(handler => handler(error)));
                    return req;
                }

                const payload = route.respond(body);

                const res = {
                    statusCode: payload.statusCode,
                    setEncoding() {},
                    on(event, handler) {
                        if (event === 'data' && payload.body) {
                            handler(payload.body);
                        }

                        if (event === 'end') {
                            handler();
                        }

                        return res;
                    }
                };

                process.nextTick(() => callback(res));
                return req;
            }
        };

        return req;
    });
}

module.exports = {
    makeRequest,
    makeContext,
    getRegistration,
    fetchResponse,
    playFabSuccess,
    playFabFailure,
    routeFetch,
    httpsPayload,
    playFabHttpsSuccess,
    playFabHttpsFailure,
    routeHttps
};
