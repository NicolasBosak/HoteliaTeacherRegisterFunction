const { app } = require('@azure/functions');
const https = require('https');
const { randomBytes } = require('node:crypto');

const STUDENT_ROLE = 'student';
const DEFAULT_ROLE_KEY = 'Role';
const STUDENT_ENROLLMENTS_KEY = 'Hotelia_StudentEnrollments';
const StudentIndexKey = 'Hotelia_StudentIndex';

app.http('bulkCreateStudents', {
    methods: ['GET', 'POST'],
    authLevel: 'anonymous',
    route: 'bulkCreateStudents',
    handler: async (request, context) => {
        if (request.method === 'GET') {
            return jsonResponse(200, {
                success: true,
                message: 'bulkCreateStudents is alive',
                timeUtc: new Date().toISOString()
            });
        }

        try {
            const body = await readJsonBody(request);

            const teacherSessionTicket = (body.teacherSessionTicket || '').trim();
            const courseId = (body.courseId || '').trim();
            const courseName = (body.courseName || '').trim();
            const courseCode = (body.courseCode || '').trim();
            const students = Array.isArray(body.students) ? body.students : [];

            safeLog(context, 'bulkCreateStudents request received. Course: ' + courseCode + '. Students: ' + students.length);

            if (!teacherSessionTicket) {
                return errorResponse(400, 'Missing teacher session ticket.');
            }

            if (!courseId || !courseName || !courseCode) {
                return errorResponse(400, 'Missing course data.');
            }

            if (students.length === 0) {
                return errorResponse(400, 'No students were received.');
            }

            const titleId = getRequiredEnv('PLAYFAB_TITLE_ID');
            const secretKey = getRequiredEnv('PLAYFAB_SECRET_KEY');

            const teacherInfo = await validateTeacherSession(
                titleId,
                secretKey,
                teacherSessionTicket
            );

            if (!teacherInfo || !teacherInfo.playFabId) {
                return errorResponse(401, 'Invalid teacher session.');
            }

            const isTeacher = await validateTeacherRole(
                titleId,
                secretKey,
                teacherInfo.playFabId
            );

            if (!isTeacher) {
                return errorResponse(
                    403,
                    'Only teacher accounts can import students.'
                );
            }

            const uniqueStudents = removeDuplicatedEmails(students);
            const importedStudents = [];
            const errors = [];

            let createdAccountCount = 0;
            let reusedAccountCount = 0;

            for (const row of uniqueStudents) {
                try {
                    const student = normalizeStudentRow(row);

                    validateStudentRow(student);

                    const accountResult = await createOrGetStudentAccount(
                        titleId,
                        secretKey,
                        student,
                        context
                    );

                    const existingRole = await getPlayerRole(
                        titleId,
                        secretKey,
                        accountResult.playFabId
                    );

                    if (existingRole === 'teacher') {
                        throw new Error(
                            'This email belongs to a teacher account and cannot be imported as a student.'
                        );
                    }

                    if (accountResult.wasCreated) {
                        createdAccountCount++;
                    } else {
                        reusedAccountCount++;
                    }

                    await updateStudentDisplayNameSafe(
                        titleId,
                        secretKey,
                        accountResult.playFabId,
                        student.displayName,
                        context
                    );

                    await saveStudentDataAndEnrollment(
                        titleId,
                        secretKey,
                        accountResult.playFabId,
                        student,
                        {
                            teacherPlayFabId: teacherInfo.playFabId,
                            courseId,
                            courseName,
                            courseCode
                        }
                    );

                    await upsertStudentInIndex(
                        titleId,
                        secretKey,
                        {
                            playFabId: accountResult.playFabId,
                            displayName: student.displayName,
                            email: student.email,
                            firstName: student.firstName,
                            lastName: student.lastName,
                            ncr: student.ncr,
                            status: 'ACTIVE'
                        }
                    );

                    importedStudents.push({
                        playFabId: accountResult.playFabId,
                        displayName: student.displayName,
                        email: student.email
                    });
                } catch (studentError) {
                    const email = row && row.email ? row.email : 'unknown email';
                    const message = studentError && studentError.message ? studentError.message : 'Unknown error';

                    errors.push(email + ': ' + message);
                    safeWarn(context, 'Bulk import student error: ' + email + ' - ' + message);
                }
            }

            return jsonResponse(200, {
                success: true,
                message: 'Bulk import finished.',
                createdCount: importedStudents.length,
                assignedCount: importedStudents.length,
                createdAccountCount,
                reusedAccountCount,
                errorCount: errors.length,
                students: importedStudents,
                errors
            });
        } catch (error) {
            const message = error && error.message ? error.message : 'Internal server error.';

            safeError(context, 'bulkCreateStudents failed: ' + message);

            return jsonResponse(500, {
                success: false,
                message,
                createdCount: 0,
                assignedCount: 0,
                createdAccountCount: 0,
                reusedAccountCount: 0,
                errorCount: 1,
                students: [],
                errors: [message]
            });
        }
    }
});

