import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';
import { startExotelCall } from '../services/exotel.service.js';
import { loadConfig, assertRequiredConfig } from '../config/env.js';
import { isAuthorizedBearer, verifyStreamSignature } from '../utils/security.js';
import { VoiceHandler } from '../websocket/voice-handler.js';
import { CallSessionService } from '../services/CallSessionService.js';
import { generateInterviewSetup } from '../agents/interview-agent.js';
import { SarvamInterviewLLMService } from '../services/SarvamInterviewLLMService.js';

const config = loadConfig();
assertRequiredConfig(config);
const callSessionService = new CallSessionService(config);

const callContexts = new Map();
const pendingStarts = new Map();
const callResults = new Map();
export const server = createServer(async (request, response) => {
    if (request.method === 'GET' && request.url === '/health') {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ status: 'ok' }));
        return;
    }

    if (request.method !== 'POST' || request.url !== '/calls') {
        response.writeHead(404);
        response.end();
        return;
    }

    if (!isAuthorizedBearer(request.headers.authorization, config.serviceToken)) {
        response.writeHead(401);
        response.end();
        return;
    }

    try {
        const body = await readJsonBody(request);
        validateCallRequest(body);
        const previousResult = callResults.get(String(body.ai_call_id));
        if (previousResult) {
            respondJson(response, 200, previousResult);
            return;
        }
        const existing = pendingStarts.get(String(body.ai_call_id));
        if (existing) {
            const result = await existing;
            respondJson(response, 200, result);
            return;
        }

        const start = createCall(body);
        pendingStarts.set(String(body.ai_call_id), start);
        try {
            const result = await start;
            callResults.set(String(body.ai_call_id), result);
            respondJson(response, 202, result);
        } finally {
            pendingStarts.delete(String(body.ai_call_id));
        }
    } catch (error) {
        console.error('Unable to initiate Exotel call', { message: error.message });
        respondJson(response, error.statusCode || 502, { error: 'Unable to initiate the AI call.' });
    }
});
server.keepAliveTimeout = config.httpKeepAliveTimeoutMs;
server.headersTimeout = Math.max(60000, config.httpKeepAliveTimeoutMs + 1000);
server.requestTimeout = Math.max(300000, config.httpKeepAliveTimeoutMs + 1000);

const webSocketServer = new WebSocketServer({ noServer: true, maxPayload: 2 * 1024 * 1024 });

server.on('upgrade', (request, socket, head) => {
    const url = new URL(request.url, 'http://localhost');
    const match = /^\/media\/(\d+)$/.exec(url.pathname);
    const aiCallId = match?.[1];
    const context = aiCallId ? callContexts.get(aiCallId) : null;
    const issuedAt = url.searchParams.get('issued_at');
    const signature = url.searchParams.get('signature');

    if (!context || !verifyStreamSignature(aiCallId, issuedAt, signature, config.sharedSecret)) {
        socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
        socket.destroy();
        return;
    }

    webSocketServer.handleUpgrade(request, socket, head, (webSocket) => {
        const handler = new VoiceHandler(webSocket, config, context, postLaravelResult);
        handler.attach();
    });
});

server.listen(config.port, () => {
    console.log(`ATS voice agent listening on port ${config.port}`);
});

server.on('error', (error) => {
    console.error('ATS voice agent server failed', { message: error.message });
});

async function createCall(body) {
    const context = {
        ai_call_id: body.ai_call_id,
        candidate: body.candidate,
        requisition: body.requisition,
        company_name: body.company_name,
        screening_questions: body.screening_questions,
    };

    if (body.interview) {
        const llm = new SarvamInterviewLLMService({
            ...config.sarvam,
            timeoutMs: config.llmTimeoutMs,
        });
        const interviewContext = {
            session_id: body.interview.session_id,
            difficulty: body.interview.difficulty,
            candidate: body.candidate,
            requisition: body.requisition,
            companyName: body.company_name,
            previousScreeningSummary: body.interview.previous_screening_summary || '',
            previousScreeningTranscript: body.interview.previous_screening_transcript || '',
        };
        const setup = await generateInterviewSetup(llm, interviewContext);
        interviewContext.questions = setup.questions;
        interviewContext.previousScreeningSummary = setup.previousScreeningSummary;
        context.interview = interviewContext;
    }

    callContexts.set(String(body.ai_call_id), context);

    try {
        const result = await startExotelCall({
            ...config.exotel,
            maxCallDurationSeconds: config.maxCallDurationSeconds,
        }, body);
        return result;
    } catch (error) {
        callContexts.delete(String(body.ai_call_id));
        throw error;
    }
}

