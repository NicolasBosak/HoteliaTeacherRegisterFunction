const { app } = require('@azure/functions');

const GameStateKey = 'Hotelia_GameState';
const DailyResultsKey = 'Hotelia_DailyResults';

app.http('getStudentPerformance', {
    methods: ['POST'],
    authLevel: 'function',
    route: 'getStudentPerformance',
    handler: async (request, context) => {
        try {
            const body = await request.json();

            const studentPlayFabId = (body.studentPlayFabId || '').trim();

            if (!studentPlayFabId) {
                return {
                    status: 400,
                    jsonBody: {
                        success: false,
                        message: 'Missing student PlayFabId.',
                        hasStartedGame: false,
                        currentDay: 0,
                        results: []
                    }
                };
            }

            const titleId = (process.env.PLAYFAB_TITLE_ID || '').trim();
            const secretKey = (process.env.PLAYFAB_SECRET_KEY || '').trim();

            if (!titleId || !secretKey) {
                return {
                    status: 500,
                    jsonBody: {
                        success: false,
                        message: 'Server configuration is missing.',
                        hasStartedGame: false,
                        currentDay: 0,
                        results: []
                    }
                };
            }

            const userData = await getUserData(titleId, secretKey, studentPlayFabId, [
                GameStateKey,
                DailyResultsKey
            ]);

            let gameState = {
                hasStartedGame: false,
                currentDay: 0
            };

            let dailyResults = {
                results: []
            };

            if (userData[GameStateKey] && userData[GameStateKey].Value) {
                gameState = JSON.parse(userData[GameStateKey].Value);
            }

            if (userData[DailyResultsKey] && userData[DailyResultsKey].Value) {
                dailyResults = JSON.parse(userData[DailyResultsKey].Value);
            }

            return {
                status: 200,
                jsonBody: {
                    success: true,
                    message: 'Student performance loaded.',
                    hasStartedGame: gameState.hasStartedGame === true,
                    currentDay: gameState.currentDay || 0,
                    results: Array.isArray(dailyResults.results) ? dailyResults.results : []
                }
            };
        } catch (error) {
            context.error(error);

            return {
                status: 500,
                jsonBody: {
                    success: false,
                    message: 'Internal server error.',
                    hasStartedGame: false,
                    currentDay: 0,
                    results: []
                }
            };
        }
    }
});

async function getUserData(titleId, secretKey, playFabId, keys) {
    const response = await fetch(`https://${titleId}.playfabapi.com/Server/GetUserData`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'X-SecretKey': secretKey
        },
        body: JSON.stringify({
            PlayFabId: playFabId,
            Keys: keys
        })
    });

    const result = await response.json();

    if (!response.ok || result.error) {
        throw new Error(result.errorMessage || 'Could not get user data.');
    }

    return result.data && result.data.Data ? result.data.Data : {};
}