async function readJsonBody(request) {
    try {
        return await request.json();
    } catch (error) {
        throw new Error('Invalid JSON body.');
    }
}

function jsonResponse(status, payload) {
    return {
        status,
        headers: {
            'Content-Type': 'application/json'
        },
        body: JSON.stringify(payload)
    };
}

function errorResponse(status, message) {
    return jsonResponse(status, {
        success: false,
        message,
        createdCount: 0,
        assignedCount: 0,
        createdAccountCount: 0,
        reusedAccountCount: 0,
        errorCount: 1,
        students: [],
        errors: [message]
    });
}

function safeLog(context, message) {
    try {
        if (context && typeof context.log === 'function') {
            context.log(message);
        }
    } catch (_) { }
}

function safeWarn(context, message) {
    try {
        if (context && typeof context.warn === 'function') {
            context.warn(message);
            return;
        }

        if (context && typeof context.log === 'function') {
            context.log('WARNING: ' + message);
        }
    } catch (_) { }
}

function safeError(context, message) {
    try {
        if (context && typeof context.error === 'function') {
            context.error(message);
            return;
        }

        if (context && typeof context.log === 'function') {
            context.log('ERROR: ' + message);
        }
    } catch (_) { }
}

function getRequiredEnv(name) {
    const value = (process.env[name] || '').trim();

    if (!value) {
        throw new Error('Missing environment variable: ' + name);
    }

    return value;
}

function normalizeStudentRow(row) {
    row = row || {};

    const firstName = (row.firstName || '').trim();
    const lastName = (row.lastName || '').trim();
    const email = (row.email || '').trim().toLowerCase();
    const banner = (row.banner || '').trim().toUpperCase();
    const ncr = (row.ncr || '').trim();

    return {
        firstName,
        lastName,
        email,
        banner,
        ncr,
        displayName: (firstName + ' ' + lastName).trim()
    };
}

function validateStudentRow(student) {
    if (!student.firstName) {
        throw new Error('Missing first name.');
    }

    if (!student.lastName) {
        throw new Error('Missing last name.');
    }

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

    if (!student.email || !emailRegex.test(student.email)) {
        throw new Error('Invalid email address.');
    }

    if (!student.banner || !/^A\d{8}$/.test(student.banner)) {
        throw new Error(
            'Invalid Banner ID. It must contain the letter A followed by exactly 8 numbers. Example: A00123456.'
        );
    }

    if (!student.ncr || !/^\d{4}$/.test(student.ncr)) {
        throw new Error(
            'Invalid NCR. NCR must contain exactly 4 numbers.'
        );
    }
}

function removeDuplicatedEmails(students) {
    const seen = new Set();
    const unique = [];

    for (const row of students) {
        const email = row && row.email ? row.email.trim().toLowerCase() : '';

        if (!email) {
            unique.push(row);
            continue;
        }

        if (seen.has(email)) {
            continue;
        }

        seen.add(email);
        unique.push(row);
    }

    return unique;
}

async function validateTeacherSession(titleId, secretKey, teacherSessionTicket) {
    const data = await playFabPost(
        titleId,
        '/Server/AuthenticateSessionTicket',
        {
            SessionTicket: teacherSessionTicket
        },
        {
            'X-SecretKey': secretKey
        }
    );

    return {
        playFabId: data.UserInfo && data.UserInfo.PlayFabId
            ? data.UserInfo.PlayFabId
            : ''
    };
}

