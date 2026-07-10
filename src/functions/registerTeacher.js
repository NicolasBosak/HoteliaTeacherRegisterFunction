const { app } = require('@azure/functions');

app.http('registerTeacher', {
    methods: ['POST'],
    authLevel: 'function',
    route: 'registerTeacher',
    handler: async (request, context) => {
        try {
            const body = await request.json();

            const email = body.email;
            const password = body.password;
            const teacherCode = body.teacherCode;

            if (!email || !password || !teacherCode) {
                return {
                    status: 400,
                    jsonBody: {
                        success: false,
                        message: 'Missing email, password, or teacher code.'
                    }
                };
            }

            const validTeacherCode = (process.env.TEACHER_ACCESS_CODE || '').trim();
            const titleId = (process.env.PLAYFAB_TITLE_ID || '').trim();
            const secretKey = (process.env.PLAYFAB_SECRET_KEY || '').trim();

            if (!titleId || !secretKey || !validTeacherCode) {
                return {
                    status: 500,
                    jsonBody: {
                        success: false,
                        message: 'Server configuration is missing.'
                    }
                };
            }

            if (teacherCode.trim() !== validTeacherCode) {
                return {
                    status: 200,
                    jsonBody: {
                        success: false,
                        message: 'Invalid teacher access code.'
                    }
                };
            }

            const registerUrl = `https://${titleId}.playfabapi.com/Client/RegisterPlayFabUser`;

            const registerResponse = await fetch(registerUrl, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    TitleId: titleId,
                    Email: email,
                    Password: password,
                    RequireBothUsernameAndEmail: false
                })
            });

            const registerResult = await registerResponse.json();

            context.log('RegisterPlayFabUser result:', JSON.stringify(registerResult));

            let playFabId = null;

            if (!registerResponse.ok || registerResult.error) {
                const errorMessage = registerResult.errorMessage || '';

                if (errorMessage.toLowerCase().includes('email address not available')) {
                    const loginResult = await loginExistingTeacherAccount(titleId, email, password, context);

                    if (!loginResult.success) {
                        return {
                            status: 200,
                            jsonBody: {
                                success: false,
                                message: 'This email is already registered. Log in with the correct password or use another email.'
                            }
                        };
                    }

                    playFabId = loginResult.playFabId;
                } else {
                    return {
                        status: 200,
                        jsonBody: {
                            success: false,
                            message: errorMessage || 'Could not create teacher account.'
                        }
                    };
                }
            } else {
                playFabId = registerResult.data.PlayFabId;
            }

            const roleSaved = await saveTeacherRole(titleId, secretKey, playFabId, context);

            if (!roleSaved.success) {
                return {
                    status: 200,
                    jsonBody: {
                        success: false,
                        message: roleSaved.message
                    }
                };
            }

            return {
                status: 200,
                jsonBody: {
                    success: true,
                    message: 'Teacher account ready. Please log in.'
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

async function loginExistingTeacherAccount(titleId, email, password, context) {
    const loginUrl = `https://${titleId}.playfabapi.com/Client/LoginWithEmailAddress`;

    const loginResponse = await fetch(loginUrl, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            TitleId: titleId,
            Email: email,
            Password: password
        })
    });

    const loginResult = await loginResponse.json();

    context.log('LoginWithEmailAddress result:', JSON.stringify(loginResult));

    if (!loginResponse.ok || loginResult.error) {
        return {
            success: false,
            playFabId: null
        };
    }

    return {
        success: true,
        playFabId: loginResult.data.PlayFabId
    };
}

async function saveTeacherRole(titleId, secretKey, playFabId, context) {
    const updateUserDataUrl = `https://${titleId}.playfabapi.com/Server/UpdateUserData`;

    const updateResponse = await fetch(updateUserDataUrl, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'X-SecretKey': secretKey
        },
        body: JSON.stringify({
            PlayFabId: playFabId,
            Data: {
                Role: 'teacher'
            },
            Permission: 'Private'
        })
    });

    const updateResult = await updateResponse.json();

    context.log('UpdateUserData result:', JSON.stringify(updateResult));

    if (!updateResponse.ok || updateResult.error) {
        return {
            success: false,
            message: updateResult.errorMessage || 'Teacher account exists, but role could not be saved.'
        };
    }

    return {
        success: true,
        message: 'Role saved.'
    };
}