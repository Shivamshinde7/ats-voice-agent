import '../load-env.js';
import dotenv from 'dotenv';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { assertRuntimeConfig, loadConfig } from '../config/env.js';
import { CallSessionService } from '../services/CallSessionService.js';
import { LocalTestHandler } from './websocket-handler.js';

const rootDir = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(rootDir, 'public');
dotenv.config({ path: path.resolve(rootDir, '../../.env') });
const baseConfig = loadConfig();
const config = {
    port: baseConfig.localTestPort,
    apiUrl: process.env.AI_CALLING_LOCAL_TEST_API_URL
        || 'http://127.0.0.1:8000/api/ai-calling/local-test/calls',
    sharedSecret: baseConfig.sharedSecret,
    audio: baseConfig.audio,
    bargeIn: baseConfig.bargeIn,
    sarvam: baseConfig.sarvam,
    silencePromptSeconds: baseConfig.silencePromptSeconds,
    maxCallDurationSeconds: baseConfig.maxCallDurationSeconds,
    websocketPingIntervalMs: baseConfig.websocketPingIntervalMs,
    websocketIdleTimeoutMs: baseConfig.websocketIdleTimeoutMs,
    sttKeepAliveIntervalMs: baseConfig.sttKeepAliveIntervalMs,
    llmTimeoutMs: baseConfig.llmTimeoutMs,
    llmRetries: baseConfig.llmRetries,
};
const callSessionService = new CallSessionService(config);
assertRuntimeConfig(baseConfig);

if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65535) {
    throw new Error('LOCAL_TEST_PORT must be a valid TCP port.');
}
if (!config.sharedSecret) {
    throw new Error('AI_VOICE_AGENT_SHARED_SECRET is required for signed Laravel database requests.');
}
try {
    const apiUrl = new URL(config.apiUrl);
    const isLocalApi = ['localhost', '127.0.0.1', '[::1]'].includes(apiUrl.hostname);
    if ((apiUrl.protocol !== 'https:' && !(apiUrl.protocol === 'http:' && isLocalApi))
        || !apiUrl.pathname.includes('/api/ai-calling/local-test/calls')) {
        throw new Error();
    }
} catch {
    throw new Error('AI_CALLING_LOCAL_TEST_API_URL must be an HTTPS Laravel local-test endpoint (HTTP is allowed for localhost).');
}
if (!config.sarvam.apiKey) {
    throw new Error('SARVAM_API_KEY is required for the local test server.');
}
if (![8000, 16000].includes(config.sarvam.sampleRate)) {
    throw new Error('SARVAM_SAMPLE_RATE must be 8000 or 16000.');
}
if (!['sarvam-105b', 'sarvam-105b-conversations'].includes(config.sarvam.llmModel)) {
    throw new Error('SARVAM_LLM_MODEL must be sarvam-105b or sarvam-105b-conversations.');
}

const contexts = new Map();
const httpServer = createServer(async (request, response) => {
    const requestUrl = new URL(request.url, `http://127.0.0.1:${config.port}`);

    if (request.method === 'GET' && requestUrl.pathname === '/health') {
        return sendJson(response, 200, { status: 'ok', mode: 'browser' });
    }

    if (request.method === 'GET' && ['/', '/index.html'].includes(requestUrl.pathname)) {
        return serveFile(response, path.join(publicDir, 'index.html'), 'text/html; charset=utf-8');
    }
    if (request.method === 'GET' && requestUrl.pathname === '/app.js') {
        return serveFile(response, path.join(publicDir, 'app.js'), 'text/javascript; charset=utf-8');
    }

    if (request.method === 'POST' && requestUrl.pathname === '/api/test-calls') {
        try {
            assertLocalBrowserRequest(request, config.port);
            const body = await readJsonBody(request);
            validateCallStart(body);

            const callSession = await callSessionService.createBrowserSession({
                candidate_id: body.candidate_id,
                initiated_by: body.initiated_by,
                browser_mode: body.browser_mode || 'screening',
                interview_session_id: body.interview_session_id,
                browser_context_expires: body.browser_context_expires,
                browser_context_signature: body.browser_context_signature,
            });

            const context = {
                ai_call_id: callSession.ai_call_id,
                test_call_id: callSession.test_call_id,
                ...callSession.context,
            };
            context.startTimer = setTimeout(() => {
                contexts.delete(callSession.test_call_id);
                callSessionService.updateBrowserSession(callSession.test_call_id, {
                    status: 'failed',
                    duration_seconds: 0,
                    transcript: '',
                    evaluation: { summary: 'The browser did not connect to the test call.' },
                    error_message: 'The browser WebSocket did not connect within 60 seconds.',
                }).catch((error) => {
                    console.error('Unable to close an unconnected local test call', {
                        test_call_id: callSession.test_call_id,
                        message: error.message,
                    });
                });
            }, baseConfig.websocketIdleTimeoutMs);
            contexts.set(callSession.test_call_id, context);

            sendJson(response, 201, {
                call_id: callSession.test_call_id,
                ai_call_id: callSession.ai_call_id,
                sample_rate: config.sarvam.sampleRate,
            });
        } catch (error) {
            console.error('Unable to create local test call', { message: error.message });
            sendJson(response, error.statusCode || 502, { error: error.message });
        }
        return;
    }

    sendJson(response, 404, { error: 'Not found.' });
});
httpServer.keepAliveTimeout = baseConfig.httpKeepAliveTimeoutMs;
httpServer.headersTimeout = Math.max(60000, baseConfig.httpKeepAliveTimeoutMs + 1000);
httpServer.requestTimeout = Math.max(300000, baseConfig.httpKeepAliveTimeoutMs + 1000);