async function validateTeacherRole(titleId, secretKey, teacherPlayFabId) {
    const roleKey = process.env.PLAYFAB_ROLE_KEY || DEFAULT_ROLE_KEY;
    const teacherRoleValue = process.env.PLAYFAB_TEACHER_ROLE_VALUE || 'teacher';

    const data = await playFabPost(
        titleId,
        '/Server/GetUserData',
        {
            PlayFabId: teacherPlayFabId,
            Keys: [
                roleKey,
                'Role',
                'UserRole',
                'Hotelia_Role',
                'Hotelia_UserRole'
            ]
        },
        {
            'X-SecretKey': secretKey
        }
    );

    const userData = data.Data || {};

    const possibleRole =
        getUserDataValue(userData, roleKey) ||
        getUserDataValue(userData, 'Role') ||
        getUserDataValue(userData, 'UserRole') ||
        getUserDataValue(userData, 'Hotelia_Role') ||
        getUserDataValue(userData, 'Hotelia_UserRole');

    return possibleRole === teacherRoleValue;
}

function getUserDataValue(userData, key) {
    if (!userData || !userData[key]) {
        return '';
    }

    return userData[key].Value || '';
}

async function getPlayerRole(titleId, secretKey, playFabId) {
    const data = await playFabPost(
        titleId,
        '/Server/GetUserData',
        {
            PlayFabId: playFabId,
            Keys: ['Role']
        },
        {
            'X-SecretKey': secretKey
        }
    );

    return data.Data &&
        data.Data.Role &&
        data.Data.Role.Value
        ? data.Data.Role.Value
        : '';
}

async function createOrGetStudentAccount(titleId, secretKey, student, context) {
    const existing = await getStudentByEmailSafe(titleId, secretKey, student.email);

    if (existing && existing.PlayFabId) {
        safeLog(context, 'Existing student reused: ' + student.email);

        return {
            playFabId: existing.PlayFabId,
            wasCreated: false
        };
    }

    const username = buildUsername(student);

    try {
        const data = await playFabPost(
            titleId,
            '/Client/RegisterPlayFabUser',
            {
                TitleId: titleId,
                Username: username,
                Email: student.email,
                Password: student.banner,
                RequireBothUsernameAndEmail: false
            },
            {}
        );

        return {
            playFabId: data.PlayFabId,
            wasCreated: true
        };
    } catch (error) {
        if (!isEmailAlreadyExistsError(error)) {
            throw error;
        }

        safeWarn(context, 'Email already exists. Trying to reuse account: ' + student.email);

        const existingAfterRegisterFail = await getStudentByEmailSafe(
            titleId,
            secretKey,
            student.email
        );

        if (existingAfterRegisterFail && existingAfterRegisterFail.PlayFabId) {
            return {
                playFabId: existingAfterRegisterFail.PlayFabId,
                wasCreated: false
            };
        }

        throw new Error('Email already exists, but the existing PlayFab account could not be found by email.');
    }
}

async function getStudentByEmailSafe(titleId, secretKey, email) {
    const cleanEmail = (email || '').trim().toLowerCase();

    if (!cleanEmail) {
        return null;
    }

    try {
        const data = await playFabPost(
            titleId,
            '/Admin/GetUserAccountInfo',
            {
                Email: cleanEmail
            },
            {
                'X-SecretKey': secretKey
            }
        );

        return data.UserInfo || null;
    } catch (adminError) {
        try {
            const data = await playFabPost(
                titleId,
                '/Server/GetUserAccountInfo',
                {
                    Email: cleanEmail
                },
                {
                    'X-SecretKey': secretKey
                }
            );

            return data.UserInfo || null;
        } catch (serverError) {
            return null;
        }
    }
}

function isEmailAlreadyExistsError(error) {
    if (!error) {
        return false;
    }

    const message = (error.message || '').toLowerCase();

    if (message.includes('email address already exists')) {
        return true;
    }

    if (message.includes('email address not available')) {
        return true;
    }

    if (error.playFabError) {
        const errorMessage = (error.playFabError.errorMessage || '').toLowerCase();

        if (errorMessage.includes('email address already exists')) {
            return true;
        }

        if (errorMessage.includes('email address not available')) {
            return true;
        }

        if (error.playFabError.errorDetails) {
            const details = JSON.stringify(error.playFabError.errorDetails).toLowerCase();

            if (details.includes('email address already exists')) {
                return true;
            }

            if (details.includes('email address not available')) {
                return true;
            }
        }
    }

    return false;
}

