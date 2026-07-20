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

require('../../src/functions/manageTeacherCourse');

const options = getRegistration(app, 'manageTeacherCourse');
const handler = options.handler;

const ORIGINAL_ENV = process.env;

const TEACHER_ID = 'T1';

const SAVE_BODY = {
    sessionTicket: 'ticket-1',
    action: 'save',
    subjectCode: 'ENG',
    classCode: '1234'
};

// ── Route builders ────────────────────────────────────────────────────

function authTeacher(playFabId = TEACHER_ID) {
    return {
        path: 'Server/AuthenticateSessionTicket',
        respond: () => playFabSuccess({ UserInfo: { PlayFabId: playFabId } })
    };
}

function role(value = 'teacher') {
    return {
        path: 'Server/GetUserData',
        when: body => Array.isArray(body.Keys) && body.Keys.includes('Role'),
        respond: () => playFabSuccess(
            value ? { Data: { Role: { Value: value } } } : { Data: {} }
        )
    };
}

// Server/GetTitleData returns plain strings (no .Value wrapper).
function subjectCatalog(subjects) {
    return {
        path: 'Server/GetTitleData',
        respond: () => playFabSuccess({
            Data: { Hotelia_SubjectCatalog: JSON.stringify({ subjects }) }
        })
    };
}

function activeSubject(overrides = {}) {
    return {
        subjectCode: 'ENG',
        subjectName: 'English I',
        period: 1,
        status: 'ACTIVE',
        ...overrides
    };
}

// Server/GetUserData for the teacher's course list uses a .Value wrapper.
function teacherCourses(courses) {
    return {
        path: 'Server/GetUserData',
        when: body => Array.isArray(body.Keys) && body.Keys.includes('Hotelia_TeacherCourses'),
        respond: () => playFabSuccess({
            Data: courses === null
                ? {}
                : { Hotelia_TeacherCourses: { Value: JSON.stringify({ courses }) } }
        })
    };
}

// Admin/GetTitleInternalData returns plain strings.
function courseRegistry(coursesByNcr) {
    return {
        path: 'Admin/GetTitleInternalData',
        respond: () => playFabSuccess({
            Data: coursesByNcr === null
                ? {}
                : { Hotelia_CourseRegistry: JSON.stringify({ coursesByNcr }) }
        })
    };
}

function saveRegistryOk() {
    return {
        path: 'Admin/SetTitleInternalData',
        respond: () => playFabSuccess({})
    };
}

function saveCoursesOk() {
    return {
        path: 'Server/UpdateUserData',
        respond: () => playFabSuccess({})
    };
}

function existingCourse(overrides = {}) {
    return {
        courseId: 'course_1',
        subjectCode: 'ENG',
        subjectName: 'English I',
        period: 1,
        classCode: '1234',
        courseCode: '1234',
        teacherPlayFabId: TEACHER_ID,
        status: 'ACTIVE',
        ...overrides
    };
}

// Reads the payload written to a given PlayFab endpoint.
function bodySentTo(fragment) {
    const call = global.fetch.mock.calls.find(entry => entry[0].includes(fragment));
    return call ? JSON.parse(call[1].body) : null;
}

function savedRegistry() {
    const body = bodySentTo('Admin/SetTitleInternalData');
    return body ? JSON.parse(body.Value) : null;
}

function savedCourseList() {
    const body = bodySentTo('Server/UpdateUserData');
    return body ? JSON.parse(body.Data.Hotelia_TeacherCourses) : null;
}