const webSocketServer = new WebSocketServer({
    noServer: true,
    maxPayload: 6 * 1024 * 1024,
    perMessageDeflate: false,
});

httpServer.on('upgrade', (request, socket, head) => {
    const url = new URL(request.url, `http://127.0.0.1:${config.port}`);
    const match = /^\/ws\/([0-9a-f-]{36})$/i.exec(url.pathname);
    const context = match ? contexts.get(match[1]) : null;

    if (!context || !isLocalOrigin(request.headers.origin, config.port)) {
        socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
        socket.destroy();
        return;
    }

    webSocketServer.handleUpgrade(request, socket, head, (webSocket) => {
        clearTimeout(context.startTimer);
        const handler = new LocalTestHandler(webSocket, config, context, callSessionService, () => {
            contexts.delete(context.test_call_id);
        });
        handler.attach();
    });
});

httpServer.listen(config.port, '127.0.0.1', () => {
    console.log(`Local AI recruiter test page: http://127.0.0.1:${config.port}`);
    console.log(`Laravel test-call API: ${config.apiUrl}`);
    console.log(`Sarvam STT/TTS sample rate: ${config.sarvam.sampleRate} Hz`);
});

httpServer.on('error', (error) => {
    console.error('Local test server failed', { message: error.message });
});

export const server = httpServer;

function assertLocalBrowserRequest(request, port) {
    if (!isLocalOrigin(request.headers.origin, port)) {
        const error = new Error('Requests must come from the local test page origin.');
        error.statusCode = 403;
        throw error;
    }
}

function isLocalOrigin(origin, port) {
    if (typeof origin !== 'string') {
        return false;
    }

    try {
        const parsed = new URL(origin);
        return parsed.protocol === 'http:'
            && ['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname)
            && parsed.port === String(port);
    } catch {
        return false;
    }
}

function validateCallStart(body) {
    for (const field of ['candidate_id', 'initiated_by']) {
        if (!Number.isSafeInteger(body?.[field]) || body[field] < 1) {
            const error = new Error(`${field} must be a positive numeric ID.`);
            error.statusCode = 422;
            throw error;
        }
    }

    const browserMode = body?.browser_mode || 'screening';
    if (!['screening', 'interview'].includes(browserMode)
        || (browserMode === 'interview'
            && (!Number.isSafeInteger(body.interview_session_id) || body.interview_session_id < 1
                || body.browser_context_expires === undefined || body.browser_context_signature === undefined))) {
        const error = new Error('The browser interview context is missing or invalid.');
        error.statusCode = 422;
        throw error;
    }

    const hasContextExpiry = body?.browser_context_expires !== undefined;
    const hasContextSignature = body?.browser_context_signature !== undefined;
    if (hasContextExpiry !== hasContextSignature
        || (hasContextExpiry && (!Number.isSafeInteger(Number(body.browser_context_expires))
            || Number(body.browser_context_expires) < 1
            || typeof body.browser_context_signature !== 'string'
            || !/^[a-f0-9]{64}$/i.test(body.browser_context_signature)))) {
        const error = new Error('The browser candidate context is incomplete or invalid.');
        error.statusCode = 422;
        throw error;
    }
}

async function readJsonBody(request) {
    const chunks = [];
    let size = 0;
    for await (const chunk of request) {
        size += chunk.length;
        if (size > 16 * 1024) {
            const error = new Error('Request body is too large.');
            error.statusCode = 413;
            throw error;
        }
        chunks.push(chunk);
    }

    try {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (!body || typeof body !== 'object' || Array.isArray(body)) {
            throw new Error();
        }
        return body;
    } catch {
        const error = new Error('Request body must be a JSON object.');
        error.statusCode = 400;
        throw error;
    }
}

async function serveFile(response, filePath, contentType) {
    try {
        const contents = await readFile(filePath);
        response.writeHead(200, {
            'content-type': contentType,
            'cache-control': 'no-store',
            'x-content-type-options': 'nosniff',
            'content-security-policy': "default-src 'self'; connect-src 'self' ws:; media-src 'self' blob:; style-src 'self' 'unsafe-inline';",
        });
        response.end(contents);
    } catch (error) {
        console.error('Unable to serve local test page', { message: error.message });
        sendJson(response, 500, { error: 'Unable to load the local test page.' });
    }
}

function sendJson(response, status, payload) {
    response.writeHead(status, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
    });
    response.end(JSON.stringify(payload));
}
