import { signWebhookBody } from '../utils/security.js';

export async function createLocalTestCall(config, payload) {
    return sendLaravelRequest(config, 'POST', config.apiUrl, payload);
}

export async function updateLocalTestCall(config, testCallId, payload) {
    const url = `${config.apiUrl.replace(/\/$/, '')}/${encodeURIComponent(testCallId)}`;
    return sendLaravelRequest(config, 'PATCH', url, payload);
}

async function sendLaravelRequest(config, method, url, payload) {
    if (!url) {
        throw new Error('AI_CALLING_LOCAL_TEST_API_URL is not configured.');
    }

    const timestamp = String(Math.floor(Date.now() / 1000));
    const body = JSON.stringify(payload);
    const response = await fetch(url, {
        method,
        redirect: 'manual',
        headers: {
            'content-type': 'application/json',
            accept: 'application/json',
            'X-AI-Calling-Timestamp': timestamp,
            'X-AI-Calling-Signature': signWebhookBody(body, timestamp, config.sharedSecret),
        },
        body,
        signal: AbortSignal.timeout(10000),
    });

    const contentType = response.headers.get('content-type') || '';
    const responseBody = await response.text();
    let result = null;
    if (contentType.includes('application/json') && responseBody) {
        try {
            result = JSON.parse(responseBody);
        } catch {
            throw new Error(`Laravel returned invalid JSON with HTTP ${response.status}.`);
        }
    }

    if (!response.ok) {
        const detail = result?.error || result?.message
            || `Laravel returned HTTP ${response.status}${contentType ? ` (${contentType})` : ''}.`;
        const missing = Array.isArray(result?.missing_columns)
            ? ` Missing ai_calls columns: ${result.missing_columns.join(', ')}.`
            : '';
        const invalid = result?.invalid_columns && typeof result.invalid_columns === 'object'
            ? ` Incompatible ai_calls columns: ${Object.entries(result.invalid_columns)
                .map(([name, types]) => `${name} (expected ${types.expected}; found ${types.actual})`)
                .join(', ')}.`
            : '';
        const error = new Error(`${detail}${missing}${invalid}`);
        error.statusCode = response.status;
        throw error;
    }

    if (!result || typeof result !== 'object' || Array.isArray(result)) {
        throw new Error(
            `Laravel returned a non-JSON response with HTTP ${response.status}`
            + `${contentType ? ` (${contentType})` : ''}. Check the local-test API URL and Laravel routing; the endpoint may be redirecting.`,
        );
    }

    return result;
}
