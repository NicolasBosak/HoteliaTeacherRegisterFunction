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
    playFabHttpsFailure,
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
        {
            firstName: 'Ana',
            lastName: 'Torres',
            email: 'ana@test.com',
            banner: 'A00123456',
            ncr: '1234'
        }
    ]
};

function parseBody(response) {
    return response.jsonBody || JSON.parse(response.body);
}

function authTeacher() {
    return {
        path: '/Server/AuthenticateSessionTicket',
        respond: () =>
            playFabHttpsSuccess({
                UserInfo: { PlayFabId: 'T1' }
            })
    };
}

function teacherRole(role = 'teacher') {
    return {
        path: '/Server/GetUserData',
        when: body =>
            Array.isArray(body.Keys) &&
            body.Keys.includes('UserRole'),
        respond: () =>
            playFabHttpsSuccess({
                Data: {
                    Role: { Value: role }
                }
            })
    };
}

function existingStudentAccount(playFabId = 'S1') {
    return {
        path: '/Admin/GetUserAccountInfo',
        respond: () =>
            playFabHttpsSuccess({
                UserInfo: { PlayFabId: playFabId }
            })
    };
}

function missingStudentAccount() {
    return {
        path: '/Admin/GetUserAccountInfo',
        respond: () => playFabHttpsSuccess({})
    };
}

function registerStudent(playFabId = 'S1') {
    return {
        path: '/Client/RegisterPlayFabUser',
        respond: () =>
            playFabHttpsSuccess({
                PlayFabId: playFabId
            })
    };
}

function studentRole(playFabId = 'S1', role = 'student') {
    return {
        path: '/Server/GetUserData',
        when: body =>
            body.PlayFabId === playFabId &&
            Array.isArray(body.Keys) &&
            body.Keys.length === 1 &&
            body.Keys[0] === 'Role',
        respond: () =>
            playFabHttpsSuccess({
                Data: {
                    Role: { Value: role }
                }
            })
    };
}