async function postLaravelResult(payload) {
    let lastError;
    for (let attempt = 0; attempt < 3; attempt++) {
        try {
            await callSessionService.updateExotelSession(payload);
            if (['completed', 'failed', 'busy', 'no-answer'].includes(payload.status)) {
                callContexts.delete(String(payload.ai_call_id));
                callResults.delete(String(payload.ai_call_id));
            }
            return;
        } catch (error) {
            lastError = error;
            if (attempt < 2) {
                await new Promise((resolve) => setTimeout(resolve, 250 * (2 ** attempt)));
            }
        }
    }

    throw lastError;
}

function validateCallRequest(body) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
        const error = new Error('Invalid call request.');
        error.statusCode = 422;
        throw error;
    }

    const validPhone = typeof body.phone === 'string' && /^\+[1-9]\d{7,14}$/.test(body.phone);
    const validStream = typeof body.stream_url === 'string' && body.stream_url.startsWith('wss://');
    const candidateValid = body.candidate && typeof body.candidate === 'object'
        && typeof body.candidate.name === 'string' && body.candidate.name.trim();
    const requisitionValid = body.requisition && typeof body.requisition === 'object'
        && Number.isInteger(body.requisition.id);
    const questionsValid = Array.isArray(body.screening_questions)
        && body.screening_questions.length > 0
        && body.screening_questions.every((question) => question && typeof question.id === 'string' && typeof question.text === 'string');
    const interviewValid = body.interview === undefined || (
        body.interview && typeof body.interview === 'object'
        && Number.isSafeInteger(body.interview.session_id) && body.interview.session_id > 0
        && ['Basic', 'Intermediate', 'Advanced'].includes(body.interview.difficulty)
        && (body.interview.previous_screening_transcript === null
            || typeof body.interview.previous_screening_transcript === 'string')
        && (body.interview.previous_screening_summary === null
            || typeof body.interview.previous_screening_summary === 'string')
    );

    if (!Number.isInteger(body.ai_call_id) || body.ai_call_id < 1
        || !validPhone || !validStream
        || !candidateValid || !requisitionValid
        || typeof body.company_name !== 'string' || !body.company_name.trim()
        || !questionsValid || !interviewValid) {
        const error = new Error('Invalid call request.');
        error.statusCode = 422;
        throw error;
    }

    const url = new URL(body.stream_url);
    const match = /^\/media\/(\d+)$/.exec(url.pathname);
    const issuedAt = url.searchParams.get('issued_at');
    const signature = url.searchParams.get('signature');
    if (match?.[1] !== String(body.ai_call_id)
        || Number(url.searchParams.get('sample-rate')) !== config.sarvam.sampleRate
        || !verifyStreamSignature(String(body.ai_call_id), issuedAt, signature, config.sharedSecret)) {
        const error = new Error('Invalid stream signature.');
        error.statusCode = 403;
        throw error;
    }
}

async function readJsonBody(request) {
    const chunks = [];
    let size = 0;
    for await (const chunk of request) {
        size += chunk.length;
        if (size > 64 * 1024) {
            const error = new Error('Request body is too large.');
            error.statusCode = 413;
            throw error;
        }
        chunks.push(chunk);
    }

    try {
        return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
        const error = new Error('Request body must be valid JSON.');
        error.statusCode = 400;
        throw error;
    }
}

function respondJson(response, status, payload) {
    response.writeHead(status, { 'content-type': 'application/json' });
    response.end(JSON.stringify(payload));
}