function buildUsername(student) {
    const base = (student.firstName + student.lastName)
        .toLowerCase()
        .replace(/[^a-z0-9]/g, '');

    const prefix = base.length >= 3
        ? base.substring(0, 8)
        : 'student';

    const secureSuffix = randomBytes(6).toString('hex');

    return (prefix + secureSuffix).substring(0, 20);
}

async function updateStudentDisplayNameSafe(titleId, secretKey, playFabId, displayName, context) {
    if (!displayName) {
        return;
    }

    try {
        await playFabPost(
            titleId,
            '/Admin/UpdateUserTitleDisplayName',
            {
                PlayFabId: playFabId,
                DisplayName: displayName
            },
            {
                'X-SecretKey': secretKey
            }
        );
    } catch (error) {
        const message = error && error.message ? error.message : 'DisplayName update failed.';
        safeWarn(context, 'DisplayName was not updated, but import will continue. ' + message);
    }
}

async function saveStudentDataAndEnrollment(titleId, secretKey, playFabId, student, courseData) {
    const roleKey = process.env.PLAYFAB_ROLE_KEY || DEFAULT_ROLE_KEY;

    const existingEnrollments = await loadStudentEnrollments(
        titleId,
        secretKey,
        playFabId
    );

    const updatedEnrollments = upsertEnrollment(existingEnrollments, {
        teacherPlayFabId: courseData.teacherPlayFabId || '',
        courseId: courseData.courseId || '',
        courseName: courseData.courseName || '',
        courseCode: courseData.courseCode || '',
        ncr: student.ncr || '',
        status: 'ACTIVE',
        updatedAtUtc: new Date().toISOString()
    });

    const enrollmentJson = JSON.stringify({
        enrollments: updatedEnrollments
    });

    const profileData = sanitizePlayFabUserData({
        [roleKey]: STUDENT_ROLE,
        FirstName: student.firstName,
        LastName: student.lastName,
        Email: student.email,
        LastBulkImportUtc: new Date().toISOString()
    });

    const courseEnrollmentData = sanitizePlayFabUserData({
        LastTeacherPlayFabId: courseData.teacherPlayFabId,
        LastCourseId: courseData.courseId,
        LastCourseName: courseData.courseName,
        LastCourseCode: courseData.courseCode,
        LastNCR: student.ncr,
        [STUDENT_ENROLLMENTS_KEY]: enrollmentJson
    });

    await updatePlayFabUserDataInChunks(
        titleId,
        secretKey,
        playFabId,
        profileData
    );

    await updatePlayFabUserDataInChunks(
        titleId,
        secretKey,
        playFabId,
        courseEnrollmentData
    );
}

function sanitizePlayFabUserData(data) {
    const cleaned = {};

    if (!data) {
        return cleaned;
    }

    for (const key of Object.keys(data)) {
        if (!key) {
            continue;
        }

        const cleanKey = key.trim();

        if (!cleanKey) {
            continue;
        }

        if (cleanKey.startsWith('!')) {
            continue;
        }

        const value = data[key];

        if (value === null || value === undefined) {
            continue;
        }

        cleaned[cleanKey] = String(value);
    }

    return cleaned;
}

async function updatePlayFabUserDataInChunks(titleId, secretKey, playFabId, data) {
    if (!data) {
        return;
    }

    const entries = Object.entries(data);

    if (entries.length === 0) {
        return;
    }

    const maxKeysPerRequest = 10;

    for (let i = 0; i < entries.length; i += maxKeysPerRequest) {
        const chunkEntries = entries.slice(i, i + maxKeysPerRequest);
        const chunkData = {};

        for (const [key, value] of chunkEntries) {
            chunkData[key] = value;
        }

        await playFabPost(
            titleId,
            '/Server/UpdateUserData',
            {
                PlayFabId: playFabId,
                Data: chunkData
            },
            {
                'X-SecretKey': secretKey
            }
        );
    }
}

async function loadStudentEnrollments(titleId, secretKey, playFabId) {
    try {
        const data = await playFabPost(
            titleId,
            '/Server/GetUserData',
            {
                PlayFabId: playFabId,
                Keys: [STUDENT_ENROLLMENTS_KEY]
            },
            {
                'X-SecretKey': secretKey
            }
        );

        const raw =
            data.Data &&
                data.Data[STUDENT_ENROLLMENTS_KEY] &&
                data.Data[STUDENT_ENROLLMENTS_KEY].Value
                ? data.Data[STUDENT_ENROLLMENTS_KEY].Value
                : '';

        if (!raw) {
            return [];
        }

        const parsed = JSON.parse(raw);

        if (!parsed || !Array.isArray(parsed.enrollments)) {
            return [];
        }

        return parsed.enrollments;
    } catch (error) {
        return [];
    }
}

