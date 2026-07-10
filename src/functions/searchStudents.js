const { app } = require('@azure/functions');

const StudentIndexKey = 'Hotelia_StudentIndex';

app.http('searchStudents', {
    methods: ['POST'],
    authLevel: 'function',
    route: 'searchStudents',
    handler: async (request, context) => {
        try {
            const body = await request.json().catch(() => ({}));
            const query = (body.query || '').trim().toLowerCase();

            const titleId = (process.env.PLAYFAB_TITLE_ID || '').trim();
            const secretKey = (process.env.PLAYFAB_SECRET_KEY || '').trim();

            if (!titleId || !secretKey) {
                return {
                    status: 500,
                    jsonBody: {
                        success: false,
                        message: 'Server configuration is missing.',
                        students: []
                    }
                };
            }

            const indexData = await getInternalJson(titleId, secretKey, StudentIndexKey, { students: [] });

            let students = Array.isArray(indexData.students)
                ? indexData.students
                : [];

            if (query) {
                students = students.filter(student => {
                    const email = (student.email || '').toLowerCase();
                    const displayName = (student.displayName || '').toLowerCase();

                    return email.includes(query) || displayName.includes(query);
                });
            }

            const results = students
                .filter(student => (student.status || 'ACTIVE') === 'ACTIVE')
                .slice(0, 100);

            return {
                status: 200,
                jsonBody: {
                    success: true,
                    message: query ? 'Students found.' : 'All students loaded.',
                    students: results
                }
            };
        } catch (error) {
            context.error(error);

            return {
                status: 500,
                jsonBody: {
                    success: false,
                    message: 'Internal server error.',
                    students: []
                }
            };
        }
    }
});

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