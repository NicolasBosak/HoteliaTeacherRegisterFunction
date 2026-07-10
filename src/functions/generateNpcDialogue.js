const { app } = require('@azure/functions');

const OPENAI_URL = 'https://api.openai.com/v1/responses';

app.http('generateNpcDialogue', {
    methods: ['POST'],
    authLevel: 'function',
    route: 'generateNpcDialogue',
    handler: async (request, context) => {
        try {
            const body = await request.json();
            const prompt = (body.prompt || '').trim();

            if (!prompt) {
                return {
                    status: 400,
                    jsonBody: {
                        success: false,
                        message: 'Missing prompt.',
                        text: ''
                    }
                };
            }

            if (prompt.length > 5000) {
                return {
                    status: 400,
                    jsonBody: {
                        success: false,
                        message: 'Prompt too long.',
                        text: ''
                    }
                };
            }

            const apiKey = (process.env.OPENAI_API_KEY || '').trim();
            const model = (process.env.OPENAI_MODEL || 'gpt-5.4-mini').trim();

            if (!apiKey) {
                context.error('Missing OPENAI_API_KEY environment variable.');

                return {
                    status: 500,
                    jsonBody: {
                        success: false,
                        message: 'Missing OPENAI_API_KEY in Azure configuration.',
                        text: ''
                    }
                };
            }

            context.log(`Calling OpenAI model: ${model}`);

            const openAiResponse = await fetch(OPENAI_URL, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${apiKey}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    model: model,
                    input: prompt,
                    max_output_tokens: 150,
                    temperature: 0.8,
                    reasoning: {
                        effort: 'none'
                    },
                    text: {
                        verbosity: 'low'
                    },
                    store: false
                })
            });

            const responseText = await openAiResponse.text();

            if (!openAiResponse.ok) {
                context.error(`OpenAI error ${openAiResponse.status}: ${responseText}`);

                return {
                    status: 500,
                    jsonBody: {
                        success: false,
                        message: `OpenAI request failed with status ${openAiResponse.status}: ${getOpenAIErrorMessage(responseText)}`,
                        text: ''
                    }
                };
            }

            let data;

            try {
                data = JSON.parse(responseText);
            } catch (parseError) {
                context.error('Could not parse OpenAI response:', responseText);

                return {
                    status: 500,
                    jsonBody: {
                        success: false,
                        message: 'Could not parse OpenAI response.',
                        text: ''
                    }
                };
            }

            const npcText = extractOpenAIText(data);

            if (!npcText) {
                context.error('OpenAI returned empty text:', responseText);

                return {
                    status: 500,
                    jsonBody: {
                        success: false,
                        message: 'OpenAI returned empty text.',
                        text: ''
                    }
                };
            }

            return {
                status: 200,
                jsonBody: {
                    success: true,
                    message: '',
                    text: cleanResponse(npcText)
                }
            };
        } catch (error) {
            context.error('Azure Function exception:', error);

            return {
                status: 500,
                jsonBody: {
                    success: false,
                    message: error.message || 'Unexpected server error.',
                    text: ''
                }
            };
        }
    }
});

function getOpenAIErrorMessage(responseText) {
    try {
        const parsed = JSON.parse(responseText);

        if (parsed.error && parsed.error.message) {
            return parsed.error.message;
        }

        return responseText;
    } catch {
        return responseText;
    }
}

function extractOpenAIText(data) {
    if (!data) return '';

    if (data.output_text) {
        return data.output_text;
    }

    if (!Array.isArray(data.output)) {
        return '';
    }

    for (const item of data.output) {
        if (!item || !Array.isArray(item.content)) continue;

        for (const content of item.content) {
            if (content && content.text) {
                return content.text;
            }
        }
    }

    return '';
}

function cleanResponse(text) {
    if (!text) return '';

    return text
        .replaceAll('Tourist:', '')
        .replaceAll('Client:', '')
        .replaceAll('NPC:', '')
        .replaceAll('Hotel Worker:', '')
        .replaceAll('Hotel worker:', '')
        .replaceAll('Worker:', '')
        .trim();
}