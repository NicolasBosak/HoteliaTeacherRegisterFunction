const { app } = require('@azure/functions');

const {
    normalizeText,
    getRequiredEnv,
    playFabPost,
    safeParseJson,
    authenticateSessionTicketId: authenticateSessionTicket
} = require('../lib/playfabClient');

const GAME_STATE_KEY = 'Hotelia_GameState';
const DAILY_RESULTS_KEY = 'Hotelia_DailyResults';
const ROLE_KEY = 'Role';
const TEACHER_STUDENTS_KEY = 'Hotelia_TeacherStudents';

app.http('getStudentPerformance', {
    methods: ['POST'],
    authLevel: 'anonymous',
    route: 'getStudentPerformance',
    handler: async (request, context) => {
        try {
            const body = await readJsonBody(request);

            const teacherSessionTicket = normalizeText(body.teacherSessionTicket);
            const studentPlayFabId = normalizeText(body.studentPlayFabId);

            if (!teacherSessionTicket) {
                return performanceResponse(400, false, 'Missing teacher session ticket.');
            }

            if (!studentPlayFabId) {
                return performanceResponse(400, false, 'Missing student PlayFabId.');
            }

            const titleId = getRequiredEnv('PLAYFAB_TITLE_ID');
            const secretKey = getRequiredEnv('PLAYFAB_SECRET_KEY');

            const teacherPlayFabId = await authenticateSessionTicket(
                titleId,
                secretKey,
                teacherSessionTicket
            );

            if (!teacherPlayFabId) {
                return performanceResponse(401, false, 'Invalid or expired teacher session.');
            }

            const teacherRole = await getPlayerRole(
                titleId,
                secretKey,
                teacherPlayFabId
            );

            if (teacherRole !== 'teacher') {
                return performanceResponse(403, false, 'Only teacher accounts can view student performance.');
            }

            const teacherData = await getUserData(
                titleId,
                secretKey,
                teacherPlayFabId,
                [TEACHER_STUDENTS_KEY]
            );

            const assignmentsRaw = getUserDataValue(
                teacherData,
                TEACHER_STUDENTS_KEY
            );

            const assignments = safeParseJson(assignmentsRaw, { students: [] });

            if (!isStudentAssignedToTeacher(assignments, studentPlayFabId)) {
                return performanceResponse(403, false, 'This student is not assigned to the current teacher.');
            }

            const studentData = await getUserData(
                titleId,
                secretKey,
                studentPlayFabId,
                [GAME_STATE_KEY, DAILY_RESULTS_KEY]
            );

            const gameState = safeParseJson(
                getUserDataValue(studentData, GAME_STATE_KEY),
                {
                    hasStartedGame: false,
                    currentDay: 0
                }
            );

            const dailyResults = safeParseJson(
                getUserDataValue(studentData, DAILY_RESULTS_KEY),
                { results: [] }
            );

            return {
                status: 200,
                jsonBody: {
                    success: true,
                    message: 'Student performance loaded.',
                    hasStartedGame: gameState.hasStartedGame === true,
                    currentDay: Number.isFinite(Number(gameState.currentDay))
                        ? Number(gameState.currentDay)
                        : 0,
                    results: Array.isArray(dailyResults.results)
                        ? dailyResults.results
                        : []
                }
            };
        } catch (error) {
            context.error(error);
            return performanceResponse(500, false, 'Internal server error.');
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

function performanceResponse(status, success, message) {
    return {
        status,
        jsonBody: {
            success,
            message,
            hasStartedGame: false,
            currentDay: 0,
            results: []
        }
    };
}




function getUserDataValue(data, key) {
    if (!data || !data[key]) {
        return '';
    }

    return data[key].Value || '';
}

function isStudentAssignedToTeacher(assignments, studentPlayFabId) {
    if (!assignments) {
        return false;
    }

    const students = Array.isArray(assignments.students)
        ? assignments.students
        : Array.isArray(assignments.assignedStudents)
            ? assignments.assignedStudents
            : [];

    const targetId = studentPlayFabId.toLowerCase();

    return students.some(student => {
        if (!student) {
            return false;
        }

        const status = normalizeText(student.status || 'ACTIVE').toUpperCase();

        if (status !== 'ACTIVE') {
            return false;
        }

        const savedId = normalizeText(
            student.playFabId ||
            student.studentPlayFabId ||
            student.studentId
        ).toLowerCase();

        return savedId === targetId;
    });
}


async function getPlayerRole(titleId, secretKey, playFabId) {
    const data = await getUserData(
        titleId,
        secretKey,
        playFabId,
        [ROLE_KEY]
    );

    return getUserDataValue(data, ROLE_KEY);
}

async function getUserData(titleId, secretKey, playFabId, keys) {
    const data = await playFabPost(
        titleId,
        'Server/GetUserData',
        {
            PlayFabId: playFabId,
            Keys: keys
        },
        secretKey
    );

    return data && data.Data ? data.Data : {};
}

