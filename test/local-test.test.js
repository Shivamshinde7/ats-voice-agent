import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { createLocalTestCall, updateLocalTestCall } from '../src/local-test/laravel-client.js';
import { CallSessionService } from '../src/services/CallSessionService.js';
import { LocalTestHandler } from '../src/local-test/websocket-handler.js';
import { signWebhookBody } from '../src/utils/security.js';

const originalFetch = globalThis.fetch;
const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const jsonResponse = (status, body) => ({
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers({ 'content-type': 'application/json' }),
    text: async () => JSON.stringify(body),
});

beforeEach(() => {
    globalThis.fetch = async () => jsonResponse(200, { ai_call_id: 23, status: 'in-progress' });
});

afterEach(() => {
    globalThis.fetch = originalFetch;
});

test('reports the underlying screening failure while leaving the session open', async () => {
    const sent = [];
    const originalConsoleError = console.error;
    const logged = [];
    console.error = (...args) => logged.push(args);

    try {
        const handler = new LocalTestHandler(
            { readyState: 1, send: (message) => sent.push(JSON.parse(message)) },
            { sarvam: { sampleRate: 16000 }, audio: {} },
            { test_call_id: 'failure-detail-test' },
            {},
            () => {},
        );

        await handler.fail(new Error('Sarvam STT disconnected (code 1006)'));

        assert.deepEqual(sent, [{
            type: 'error',
            message: 'Voice processing failed: Sarvam STT disconnected (code 1006). The call is still active.',
        }]);
        assert.equal(logged[0][1].message, 'Sarvam STT disconnected (code 1006)');
        assert.equal(handler.finished, false);
    } finally {
        console.error = originalConsoleError;
    }
});

test('browser candidate speech stops playback when the final transcript confirms it', async () => {
    const sent = [];
    const handler = new LocalTestHandler(
        { readyState: 1, send: (message) => sent.push(JSON.parse(message)) },
        { sarvam: { sampleRate: 8000, sttMinSpeechDurationMs: 250 }, audio: {}, endOfSpeechMs: 200 },
        { test_call_id: 'test-call' },
        {},
        () => {},
    );
    handler.activeResponseId = 7;
    handler.isAiSpeaking = true;
    handler.lastAiText = 'Tell me about your recent experience.';
    handler.activeTurnCheckpoint = {};
    handler.activeTurnText = 'My experience is in Kubernetes.';
    let llmAborted = false;
    let ttsAborted = false;
    handler.activeLlmController = { abort: () => { llmAborted = true; } };
    handler.activeTtsController = { abort: () => { ttsAborted = true; } };

    await handler.handleSttEvent(JSON.stringify({ event: 'vad.speech_start' }));
    assert.equal(handler.activeResponseId, 7);
    await handler.handleSttEvent(JSON.stringify({ event: 'transcript.final', text: 'yes' }));

    assert.equal(handler.activeResponseId, null);
    assert.equal(handler.isAiSpeaking, false);
    assert.equal(llmAborted, true);
    assert.equal(ttsAborted, true);
    assert.equal(handler.pendingTranscript.length, 1);
    assert.equal(handler.pendingTranscript[0].text, 'My experience is in Kubernetes. yes');
    assert.deepEqual(sent.map(({ type }) => type), ['speech_start', 'barge_in', 'transcript_partial']);
    assert.equal(handler.pendingTranscript[0].duringAiSpeech, false);
});

test('browser playback stops on a non-echo partial before the final transcript', async () => {
    const sent = [];
    const handler = new LocalTestHandler(
        { readyState: 1, send: (message) => sent.push(JSON.parse(message)) },
        { sarvam: { sampleRate: 8000, sttMinSpeechDurationMs: 1000 }, audio: {} },
        { test_call_id: 'partial-barge-test' },
        {},
        () => {},
    );
    handler.activeResponseId = 8;
    handler.isAiSpeaking = true;
    handler.lastAiText = 'Tell me about your recent experience.';
    handler.activeTurnCheckpoint = {};
    let llmAborted = false;
    let ttsAborted = false;
    handler.activeLlmController = { abort: () => { llmAborted = true; } };
    handler.activeTtsController = { abort: () => { ttsAborted = true; } };

    await handler.handleSttEvent(JSON.stringify({ event: 'vad.speech_start' }));
    await handler.handleSttEvent(JSON.stringify({
        event: 'transcript.partial',
        text: 'I have a question',
    }));

    assert.equal(handler.activeResponseId, null);
    assert.equal(handler.isAiSpeaking, false);
    assert.equal(llmAborted, true);
    assert.equal(ttsAborted, true);
    assert.equal(sent.some(({ type }) => type === 'barge_in'), true);
});

