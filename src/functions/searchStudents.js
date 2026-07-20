const { app } = require('@azure/functions');

const {
    normalizeText,
    getRequiredEnv,
    playFabPost,
    authenticateSessionTicketId: authenticateSessionTicket
} = require('../lib/playfabClient');

const STUDENT_INDEX_KEY = 'Hotelia_StudentIndex';
const ROLE_KEY = 'Role';

app.http('searchStudents', {
    methods: ['POST'],
    authLevel: 'anonymous',
    route: 'searchStudents',
    handler: async (request, context) => {
        try {
            const body = await readJsonBody(request);

            const teacherSessionTicket = normalizeText(body.teacherSessionTicket);
            const query = normalizeText(body.query).toLowerCase().slice(0, 100);

            if (!teacherSessionTicket) {
                return searchResponse(400, false, 'Missing teacher session ticket.', []);
            }

            const titleId = getRequiredEnv('PLAYFAB_TITLE_ID');
            const secretKey = getRequiredEnv('PLAYFAB_SECRET_KEY');

            const teacherPlayFabId = await authenticateSessionTicket(
                titleId,
                secretKey,
                teacherSessionTicket
            );

            if (!teacherPlayFabId) {
                return searchResponse(401, false, 'Invalid or expired teacher session.', []);
            }

            const teacherRole = await getPlayerRole(
                titleId,
                secretKey,
                teacherPlayFabId
            );

            if (teacherRole !== 'teacher') {
                return searchResponse(403, false, 'Only teacher accounts can search students.', []);
            }

            const indexData = await getInternalJson(
                titleId,
                secretKey,
                STUDENT_INDEX_KEY,
                { students: [] }
            );

            let students = Array.isArray(indexData.students)
                ? indexData.students
                : [];

            students = students.filter(student => {
                if (!student) {
                    return false;
                }

                const status = normalizeText(student.status || 'ACTIVE').toUpperCase();

                if (status !== 'ACTIVE') {
                    return false;
                }

                if (!query) {
                    return true;
                }

                const email = normalizeText(student.email).toLowerCase();
                const displayName = normalizeText(student.displayName).toLowerCase();

                return email.includes(query) || displayName.includes(query);
            });

            const results = students
                .slice(0, 100)
                .map(student => ({
                    playFabId: normalizeText(student.playFabId),
                    displayName: normalizeText(student.displayName),
                    email: normalizeText(student.email)
                }))
                .filter(student => student.playFabId);

            return searchResponse(
                200,
                true,
                query ? 'Students found.' : 'All students loaded.',
                results
            );
        } catch (error) {
            context.error(error);
            return searchResponse(500, false, 'Internal server error.', []);
        }
    }
});

async function readJsonBody(request) {
    try {
        return await request.json();
    } catch {
        return {};
    }
}

function searchResponse(status, success, message, students) {
    return {
        status,
        jsonBody: {
            success,
            message,
            students
        }
    };
}




async function getPlayerRole(titleId, secretKey, playFabId) {
    const data = await playFabPost(
        titleId,
        'Server/GetUserData',
        {
            PlayFabId: playFabId,
            Keys: [ROLE_KEY]
        },
        secretKey
    );

    return data.Data && data.Data[ROLE_KEY]
        ? data.Data[ROLE_KEY].Value || ''
        : '';
}

async function getInternalJson(titleId, secretKey, key, defaultValue) {
    const data = await playFabPost(
        titleId,
        'Admin/GetTitleInternalData',
        { Keys: [key] },
        secretKey
    );

    if (!data.Data || !data.Data[key]) {
        return defaultValue;
    }

    try {
        return JSON.parse(data.Data[key]);
    } catch {
        return defaultValue;
    }
}

