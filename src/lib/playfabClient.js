/*
 * Cliente PlayFab compartido.
 *
 * Estos helpers estaban copiados literalmente en varias funciones, lo que
 * SonarQube reportaba como código duplicado. El comportamiento es exactamente
 * el mismo que tenían las copias locales: no se cambió ninguna respuesta ni
 * ningún mensaje de error.
 */

const ROLE_KEY = 'Role';

function normalizeText(value) {
    return typeof value === 'string'
        ? value.trim()
        : '';
}

function safeParseJson(value, fallback) {
    if (!value) {
        return fallback;
    }

    try {
        return JSON.parse(value);
    } catch {
        return fallback;
    }
}

/*
 * Lee data.Data[key].Value, el formato que devuelve Server/GetUserData.
 */
function getUserDataValue(data, key) {
    if (!data || !data.Data || !data.Data[key]) {
        return '';
    }

    return data.Data[key].Value || '';
}

function getRequiredEnv(name) {
    const value = normalizeText(
        process.env[name]
    );

    if (!value) {
        throw new Error(
            'Missing environment variable: ' +
            name
        );
    }

    return value;
}

/*
 * Devuelve {} cuando el cuerpo no es JSON válido, para que cada función
 * aplique sus propias validaciones de campos.
 */
async function readJsonBody(request) {
    try {
        return await request.json();
    } catch {
        return {};
    }
}

async function playFabPost(
    titleId,
    path,
    body,
    secretKey
) {
    const response = await fetch(
        `https://${titleId}.playfabapi.com/${path}`,
        {
            method: 'POST',

            headers: {
                'Content-Type':
                    'application/json',

                'X-SecretKey':
                    secretKey
            },

            body: JSON.stringify(
                body || {}
            )
        }
    );

    const text = await response.text();

    let result;

    try {
        result = text
            ? JSON.parse(text)
            : {};
    } catch {
        throw new Error(
            'Invalid PlayFab response from ' +
            path +
            '.'
        );
    }

    if (
        !response.ok ||
        !result ||
        result.error ||
        result.code !== 200
    ) {
        const message =
            result && result.errorMessage
                ? result.errorMessage
                : 'PlayFab request failed: ' +
                path;

        throw new Error(message);
    }

    return result.data || {};
}

/*
 * Devuelve null cuando el ticket no se puede validar, de modo que quien llama
 * responda 401 sin distinguir entre ticket inválido y fallo de red.
 */
async function authenticateSessionTicket(
    titleId,
    secretKey,
    sessionTicket
) {
    try {
        const data = await playFabPost(
            titleId,
            'Server/AuthenticateSessionTicket',
            {
                SessionTicket: sessionTicket
            },
            secretKey
        );

        const userInfo =
            data && data.UserInfo
                ? data.UserInfo
                : null;

        const playFabId =
            userInfo && userInfo.PlayFabId
                ? normalizeText(
                    userInfo.PlayFabId
                )
                : '';

        return {
            playFabId,
            userInfo
        };
    } catch {
        return null;
    }
}

/*
 * Variante que toma titleId/secretKey de las variables de entorno en el
 * momento de la llamada (no al cargar el módulo), conservando el mensaje de
 * error que ya devolvían las funciones de parámetros de IA.
 */
function playfabRequestFromEnv(path, body) {
    const titleId = normalizeText(
        process.env.PLAYFAB_TITLE_ID
    );

    const secretKey = normalizeText(
        process.env.PLAYFAB_SECRET_KEY
    );

    if (!titleId || !secretKey) {
        throw new Error(
            'Missing PLAYFAB_TITLE_ID or PLAYFAB_SECRET_KEY app settings.'
        );
    }

    return playFabPost(
        titleId,
        path,
        body,
        secretKey
    );
}

/*
 * Variante que devuelve solo el PlayFabId (o '' si el ticket no es válido).
 * Se mantiene aparte de authenticateSessionTicket porque varias funciones
 * dependen de ese contrato más simple.
 */
async function authenticateSessionTicketId(
    titleId,
    secretKey,
    sessionTicket
) {
    const authenticated = await authenticateSessionTicket(
        titleId,
        secretKey,
        sessionTicket
    );

    return authenticated && authenticated.playFabId
        ? authenticated.playFabId
        : '';
}

async function getPlayerRole(
    titleId,
    secretKey,
    playFabId
) {
    const data = await playFabPost(
        titleId,
        'Server/GetUserData',
        {
            PlayFabId: playFabId,
            Keys: [ROLE_KEY]
        },
        secretKey
    );

    if (
        !data ||
        !data.Data ||
        !data.Data[ROLE_KEY]
    ) {
        return '';
    }

    return normalizeText(
        data.Data[ROLE_KEY].Value
    ).toLowerCase();
}

async function getInternalJson(
    titleId,
    secretKey,
    key,
    defaultValue
) {
    const data = await playFabPost(
        titleId,
        'Admin/GetTitleInternalData',
        {
            Keys: [key]
        },
        secretKey
    );

    if (
        !data ||
        !data.Data ||
        !data.Data[key]
    ) {
        return defaultValue;
    }

    try {
        return JSON.parse(
            data.Data[key]
        );
    } catch {
        return defaultValue;
    }
}

async function setInternalJson(
    titleId,
    secretKey,
    key,
    value
) {
    await playFabPost(
        titleId,
        'Admin/SetTitleInternalData',
        {
            Key: key,
            Value: JSON.stringify(value)
        },
        secretKey
    );
}

module.exports = {
    ROLE_KEY,
    normalizeText,
    safeParseJson,
    getUserDataValue,
    getRequiredEnv,
    readJsonBody,
    playFabPost,
    playfabRequestFromEnv,
    authenticateSessionTicket,
    authenticateSessionTicketId,
    getPlayerRole,
    getInternalJson,
    setInternalJson
};