test('browser recruiter echo does not interrupt playback or cancel an LLM turn', async () => {
    const sent = [];
    const handler = new LocalTestHandler(
        { readyState: 1, send: (message) => sent.push(JSON.parse(message)) },
        { sarvam: { sampleRate: 8000, sttMinSpeechDurationMs: 250 }, audio: {} },
        { test_call_id: 'echo-test' },
        {},
        () => {},
    );
    handler.activeResponseId = 7;
    handler.isAiSpeaking = true;
    handler.lastAiText = 'Tell me about your recent experience.';
    let llmAborted = false;
    let ttsAborted = false;
    handler.activeTurnCheckpoint = {};
    handler.activeLlmController = { abort: () => { llmAborted = true; } };
    handler.activeTtsController = { abort: () => { ttsAborted = true; } };

    await handler.handleSttEvent(JSON.stringify({ event: 'vad.speech_start' }));
    await handler.handleSttEvent(JSON.stringify({
        event: 'transcript.partial',
        text: 'Tell me about your recent experience',
    }));
    await handler.handleSttEvent(JSON.stringify({
        event: 'transcript.final',
        text: 'Tell me about your recent experience',
    }));

    assert.equal(handler.activeResponseId, 7);
    assert.equal(handler.isAiSpeaking, true);
    assert.equal(llmAborted, false);
    assert.equal(ttsAborted, false);
    assert.equal(handler.pendingTranscript.length, 0);
    assert.equal(sent.some(({ type }) => type === 'barge_in'), false);
});

test('partial speech and short pauses do not trigger a candidate turn before the silence threshold', async () => {
    const sent = [];
    const handler = new LocalTestHandler(
        { readyState: 1, send: (message) => sent.push(JSON.parse(message)) },
        { sarvam: { sampleRate: 8000, sttMinSpeechDurationMs: 250 }, audio: {}, endOfSpeechMs: 600 },
        { test_call_id: 'pause-test' },
        {},
        () => {},
    );
    let flushed = 0;
    handler.flushTranscript = () => { flushed += 1; };
    handler.speechActive = true;
    handler.pendingTranscript.push({ text: 'I used Redis', language: 'en-IN' });

    await handler.handleSttEvent(JSON.stringify({ event: 'transcript.partial', text: 'I used Redis for caching' }));
    handler.scheduleTranscriptProcessing();
    await wait(300);
    assert.equal(flushed, 0);
    assert.equal(sent.at(-1).type, 'transcript_partial');

    handler.speechActive = false;
    handler.scheduleTranscriptProcessing();
    await wait(300);
    assert.equal(flushed, 0);
    await wait(350);
    assert.equal(flushed, 1);
});

test('creates a call using one signed Laravel request', async () => {
    let request;
    globalThis.fetch = async (url, options) => {
        request = { url, options };
        return jsonResponse(201, { ai_call_id: 23 });
    };

    const config = {
        apiUrl: 'http://127.0.0.1:8000/api/ai-calling/local-test/calls',
        sharedSecret: 'local-test-secret',
    };
    const payload = {
        test_call_id: '61558c86-d587-4a80-ab97-000d3f38c9a5',
        candidate_id: 5,
        initiated_by: 2,
    };
    const result = await createLocalTestCall(config, payload);
    const timestamp = request.options.headers['X-AI-Calling-Timestamp'];

    assert.equal(result.ai_call_id, 23);
    assert.equal(request.url, config.apiUrl);
    assert.equal(request.options.method, 'POST');
    assert.equal(request.options.headers.accept, 'application/json');
    assert.equal(request.options.redirect, 'manual');
    assert.equal(
        request.options.headers['X-AI-Calling-Signature'],
        signWebhookBody(request.options.body, timestamp, config.sharedSecret),
    );
    assert.deepEqual(JSON.parse(request.options.body), payload);
});