function persistenceRoutes({
    playFabId = 'S1',
    enrollments = null,
    indexStudents = null,
    invalidEnrollmentsJson = false,
    invalidIndexJson = false
} = {}) {
    let enrollmentValue = '';

    if (invalidEnrollmentsJson) {
        enrollmentValue = '{invalid-json';
    } else if (Array.isArray(enrollments)) {
        enrollmentValue = JSON.stringify({ enrollments });
    }

    let indexValue = '';

    if (invalidIndexJson) {
        indexValue = '{invalid-json';
    } else if (Array.isArray(indexStudents)) {
        indexValue = JSON.stringify({ students: indexStudents });
    }

    return [
        {
            path: '/Admin/UpdateUserTitleDisplayName',
            respond: () => playFabHttpsSuccess({})
        },
        {
            path: '/Server/GetUserData',
            when: body =>
                body.PlayFabId === playFabId &&
                Array.isArray(body.Keys) &&
                body.Keys.includes('Hotelia_StudentEnrollments'),
            respond: () =>
                playFabHttpsSuccess({
                    Data: enrollmentValue
                        ? {
                            Hotelia_StudentEnrollments: {
                                Value: enrollmentValue
                            }
                        }
                        : {}
                })
        },
        {
            path: '/Server/UpdateUserData',
            respond: () => playFabHttpsSuccess({})
        },
        {
            path: '/Admin/GetTitleInternalData',
            respond: () =>
                playFabHttpsSuccess({
                    Data: indexValue
                        ? {
                            Hotelia_StudentIndex: indexValue
                        }
                        : {}
                })
        },
        {
            path: '/Admin/SetTitleInternalData',
            respond: () => playFabHttpsSuccess({})
        }
    ];
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
        const response = await handler(
            makeRequest(null, { method: 'GET' }),
            makeContext()
        );

        expect(response.status).toBe(200);
        expect(parseBody(response).message).toBe(
            'bulkCreateStudents is alive'
        );
    });

    it('returns 400 when the teacher session ticket is missing', async () => {
        const response = await handler(
            makeRequest({
                ...VALID_BODY,
                teacherSessionTicket: ''
            }),
            makeContext()
        );

        expect(response.status).toBe(400);
        expect(parseBody(response).message).toBe(
            'Missing teacher session ticket.'
        );
    });

    it('returns 400 when course data is missing', async () => {
        const response = await handler(
            makeRequest({
                ...VALID_BODY,
                courseCode: ''
            }),
            makeContext()
        );

        expect(response.status).toBe(400);
        expect(parseBody(response).message).toBe(
            'Missing course data.'
        );
    });

    it('returns 400 when no students are provided', async () => {
        const response = await handler(
            makeRequest({
                ...VALID_BODY,
                students: []
            }),
            makeContext()
        );

        expect(response.status).toBe(400);
        expect(parseBody(response).message).toBe(
            'No students were received.'
        );
    });

    it('returns 500 with a clear message when configuration is missing', async () => {
        delete process.env.PLAYFAB_TITLE_ID;

        const response = await handler(
            makeRequest(VALID_BODY),
            makeContext()
        );

        expect(response.status).toBe(500);
        expect(parseBody(response).message).toContain(
            'PLAYFAB_TITLE_ID'
        );
    });

    it('returns 500 when the request body is invalid JSON', async () => {
        const request = {
            method: 'POST',
            json: jest.fn().mockRejectedValue(
                new Error('Invalid JSON')
            )
        };

        const response = await handler(
            request,
            makeContext()
        );

        const body = parseBody(response);

        expect(response.status).toBe(500);
        expect(body.success).toBe(false);
        expect(body.message).toBe('Invalid JSON body.');
    });

    it('returns 401 when the teacher session is invalid', async () => {
        routeHttps(https, [
            {
                path: '/Server/AuthenticateSessionTicket',
                respond: () =>
                    playFabHttpsSuccess({
                        UserInfo: {}
                    })
            }
        ]);

        const response = await handler(
            makeRequest(VALID_BODY),
            makeContext()
        );

        expect(response.status).toBe(401);
        expect(parseBody(response).message).toBe(
            'Invalid teacher session.'
        );
    });

    it('returns 403 when the caller is not a teacher', async () => {
        routeHttps(https, [
            authTeacher(),
            teacherRole('student')
        ]);

        const response = await handler(
            makeRequest(VALID_BODY),
            makeContext()
        );

        expect(response.status).toBe(403);
        expect(parseBody(response).message).toBe(
            'Only teacher accounts can import students.'
        );
    });

    it('collects per-student validation errors without failing the whole import', async () => {
        routeHttps(https, [
            authTeacher(),
            teacherRole('teacher')
        ]);

        const badStudent = {
            firstName: 'Sin',
            lastName: 'Correo',
            email: 'not-an-email',
            banner: 'A00123456',
            ncr: '1234'
        };

        const response = await handler(
            makeRequest({
                ...VALID_BODY,
                students: [badStudent]
            }),
            makeContext()
        );

        const body = parseBody(response);

        expect(response.status).toBe(200);
        expect(body.errorCount).toBe(1);
        expect(body.errors[0]).toContain('Invalid email address.');
        expect(body.students).toHaveLength(0);
    });

    it('rejects a student row with an invalid NCR', async () => {
        routeHttps(https, [
            authTeacher(),
            teacherRole('teacher')
        ]);

        const response = await handler(
            makeRequest({
                ...VALID_BODY,
                students: [
                    {
                        ...VALID_BODY.students[0],
                        ncr: '12'
                    }
                ]
            }),
            makeContext()
        );

        expect(parseBody(response).errors[0]).toContain('NCR');
    });

    it.each([
        [
            'missing first name',
            { firstName: '' },
            'Missing first name.'
        ],
        [
            'missing last name',
            { lastName: '' },
            'Missing last name.'
        ],
        [
            'missing banner number',
            { banner: '' },
            'Invalid Banner ID'
        ],
        [
            'short banner number',
            { banner: 'A123' },
            'Invalid Banner ID'
        ],
        [
            'a banner without the leading A',
            { banner: '000123456' },
            'Invalid Banner ID'
        ],
        [
            'a banner with too many digits',
            { banner: 'A001234567' },
            'Invalid Banner ID'
        ],
        [
            'an email without a domain',
            { email: 'ana@test' },
            'Invalid email address.'
        ],
        [
            'an email without a user part',
            { email: '@test.com' },
            'Invalid email address.'
        ],
        [
            'an email with spaces',
            { email: 'an a@test.com' },
            'Invalid email address.'
        ],
        [
            'a non-numeric NCR',
            { ncr: '12a4' },
            'Invalid NCR. NCR must contain exactly 4 numbers.'
        ]
    ])(
        'rejects a student with %s',
        async (_, changes, expectedMessage) => {
            routeHttps(https, [
                authTeacher(),
                teacherRole('teacher')
            ]);

            const response = await handler(
                makeRequest({
                    ...VALID_BODY,
                    students: [
                        {
                            ...VALID_BODY.students[0],
                            ...changes
                        }
                    ]
                }),
                makeContext()
            );

            const body = parseBody(response);

            expect(response.status).toBe(200);
            expect(body.errorCount).toBe(1);
            expect(body.errors[0]).toContain(expectedMessage);
        }
    );

    it('successfully reuses an existing student account', async () => {
        routeHttps(https, [
            authTeacher(),
            teacherRole('teacher'),
            existingStudentAccount('S1'),
            studentRole('S1', 'student'),
            ...persistenceRoutes({ playFabId: 'S1' })
        ]);

        const response = await handler(
            makeRequest(VALID_BODY),
            makeContext()
        );

        const body = parseBody(response);

        expect(response.status).toBe(200);
        expect(body.success).toBe(true);
        expect(body.createdCount).toBe(1);
        expect(body.assignedCount).toBe(1);
        expect(body.createdAccountCount).toBe(0);
        expect(body.reusedAccountCount).toBe(1);
        expect(body.errorCount).toBe(0);

        expect(body.students).toEqual([
            {
                playFabId: 'S1',
                displayName: 'Ana Torres',
                email: 'ana@test.com'
            }
        ]);
    });

    it('successfully creates a new student account', async () => {
        routeHttps(https, [
            authTeacher(),
            teacherRole('teacher'),
            missingStudentAccount(),
            registerStudent('S2'),
            studentRole('S2', 'student'),
            ...persistenceRoutes({ playFabId: 'S2' })
        ]);

        const response = await handler(
            makeRequest(VALID_BODY),
            makeContext()
        );

        const body = parseBody(response);

        expect(response.status).toBe(200);
        expect(body.success).toBe(true);
        expect(body.createdCount).toBe(1);
        expect(body.assignedCount).toBe(1);
        expect(body.createdAccountCount).toBe(1);
        expect(body.reusedAccountCount).toBe(0);
        expect(body.errorCount).toBe(0);

        expect(body.students[0]).toEqual({
            playFabId: 'S2',
            displayName: 'Ana Torres',
            email: 'ana@test.com'
        });
    });

    it('rejects an existing account that belongs to a teacher', async () => {
        routeHttps(https, [
            authTeacher(),
            teacherRole('teacher'),
            existingStudentAccount('S1'),
            studentRole('S1', 'teacher')
        ]);

        const response = await handler(
            makeRequest(VALID_BODY),
            makeContext()
        );

        const body = parseBody(response);

        expect(response.status).toBe(200);
        expect(body.createdCount).toBe(0);
        expect(body.errorCount).toBe(1);
        expect(body.students).toHaveLength(0);
        expect(body.errors[0]).toContain(
            'belongs to a teacher account'
        );
    });

    it('removes duplicated emails from the same import', async () => {
        routeHttps(https, [
            authTeacher(),
            teacherRole('teacher'),
            existingStudentAccount('S1'),
            studentRole('S1', 'student'),
            ...persistenceRoutes({ playFabId: 'S1' })
        ]);

        const response = await handler(
            makeRequest({
                ...VALID_BODY,
                students: [
                    VALID_BODY.students[0],
                    {
                        ...VALID_BODY.students[0],
                        email: 'ANA@TEST.COM'
                    }
                ]
            }),
            makeContext()
        );

        const body = parseBody(response);

        expect(response.status).toBe(200);
        expect(body.createdCount).toBe(1);
        expect(body.students).toHaveLength(1);
    });

    it('updates an existing enrollment and an existing index student', async () => {
        routeHttps(https, [
            authTeacher(),
            teacherRole('teacher'),
            existingStudentAccount('S1'),
            studentRole('S1', 'student'),
            ...persistenceRoutes({
                playFabId: 'S1',
                enrollments: [
                    {
                        teacherPlayFabId: 'T1',
                        courseId: 'old-course-id',
                        courseName: 'Old course',
                        courseCode: 'ENG1',
                        ncr: '1234',
                        status: 'ACTIVE'
                    }
                ],
                indexStudents: [
                    {
                        playFabId: 'S1',
                        displayName: 'Old Name',
                        email: 'ANA@TEST.COM',
                        status: 'ACTIVE'
                    }
                ]
            })
        ]);

        const response = await handler(
            makeRequest(VALID_BODY),
            makeContext()
        );

        const body = parseBody(response);

        expect(response.status).toBe(200);
        expect(body.success).toBe(true);
        expect(body.createdCount).toBe(1);
        expect(body.errorCount).toBe(0);
    });

    it('continues when saved enrollment and index JSON are invalid', async () => {
        routeHttps(https, [
            authTeacher(),
            teacherRole('teacher'),
            existingStudentAccount('S1'),
            studentRole('S1', 'student'),
            ...persistenceRoutes({
                playFabId: 'S1',
                invalidEnrollmentsJson: true,
                invalidIndexJson: true
            })
        ]);

        const response = await handler(
            makeRequest(VALID_BODY),
            makeContext()
        );

        const body = parseBody(response);

        expect(response.status).toBe(200);
        expect(body.success).toBe(true);
        expect(body.createdCount).toBe(1);
        expect(body.errorCount).toBe(0);
    });

    it('reuses the account when registration fails because the email exists', async () => {
        // First lookup finds nothing → registration is attempted → it fails
        // with "email exists" → the second lookup then returns the account.
        let lookupCount = 0;

        routeHttps(https, [
            authTeacher(),
            teacherRole('teacher'),
            {
                path: '/Admin/GetUserAccountInfo',
                respond: () => {
                    lookupCount += 1;
                    return lookupCount === 1
                        ? playFabHttpsSuccess({})
                        : playFabHttpsSuccess({ UserInfo: { PlayFabId: 'S1' } });
                }
            },
            {
                path: '/Client/RegisterPlayFabUser',
                respond: () => playFabHttpsFailure('Email address not available', { statusCode: 400 })
            },
            studentRole('S1', 'student'),
            ...persistenceRoutes({ playFabId: 'S1' })
        ]);

        const response = await handler(makeRequest(VALID_BODY), makeContext());
        const body = parseBody(response);

        expect(response.status).toBe(200);
        expect(body.reusedAccountCount).toBe(1);
        expect(body.createdAccountCount).toBe(0);
        expect(body.errorCount).toBe(0);
    });

    it('falls back to the Server lookup when the Admin lookup fails', async () => {
        routeHttps(https, [
            authTeacher(),
            teacherRole('teacher'),
            {
                path: '/Admin/GetUserAccountInfo',
                respond: () => playFabHttpsFailure('Admin API not allowed', { statusCode: 403 })
            },
            {
                path: '/Server/GetUserAccountInfo',
                respond: () => playFabHttpsSuccess({ UserInfo: { PlayFabId: 'S1' } })
            },
            studentRole('S1', 'student'),
            ...persistenceRoutes({ playFabId: 'S1' })
        ]);

        const response = await handler(makeRequest(VALID_BODY), makeContext());
        const body = parseBody(response);

        expect(response.status).toBe(200);
        expect(body.reusedAccountCount).toBe(1);
    });

    it('records an error when an imported email belongs to a teacher account', async () => {
        routeHttps(https, [
            authTeacher(),
            teacherRole('teacher'),
            existingStudentAccount('S1'),
            studentRole('S1', 'teacher'), // the reused account is actually a teacher
            ...persistenceRoutes({ playFabId: 'S1' })
        ]);

        const response = await handler(makeRequest(VALID_BODY), makeContext());
        const body = parseBody(response);

        expect(response.status).toBe(200);
        expect(body.errorCount).toBe(1);
        expect(body.errors[0]).toContain('teacher account');
    });

    it('propagates a non-email registration error as a per-student error', async () => {
        routeHttps(https, [
            authTeacher(),
            teacherRole('teacher'),
            missingStudentAccount(),
            {
                path: '/Client/RegisterPlayFabUser',
                respond: () => playFabHttpsFailure('Password does not meet complexity', { statusCode: 400 })
            }
        ]);

        const response = await handler(makeRequest(VALID_BODY), makeContext());
        const body = parseBody(response);

        expect(response.status).toBe(200);
        expect(body.errorCount).toBe(1);
        expect(body.errors[0]).toContain('complexity');
    });

    it('accepts a lowercase banner by normalising it to uppercase', async () => {
        routeHttps(https, [
            authTeacher(),
            teacherRole('teacher'),
            missingStudentAccount(),
            registerStudent('S1'),
            studentRole('S1', 'student'),
            ...persistenceRoutes({ playFabId: 'S1' })
        ]);

        const response = await handler(
            makeRequest({
                ...VALID_BODY,
                students: [{ ...VALID_BODY.students[0], banner: 'a00123456' }]
            }),
            makeContext()
        );

        const body = parseBody(response);

        expect(response.status).toBe(200);
        expect(body.errorCount).toBe(0);
        expect(body.createdAccountCount).toBe(1);

        // The uppercased banner is what gets stored as the password.
        const registerCall = https.request.mock.calls.find(call =>
            String(call[0].path).includes('/Client/RegisterPlayFabUser')
        );
        expect(registerCall).toBeDefined();
    });

    it('creates an account with a fallback username for very short names', async () => {
        routeHttps(https, [
            authTeacher(),
            teacherRole('teacher'),
            missingStudentAccount(),
            registerStudent('S3'),
            studentRole('S3', 'student'),
            ...persistenceRoutes({ playFabId: 'S3' })
        ]);

        const shortNameStudent = {
            firstName: 'A',
            lastName: 'B',
            email: 'ab@test.com',
            banner: 'A00123456',
            ncr: '1234'
        };

        const response = await handler(
            makeRequest({ ...VALID_BODY, students: [shortNameStudent] }),
            makeContext()
        );

        expect(response.status).toBe(200);
        expect(parseBody(response).createdAccountCount).toBe(1);
    });

    it('keeps rows without an email during de-duplication', async () => {
        routeHttps(https, [authTeacher(), teacherRole('teacher')]);

        // Two rows without an email must both survive de-duplication and then
        // both fail validation (invalid email), proving they were not merged.
        const noEmail = { firstName: 'A', lastName: 'B', email: '', banner: 'A00123456', ncr: '1234' };

        const response = await handler(
            makeRequest({ ...VALID_BODY, students: [noEmail, { ...noEmail }] }),
            makeContext()
        );

        expect(parseBody(response).errorCount).toBe(2);
    });

    it('degrades to context.log when warn/error methods are unavailable', async () => {
        // A context exposing only log() exercises the safeWarn/safeError
        // fallback branches without throwing.
        const logOnlyContext = { log: jest.fn() };

        routeHttps(https, [authTeacher(), teacherRole('teacher')]);

        const response = await handler(
            makeRequest({
                ...VALID_BODY,
                students: [{ ...VALID_BODY.students[0], email: 'not-an-email' }]
            }),
            logOnlyContext
        );

        expect(response.status).toBe(200);
        expect(parseBody(response).errorCount).toBe(1);
        expect(logOnlyContext.log).toHaveBeenCalled();
    });

    it('surfaces a fatal error through context.log when error() is unavailable', async () => {
        const logOnlyContext = { log: jest.fn() };
        delete process.env.PLAYFAB_TITLE_ID;

        const response = await handler(makeRequest(VALID_BODY), logOnlyContext);

        expect(response.status).toBe(500);
        expect(logOnlyContext.log).toHaveBeenCalled();
    });
});