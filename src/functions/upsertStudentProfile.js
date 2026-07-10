const { app } = require('@azure/functions');

const StudentIndexKey = 'Hotelia_StudentIndex';

app.http('upsertStudentProfile', {
    methods: ['POST'],
    authLevel: 'function',
    route: 'upsertStudentProfile',
    handler: async (request, context) => {
        try {
            const body = await request.json();

            const playFabId = (body.playFabId || '').trim();
            const email = (body.email || '').trim();
            const displayName = (body.displayName || '').trim();

            if (!playFabId || !email || !displayName) {
                return {
                    status: 400,
                    jsonBody: {
                        success: false,
                        message: 'Missing student profile data.'
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
                        message: 'Server configuration is missing.'
                    }
                };
            }

            const role = await getPlayerRole(titleId, secretKey, playFabId);

            if (role === 'teacher') {
                return {
                    status: 200,
                    jsonBody: {
                        success: false,
                        message: 'Teacher accounts cannot be registered as students.'
                    }
                };
            }

            const indexData = await getInternalJson(titleId, secretKey, StudentIndexKey, { students: [] });

            const existingIndex = indexData.students.findIndex(s => s.playFabId === playFabId);

            const studentProfile = {
                playFabId: playFabId,
                email: email,
                displayName: displayName,
                status: 'ACTIVE'
            };

            if (existingIndex >= 0) {
                indexData.students[existingIndex] = studentProfile;
            } else {
                indexData.students.push(studentProfile);
            }

            await setInternalJson(titleId, secretKey, StudentIndexKey, indexData);

            return {
                status: 200,
                jsonBody: {
                    success: true,
                    message: 'Student profile saved.'
                }
            };
        } catch (error) {
            context.error(error);

            return {
                status: 500,
                jsonBody: {
                    success: false,
                    message: 'Internal server error.'
                }
            };
        }
    }
});

async function getPlayerRole(titleId, secretKey, playFabId) {
    const response = await fetch(`https://${titleId}.playfabapi.com/Server/GetUserData`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'X-SecretKey': secretKey
        },
        body: JSON.stringify({
            PlayFabId: playFabId,
            Keys: ['Role']
        })
    });

    const result = await response.json();

    if (!result.data || !result.data.Data || !result.data.Data.Role) {
        return 'student';
    }

    return result.data.Data.Role.Value || 'student';
}

async function getInternalJson(titleId, secretKey, key, defaultValue) {
    const response = await fetch(`https://${titleId}.playfabapi.com/Admin/GetTitleInternalData`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'X-SecretKey': secretKey
        },
        body: JSON.stringify({
            Keys: [key]
        })
    });

    const result = await response.json();

    if (!result.data || !result.data.Data || !result.data.Data[key]) {
        return defaultValue;
    }

    return JSON.parse(result.data.Data[key]);
}

async function setInternalJson(titleId, secretKey, key, value) {
    const response = await fetch(`https://${titleId}.playfabapi.com/Admin/SetTitleInternalData`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'X-SecretKey': secretKey
        },
        body: JSON.stringify({
            Key: key,
            Value: JSON.stringify(value)
        })
    });

    const result = await response.json();

    if (!response.ok || result.error) {
        throw new Error(result.errorMessage || 'Could not save internal data.');
    }
}