test('updates the existing test call ID rather than creating a message record', async () => {
    let request;
    globalThis.fetch = async (url, options) => {
        request = { url, options };
        return jsonResponse(200, { ai_call_id: 23, status: 'in-progress' });
    };

    const config = {
        apiUrl: 'http://127.0.0.1:8000/api/ai-calling/local-test/calls/',
        sharedSecret: 'local-test-secret',
    };
    await updateLocalTestCall(config, '61558c86-d587-4a80-ab97-000d3f38c9a5', {
        status: 'in-progress',
        duration_seconds: 10,
        transcript: 'AI: Hello',
        evaluation: { answers: {} },
        error_message: null,
    });

    assert.equal(
        request.url,
        'http://127.0.0.1:8000/api/ai-calling/local-test/calls/61558c86-d587-4a80-ab97-000d3f38c9a5',
    );
    assert.equal(request.options.method, 'PATCH');
});

test('creates an interview browser session with its linked interview session ID', async () => {
    let requestBody;
    globalThis.fetch = async (_url, options) => {
        requestBody = JSON.parse(options.body);
        return jsonResponse(201, {
            ai_call_id: 23,
            context: { interview: { session_id: 91 } },
        });
    };

    const service = new CallSessionService({
        apiUrl: 'http://127.0.0.1:8000/api/ai-calling/local-test/calls',
        sharedSecret: 'local-test-secret',
    });
    const session = await service.createBrowserSession({
        candidate_id: 5,
        initiated_by: 2,
        browser_mode: 'interview',
        interview_session_id: 91,
        browser_context_expires: 2000000000,
        browser_context_signature: 'a'.repeat(64),
    });

    assert.equal(requestBody.browser_mode, 'interview');
    assert.equal(requestBody.interview_session_id, 91);
    assert.equal(session.context.interview.session_id, 91);
});

test('persists interview transcript without an assessment payload', async () => {
    let persisted;
    const handler = new LocalTestHandler(
        { readyState: 1, send: () => {} },
        { sarvam: { sampleRate: 8000 }, audio: {} },
        { test_call_id: 'test-interview', interview: { session_id: 91 } },
        {
            updateBrowserSession: async (_id, payload) => {
                persisted = payload;
            },
        },
        () => {},
    );
    handler.startedAt = Date.now();
    handler.conversation = { transcript: () => 'Interviewer: Hello\nCandidate: Yes' };

    await handler.persist('in-progress');

    assert.equal(persisted.transcript, 'Interviewer: Hello\nCandidate: Yes');
    assert.equal(Object.hasOwn(persisted, 'evaluation'), false);
});

test('reports missing Laravel schema columns from the API response', async () => {
    globalThis.fetch = async () => ({
        ok: false,
        status: 409,
        headers: new Headers({ 'content-type': 'application/json' }),
        text: async () => JSON.stringify({
            error: 'The ai_calls table is missing required columns.',
            missing_columns: ['transcript', 'evaluation'],
        }),
    });

    await assert.rejects(
        createLocalTestCall({
            apiUrl: 'http://127.0.0.1:8000/api/ai-calling/local-test/calls',
            sharedSecret: 'local-test-secret',
        }, {}),
        (error) => {
            assert.equal(error.statusCode, 409);
            assert.match(error.message, /transcript, evaluation/);
            return true;
        },
    );
});

test('reports Laravel redirects instead of masking the HTML response as invalid JSON', async () => {
    globalThis.fetch = async () => ({
        ok: false,
        status: 302,
        headers: new Headers({ location: '/login', 'content-type': 'text/html; charset=UTF-8' }),
        text: async () => '<html>Redirecting</html>',
    });

    await assert.rejects(
        createLocalTestCall({
            apiUrl: 'http://127.0.0.1:8000/api/ai-calling/local-test/calls',
            sharedSecret: 'local-test-secret',
        }, {}),
        (error) => {
            assert.equal(error.statusCode, 302);
            assert.match(error.message, /HTTP 302/);
            assert.match(error.message, /text\/html/);
            return true;
        },
    );
});