function upsertEnrollment(enrollments, newEnrollment) {
    const result = Array.isArray(enrollments) ? enrollments : [];

    for (let i = 0; i < result.length; i++) {
        const current = result[i] || {};

        const sameTeacher = current.teacherPlayFabId === newEnrollment.teacherPlayFabId;
        const sameCourseCode = current.courseCode === newEnrollment.courseCode;

        if (sameTeacher && sameCourseCode) {
            result[i] = {
                ...current,
                ...newEnrollment
            };

            return result;
        }
    }

    result.push(newEnrollment);
    return result;
}

async function upsertStudentInIndex(titleId, secretKey, student) {
    const indexData = await getInternalJson(
        titleId,
        secretKey,
        StudentIndexKey,
        { students: [] }
    );

    const students = Array.isArray(indexData.students)
        ? indexData.students
        : [];

    const normalizedEmail = (student.email || '').toLowerCase();

    let found = false;

    for (let i = 0; i < students.length; i++) {
        const currentEmail = (students[i].email || '').toLowerCase();

        if (students[i].playFabId === student.playFabId || currentEmail === normalizedEmail) {
            students[i] = {
                ...students[i],
                ...student,
                email: normalizedEmail,
                status: 'ACTIVE',
                updatedAtUtc: new Date().toISOString()
            };

            found = true;
            break;
        }
    }

    if (!found) {
        students.push({
            ...student,
            email: normalizedEmail,
            status: 'ACTIVE',
            createdAtUtc: new Date().toISOString(),
            updatedAtUtc: new Date().toISOString()
        });
    }

    await setInternalJson(
        titleId,
        secretKey,
        StudentIndexKey,
        { students }
    );
}

async function getInternalJson(titleId, secretKey, key, defaultValue) {
    try {
        const data = await playFabPost(
            titleId,
            '/Admin/GetTitleInternalData',
            {
                Keys: [key]
            },
            {
                'X-SecretKey': secretKey
            }
        );

        if (!data.Data || !data.Data[key]) {
            return defaultValue;
        }

        return JSON.parse(data.Data[key]);
    } catch (error) {
        return defaultValue;
    }
}

async function setInternalJson(titleId, secretKey, key, value) {
    await playFabPost(
        titleId,
        '/Admin/SetTitleInternalData',
        {
            Key: key,
            Value: JSON.stringify(value)
        },
        {
            'X-SecretKey': secretKey
        }
    );
}

async function playFabPost(titleId, path, body, headers) {
    const response = await httpsPostJson(
        `${titleId}.playfabapi.com`,
        path,
        body || {},
        {
            'Content-Type': 'application/json',
            ...headers
        }
    );

    const json = response.json;

    if (!response.ok || !json || json.code !== 200) {
        let message =
            json && json.errorMessage
                ? json.errorMessage
                : 'HTTP status: ' + response.statusCode;

        if (json && json.errorDetails) {
            message += ' Details: ' + JSON.stringify(json.errorDetails);
        }

        const error = new Error('PlayFab ' + path + ': ' + message);

        error.playFabError = json;
        error.statusCode = response.statusCode;
        error.rawResponse = response.raw;

        throw error;
    }

    return json.data || {};
}

function httpsPostJson(hostname, path, body, headers) {
    return new Promise((resolve, reject) => {
        const jsonBody = JSON.stringify(body || {});

        const options = {
            hostname,
            path,
            method: 'POST',
            headers: {
                ...headers,
                'Content-Length': Buffer.byteLength(jsonBody)
            }
        };

        const req = https.request(options, res => {
            let raw = '';

            res.on('data', chunk => {
                raw += chunk;
            });

            res.on('end', () => {
                let json = null;

                try {
                    json = raw ? JSON.parse(raw) : null;
                } catch (error) {
                    json = null;
                }

                resolve({
                    statusCode: res.statusCode,
                    ok: res.statusCode >= 200 && res.statusCode < 300,
                    raw,
                    json
                });
            });
        });

        req.on('error', error => {
            reject(error);
        });

        req.write(jsonBody);
        req.end();
    });
}