describe('manageTeacherCourse', () => {
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

    // ── Registration and guards ───────────────────────────────────────

    it('is registered as an anonymous route accepting GET and POST', () => {
        expect(options).toMatchObject({
            methods: ['GET', 'POST'],
            authLevel: 'anonymous',
            route: 'manageTeacherCourse'
        });
    });

    it('answers the GET health ping', async () => {
        const response = await handler(makeRequest(null, { method: 'GET' }), makeContext());

        expect(response.status).toBe(200);
        expect(response.jsonBody.success).toBe(true);
        expect(response.jsonBody.message).toBe('manageTeacherCourse is alive.');
        expect(global.fetch).not.toHaveBeenCalled();
    });

    it('returns 400 when the session ticket is missing', async () => {
        const response = await handler(
            makeRequest({ action: 'save' }),
            makeContext()
        );

        expect(response.status).toBe(400);
        expect(response.jsonBody.message).toBe('Missing teacher session ticket.');
        expect(global.fetch).not.toHaveBeenCalled();
    });

    it.each(['', 'archive', 'SAVE_ALL'])('returns 400 for the invalid action %p', async action => {
        const response = await handler(
            makeRequest({ sessionTicket: 'ticket-1', action }),
            makeContext()
        );

        expect(response.status).toBe(400);
        expect(response.jsonBody.message).toBe('Invalid course action.');
    });

    it.each(['save', 'DELETE'])('accepts the action %p case-insensitively', async action => {
        routeFetch([
            {
                path: 'Server/AuthenticateSessionTicket',
                respond: () => playFabSuccess({ UserInfo: {} })
            }
        ]);

        const response = await handler(
            makeRequest({ sessionTicket: 'ticket-1', action }),
            makeContext()
        );

        // Gets past the action check and fails later, at session validation.
        expect(response.status).toBe(401);
    });

    it('accepts teacherSessionTicket as an alias for sessionTicket', async () => {
        routeFetch([
            {
                path: 'Server/AuthenticateSessionTicket',
                respond: () => playFabSuccess({ UserInfo: {} })
            }
        ]);

        const response = await handler(
            makeRequest({ teacherSessionTicket: 'ticket-1', action: 'save' }),
            makeContext()
        );

        expect(response.status).toBe(401);
        expect(response.jsonBody.message).toBe('Invalid or expired teacher session.');
    });

    it('returns 500 when a required setting is missing', async () => {
        delete process.env.PLAYFAB_SECRET_KEY;

        const response = await handler(makeRequest(SAVE_BODY), makeContext());

        expect(response.status).toBe(500);
        expect(response.jsonBody.message).toBe('Internal server error.');
    });

    it('returns 401 when PlayFab rejects the session ticket', async () => {
        routeFetch([
            {
                path: 'Server/AuthenticateSessionTicket',
                respond: () => playFabFailure('Invalid session ticket', { status: 401 })
            }
        ]);

        const response = await handler(makeRequest(SAVE_BODY), makeContext());

        expect(response.status).toBe(401);
        expect(response.jsonBody.message).toBe('Invalid or expired teacher session.');
    });

    it('returns 403 for non-teacher accounts', async () => {
        routeFetch([authTeacher(), role('student')]);

        const response = await handler(makeRequest(SAVE_BODY), makeContext());

        expect(response.status).toBe(403);
        expect(response.jsonBody.message).toBe('Only teacher accounts can manage courses.');
    });

    it('returns 403 when the account has no role stored', async () => {
        routeFetch([authTeacher(), role(null)]);

        const response = await handler(makeRequest(SAVE_BODY), makeContext());

        expect(response.status).toBe(403);
    });

    it('tolerates an unreadable JSON body', async () => {
        const response = await handler(makeRequest(new Error('bad json')), makeContext());

        // An empty body means no session ticket.
        expect(response.status).toBe(400);
        expect(response.jsonBody.message).toBe('Missing teacher session ticket.');
    });

    // ── save: input validation ────────────────────────────────────────

    it.each(['123', '12345', 'ABCD', '', '12a4'])(
        'rejects the NCR %p because it is not four digits',
        async classCode => {
            routeFetch([authTeacher(), role('teacher')]);

            const response = await handler(
                makeRequest({ ...SAVE_BODY, classCode }),
                makeContext()
            );

            expect(response.status).toBe(400);
            expect(response.jsonBody.message).toBe('NCR must contain exactly 4 numbers.');
        }
    );

    it('returns 400 when the subject code is missing', async () => {
        routeFetch([authTeacher(), role('teacher')]);

        const response = await handler(
            makeRequest({ ...SAVE_BODY, subjectCode: '' }),
            makeContext()
        );

        expect(response.status).toBe(400);
        expect(response.jsonBody.message).toBe('Select a valid subject.');
    });

    it('returns 500 when the subject catalog is missing', async () => {
        routeFetch([
            authTeacher(),
            role('teacher'),
            { path: 'Server/GetTitleData', respond: () => playFabSuccess({ Data: {} }) }
        ]);

        const response = await handler(makeRequest(SAVE_BODY), makeContext());

        expect(response.status).toBe(500);
        expect(response.jsonBody.message).toBe('Subject catalog was not found.');
    });

    it('returns 500 when the subject catalog holds invalid JSON', async () => {
        routeFetch([
            authTeacher(),
            role('teacher'),
            {
                path: 'Server/GetTitleData',
                respond: () => playFabSuccess({ Data: { Hotelia_SubjectCatalog: '{not-json' } })
            }
        ]);

        const response = await handler(makeRequest(SAVE_BODY), makeContext());

        expect(response.status).toBe(500);
        expect(response.jsonBody.message).toBe('Subject catalog contains invalid JSON.');
    });

    it.each([
        ['an unknown code', [activeSubject({ subjectCode: 'MAT' })]],
        ['an inactive subject', [activeSubject({ status: 'INACTIVE' })]],
        ['an empty catalog', []]
    ])('returns 400 when the subject cannot be resolved: %s', async (_, subjects) => {
        routeFetch([authTeacher(), role('teacher'), subjectCatalog(subjects)]);

        const response = await handler(makeRequest(SAVE_BODY), makeContext());

        expect(response.status).toBe(400);
        expect(response.jsonBody.message).toBe('The selected subject does not exist or is not active.');
    });

    // ── save: creation ────────────────────────────────────────────────

    it('creates a new course and reserves the NCR in the registry', async () => {
        routeFetch([
            authTeacher(),
            role('teacher'),
            subjectCatalog([activeSubject()]),
            teacherCourses([]),
            courseRegistry({}),
            saveRegistryOk(),
            saveCoursesOk()
        ]);

        const response = await handler(makeRequest(SAVE_BODY), makeContext());

        expect(response.status).toBe(200);
        expect(response.jsonBody.success).toBe(true);
        expect(response.jsonBody.message).toBe('Course created successfully.');

        // The subject name/period come from the catalog, never from the client.
        expect(response.jsonBody.course).toMatchObject({
            subjectCode: 'ENG',
            subjectName: 'English I',
            period: 1,
            classCode: '1234',
            courseCode: '1234',
            courseName: 'English I',
            teacherPlayFabId: TEACHER_ID,
            status: 'ACTIVE'
        });
        expect(response.jsonBody.course.courseId).toMatch(/^course_\d+_[0-9a-f]+$/);

        const registry = savedRegistry();
        expect(registry.coursesByNcr['1234']).toMatchObject({
            teacherPlayFabId: TEACHER_ID,
            classCode: '1234',
            status: 'ACTIVE'
        });

        expect(savedCourseList().courses).toHaveLength(1);
    });

    it('treats a missing course list and registry as empty', async () => {
        routeFetch([
            authTeacher(),
            role('teacher'),
            subjectCatalog([activeSubject()]),
            teacherCourses(null),
            courseRegistry(null),
            saveRegistryOk(),
            saveCoursesOk()
        ]);

        const response = await handler(makeRequest(SAVE_BODY), makeContext());

        expect(response.status).toBe(200);
        expect(savedCourseList().courses).toHaveLength(1);
    });

    it('repairs a registry whose coursesByNcr is not an object', async () => {
        routeFetch([
            authTeacher(),
            role('teacher'),
            subjectCatalog([activeSubject()]),
            teacherCourses([]),
            {
                path: 'Admin/GetTitleInternalData',
                respond: () => playFabSuccess({
                    Data: { Hotelia_CourseRegistry: JSON.stringify({ coursesByNcr: ['broken'] }) }
                })
            },
            saveRegistryOk(),
            saveCoursesOk()
        ]);

        const response = await handler(makeRequest(SAVE_BODY), makeContext());

        expect(response.status).toBe(200);
        expect(savedRegistry().coursesByNcr['1234']).toBeDefined();
    });

    it('falls back to an empty course list when the stored JSON is invalid', async () => {
        routeFetch([
            authTeacher(),
            role('teacher'),
            subjectCatalog([activeSubject()]),
            {
                path: 'Server/GetUserData',
                when: body => Array.isArray(body.Keys) && body.Keys.includes('Hotelia_TeacherCourses'),
                respond: () => playFabSuccess({
                    Data: { Hotelia_TeacherCourses: { Value: '{not-json' } }
                })
            },
            courseRegistry({}),
            saveRegistryOk(),
            saveCoursesOk()
        ]);

        const response = await handler(makeRequest(SAVE_BODY), makeContext());

        expect(response.status).toBe(200);
        expect(savedCourseList().courses).toHaveLength(1);
    });

    // ── save: updates and conflicts ───────────────────────────────────

    it('updates an existing course in place', async () => {
        routeFetch([
            authTeacher(),
            role('teacher'),
            subjectCatalog([activeSubject()]),
            teacherCourses([existingCourse()]),
            courseRegistry({
                1234: { courseId: 'course_1', teacherPlayFabId: TEACHER_ID, createdAtUtc: '2026-01-01T00:00:00.000Z' }
            }),
            saveRegistryOk(),
            saveCoursesOk()
        ]);

        const response = await handler(
            makeRequest({ ...SAVE_BODY, courseId: 'course_1' }),
            makeContext()
        );

        expect(response.status).toBe(200);
        expect(response.jsonBody.message).toBe('Course updated successfully.');
        expect(response.jsonBody.course.courseId).toBe('course_1');

        // Updating must not duplicate the entry.
        expect(savedCourseList().courses).toHaveLength(1);
        // The original creation date is preserved.
        expect(savedRegistry().coursesByNcr['1234'].createdAtUtc).toBe('2026-01-01T00:00:00.000Z');
    });

    it('returns 404 when the course to update does not exist', async () => {
        routeFetch([
            authTeacher(),
            role('teacher'),
            subjectCatalog([activeSubject()]),
            teacherCourses([existingCourse({ courseId: 'course_other' })])
        ]);

        const response = await handler(
            makeRequest({ ...SAVE_BODY, courseId: 'course_missing' }),
            makeContext()
        );

        expect(response.status).toBe(404);
        expect(response.jsonBody.message).toBe('Course not found.');
    });

    it('returns 403 when updating a course owned by another teacher', async () => {
        routeFetch([
            authTeacher(),
            role('teacher'),
            subjectCatalog([activeSubject()]),
            teacherCourses([existingCourse({ teacherPlayFabId: 'T-OTHER' })])
        ]);

        const response = await handler(
            makeRequest({ ...SAVE_BODY, courseId: 'course_1' }),
            makeContext()
        );

        expect(response.status).toBe(403);
        expect(response.jsonBody.message).toBe('This course belongs to another teacher.');
    });

    it('returns 409 when the teacher already owns another course with that NCR', async () => {
        routeFetch([
            authTeacher(),
            role('teacher'),
            subjectCatalog([activeSubject()]),
            teacherCourses([existingCourse({ courseId: 'course_9', classCode: '1234' })]),
            courseRegistry({})
        ]);

        const response = await handler(makeRequest(SAVE_BODY), makeContext());

        expect(response.status).toBe(409);
        expect(response.jsonBody.message).toBe('A course with NCR 1234 already exists.');
    });

    it('returns 409 when the NCR is registered to another teacher', async () => {
        routeFetch([
            authTeacher(),
            role('teacher'),
            subjectCatalog([activeSubject()]),
            teacherCourses([]),
            courseRegistry({
                1234: { courseId: 'course_x', teacherPlayFabId: 'T-OTHER' }
            })
        ]);

        const response = await handler(makeRequest(SAVE_BODY), makeContext());

        expect(response.status).toBe(409);
        expect(response.jsonBody.message).toBe(
            'The NCR 1234 already exists and is assigned to another teacher.'
        );
    });

    it('returns 409 when the same teacher registered that NCR under another course', async () => {
        routeFetch([
            authTeacher(),
            role('teacher'),
            subjectCatalog([activeSubject()]),
            teacherCourses([]),
            courseRegistry({
                1234: { courseId: 'course_previous', teacherPlayFabId: TEACHER_ID }
            })
        ]);

        const response = await handler(makeRequest(SAVE_BODY), makeContext());

        expect(response.status).toBe(409);
        expect(response.jsonBody.message).toBe('A course with NCR 1234 already exists.');
    });

    it('frees the previous NCR when a course changes its class code', async () => {
        routeFetch([
            authTeacher(),
            role('teacher'),
            subjectCatalog([activeSubject()]),
            teacherCourses([existingCourse({ classCode: '1111', courseCode: '1111' })]),
            courseRegistry({
                1111: { courseId: 'course_1', teacherPlayFabId: TEACHER_ID }
            }),
            saveRegistryOk(),
            saveCoursesOk()
        ]);

        const response = await handler(
            makeRequest({ ...SAVE_BODY, courseId: 'course_1', classCode: '2222' }),
            makeContext()
        );

        expect(response.status).toBe(200);

        const registry = savedRegistry();
        expect(registry.coursesByNcr['1111']).toBeUndefined();
        expect(registry.coursesByNcr['2222']).toMatchObject({ courseId: 'course_1' });
    });

    it('keeps the previous NCR reserved when it belongs to a different course', async () => {
        routeFetch([
            authTeacher(),
            role('teacher'),
            subjectCatalog([activeSubject()]),
            teacherCourses([existingCourse({ classCode: '1111', courseCode: '1111' })]),
            courseRegistry({
                1111: { courseId: 'course_someone_else', teacherPlayFabId: 'T-OTHER' }
            }),
            saveRegistryOk(),
            saveCoursesOk()
        ]);

        const response = await handler(
            makeRequest({ ...SAVE_BODY, courseId: 'course_1', classCode: '2222' }),
            makeContext()
        );

        expect(response.status).toBe(200);
        expect(savedRegistry().coursesByNcr['1111']).toBeDefined();
    });

    it('rolls the registry back when saving the course list fails', async () => {
        const originalRegistry = {
            9999: { courseId: 'course_untouched', teacherPlayFabId: TEACHER_ID }
        };

        routeFetch([
            authTeacher(),
            role('teacher'),
            subjectCatalog([activeSubject()]),
            teacherCourses([]),
            courseRegistry(originalRegistry),
            saveRegistryOk(),
            {
                path: 'Server/UpdateUserData',
                respond: () => playFabFailure('Server API unavailable', { status: 503 })
            }
        ]);

        const context = makeContext();
        const response = await handler(makeRequest(SAVE_BODY), context);

        expect(response.status).toBe(500);
        expect(context.error).toHaveBeenCalled();

        // Two registry writes: the reservation and the rollback.
        const registryWrites = global.fetch.mock.calls.filter(call =>
            call[0].includes('Admin/SetTitleInternalData')
        );
        expect(registryWrites).toHaveLength(2);

        const rolledBack = JSON.parse(JSON.parse(registryWrites[1][1].body).Value);
        expect(rolledBack.coursesByNcr['1234']).toBeUndefined();
        expect(rolledBack.coursesByNcr['9999']).toBeDefined();
    });

    it('reports the original failure when the rollback also fails', async () => {
        routeFetch([
            authTeacher(),
            role('teacher'),
            subjectCatalog([activeSubject()]),
            teacherCourses([]),
            courseRegistry({}),
            {
                path: 'Admin/SetTitleInternalData',
                respond: () => playFabFailure('Registry write failed', { status: 500 })
            }
        ]);

        const response = await handler(makeRequest(SAVE_BODY), makeContext());

        expect(response.status).toBe(500);
        expect(response.jsonBody.success).toBe(false);
    });

    // ── delete ────────────────────────────────────────────────────────

    it('returns 400 when deleting without a course id', async () => {
        routeFetch([authTeacher(), role('teacher')]);

        const response = await handler(
            makeRequest({ sessionTicket: 'ticket-1', action: 'delete' }),
            makeContext()
        );

        expect(response.status).toBe(400);
        expect(response.jsonBody.message).toBe('Missing course ID.');
    });

    it('returns 404 when the course to delete does not exist', async () => {
        routeFetch([
            authTeacher(),
            role('teacher'),
            teacherCourses([existingCourse({ courseId: 'course_other' })])
        ]);

        const response = await handler(
            makeRequest({ sessionTicket: 'ticket-1', action: 'delete', courseId: 'course_1' }),
            makeContext()
        );

        expect(response.status).toBe(404);
        expect(response.jsonBody.message).toBe('Course not found.');
    });

    it('returns 403 when deleting a course owned by another teacher', async () => {
        routeFetch([
            authTeacher(),
            role('teacher'),
            teacherCourses([existingCourse({ teacherPlayFabId: 'T-OTHER' })])
        ]);

        const response = await handler(
            makeRequest({ sessionTicket: 'ticket-1', action: 'delete', courseId: 'course_1' }),
            makeContext()
        );

        expect(response.status).toBe(403);
        expect(response.jsonBody.message).toBe('This course belongs to another teacher.');
    });

    it('deletes the course and releases its NCR', async () => {
        routeFetch([
            authTeacher(),
            role('teacher'),
            teacherCourses([existingCourse(), existingCourse({ courseId: 'course_2', classCode: '5678' })]),
            courseRegistry({
                1234: { courseId: 'course_1', teacherPlayFabId: TEACHER_ID },
                5678: { courseId: 'course_2', teacherPlayFabId: TEACHER_ID }
            }),
            saveRegistryOk(),
            saveCoursesOk()
        ]);

        const response = await handler(
            makeRequest({ sessionTicket: 'ticket-1', action: 'delete', courseId: 'course_1' }),
            makeContext()
        );

        expect(response.status).toBe(200);
        expect(response.jsonBody.message).toBe('Course deleted successfully.');

        const registry = savedRegistry();
        expect(registry.coursesByNcr['1234']).toBeUndefined();
        expect(registry.coursesByNcr['5678']).toBeDefined();

        const courses = savedCourseList().courses;
        expect(courses).toHaveLength(1);
        expect(courses[0].courseId).toBe('course_2');
    });

    it('keeps an NCR reserved by another teacher when deleting', async () => {
        routeFetch([
            authTeacher(),
            role('teacher'),
            teacherCourses([existingCourse()]),
            courseRegistry({
                1234: { courseId: 'course_1', teacherPlayFabId: 'T-OTHER' }
            }),
            saveRegistryOk(),
            saveCoursesOk()
        ]);

        const response = await handler(
            makeRequest({ sessionTicket: 'ticket-1', action: 'delete', courseId: 'course_1' }),
            makeContext()
        );

        expect(response.status).toBe(200);
        expect(savedRegistry().coursesByNcr['1234']).toBeDefined();
    });

    it('rolls the registry back when the delete cannot be persisted', async () => {
        routeFetch([
            authTeacher(),
            role('teacher'),
            teacherCourses([existingCourse()]),
            courseRegistry({
                1234: { courseId: 'course_1', teacherPlayFabId: TEACHER_ID }
            }),
            saveRegistryOk(),
            {
                path: 'Server/UpdateUserData',
                respond: () => playFabFailure('Server API unavailable', { status: 503 })
            }
        ]);

        const context = makeContext();
        const response = await handler(
            makeRequest({ sessionTicket: 'ticket-1', action: 'delete', courseId: 'course_1' }),
            context
        );

        expect(response.status).toBe(500);
        expect(context.error).toHaveBeenCalled();

        const registryWrites = global.fetch.mock.calls.filter(call =>
            call[0].includes('Admin/SetTitleInternalData')
        );
        expect(registryWrites).toHaveLength(2);

        const rolledBack = JSON.parse(JSON.parse(registryWrites[1][1].body).Value);
        expect(rolledBack.coursesByNcr['1234']).toBeDefined();
    });

    it('deletes a course identified only by its legacy courseCode field', async () => {
        routeFetch([
            authTeacher(),
            role('teacher'),
            teacherCourses([{ courseId: 'course_1', courseCode: '4321', teacherPlayFabId: TEACHER_ID }]),
            courseRegistry({
                4321: { courseId: 'course_1', teacherPlayFabId: TEACHER_ID }
            }),
            saveRegistryOk(),
            saveCoursesOk()
        ]);

        const response = await handler(
            makeRequest({ sessionTicket: 'ticket-1', action: 'delete', courseId: 'course_1' }),
            makeContext()
        );

        expect(response.status).toBe(200);
        expect(savedRegistry().coursesByNcr['4321']).toBeUndefined();
    });

    it('rejects an invalid PlayFab response payload', async () => {
        routeFetch([
            {
                path: 'Server/AuthenticateSessionTicket',
                respond: () => ({
                    ok: true,
                    status: 200,
                    text: async () => '<html>not json</html>'
                })
            }
        ]);

        const response = await handler(makeRequest(SAVE_BODY), makeContext());

        // authenticateSessionTicket swallows the parse failure and reports it
        // as an invalid session.
        expect(response.status).toBe(401);
    });
});
