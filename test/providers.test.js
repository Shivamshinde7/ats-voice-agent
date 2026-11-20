import test from 'node:test';
import assert from 'node:assert/strict';
import { assertRuntimeConfig, loadConfig } from '../src/config/env.js';
import { ExotelProvider } from '../src/providers/ExotelProvider.js';
import { hangupExotelCall } from '../src/services/exotel.service.js';
import { SarvamSTTService } from '../src/services/SarvamSTTService.js';
import { SarvamTTSService } from '../src/services/SarvamTTSService.js';
import { buildSttKeyterms } from '../src/services/sarvam-stt.service.js';
import { streamSpeech } from '../src/services/sarvam-tts.service.js';
import { VoiceHandler } from '../src/websocket/voice-handler.js';

test('browser is the default provider and does not require Exotel credentials', () => {
    const config = loadConfig({
        SARVAM_API_KEY: 'test-key',
    });

    assert.equal(config.voiceProvider, 'browser');
    assert.equal(config.exotel.enabled, false);
    assert.equal(config.exotel.apiKey, '');
    assert.equal(config.localTestPort, 3200);
    assert.equal(config.llmTimeoutMs, 25000);
    assert.equal(config.silencePromptSeconds, 8);
    assert.equal(config.maxCallDurationSeconds, 360);
    assert.equal(config.postTtsDelayMs, 0);
    assert.equal(config.endOfSpeechMs, 400);
    assert.equal(config.websocketPingIntervalMs, 30000);
    assert.equal(config.websocketIdleTimeoutMs, 120000);
    assert.equal(config.sarvam.ttsSpeaker, 'ishita_enhi_customer');
    assert.equal(config.sarvam.ttsPace, 1);
    assert.equal(config.sarvam.sttSilenceDurationMs, 700);
    assert.equal(config.sarvam.sttMinSpeechDurationMs, 250);
    assert.deepEqual(config.bargeIn, {
        enabled: false,
        sensitivity: 0.3,
        minimumSpeechMs: 250,
        silenceTimeoutMs: 700,
    });
    assert.equal(config.audio.enabled, true);
    assert.equal(config.audio.noiseSuppression, true);
    assert.equal(config.audio.vadEnabled, false);
    assert.equal(config.audio.echoCancellation, true);
    assert.equal(config.audio.vadThresholdDb, -42);
});

test('half-duplex, acknowledgement, and provider sample-rate defaults can be configured', () => {
    const defaults = loadConfig({});
    assert.equal(defaults.bargeIn.enabled, false);
    assert.equal(defaults.acknowledgementsEnabled, false);
    assert.equal(defaults.sarvam.sampleRate, 16000);
    assert.equal(loadConfig({ VOICE_PROVIDER: 'exotel' }).sarvam.sampleRate, 8000);

    const enabled = loadConfig({ BARGE_IN_ENABLED: 'true', ACK_ENABLED: 'true' });
    assert.equal(enabled.bargeIn.enabled, true);
    assert.equal(enabled.acknowledgementsEnabled, true);
});

test('Saaras v4 STT keyterms use skills only and omit duplicates or oversized values', () => {
    assert.deepEqual(buildSttKeyterms({
        requisition: {
            job_title: 'Senior Engineer',
            department: 'Engineering',
            skills: JSON.stringify(['Java', 'Node.js', 'Java', 'A'.repeat(65)]),
        },
        companyName: 'Example Hiring',
    }), ['Java', 'Node.js']);
});

test('Bulbul speaking pace is configurable within the v4 Flash supported range', () => {
    const config = loadConfig({ SARVAM_TTS_PACE: '1.1' });
    assert.equal(config.sarvam.ttsPace, 1.1);
    assert.doesNotThrow(() => assertRuntimeConfig(config));
    assert.throws(
        () => assertRuntimeConfig(loadConfig({ SARVAM_TTS_PACE: '2.1' })),
        /SARVAM_TTS_PACE must be between 0.5 and 2.0/,
    );
});

test('Sarvam Bulbul streaming requests raw PCM at the configured sample rate and pace', async () => {
    const originalFetch = globalThis.fetch;
    let request;
    globalThis.fetch = async (url, options) => {
        request = { url: String(url), options };
        return new Response(new ReadableStream({
            start(controller) {
                controller.enqueue(new Uint8Array([1, 2, 3, 4]));
                controller.enqueue(new Uint8Array([5, 6, 7, 8]));
                controller.close();
            },
        }), { status: 200 });
    };

    try {
        const chunks = [];
        for await (const chunk of streamSpeech({
            apiKey: 'offline-test-key',
            ttsModel: 'bulbul:v4-flash',
            ttsSpeaker: 'ishita_enhi_customer',
            sampleRate: 8000,
            ttsPace: 1.05,
        }, 'नमस्ते', 'hi-IN')) {
            chunks.push(chunk);
        }

        assert.deepEqual(Buffer.concat(chunks), Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]));
    } finally {
        globalThis.fetch = originalFetch;
    }

    assert.equal(request.url, 'https://api.sarvam.ai/text-to-speech/stream');
    assert.equal(request.options.method, 'POST');
    assert.deepEqual(JSON.parse(request.options.body), {
        text: 'नमस्ते',
        model: 'bulbul:v4-flash',
        speaker: 'ishita_enhi_customer',
        language_code: 'hi-IN',
        speech_sample_rate: 8000,
        output_audio_codec: 'linear16',
        pace: 1.05,
        enable_preprocessing: true,
    });
});

test('STT VAD settings and playback timing can be configured from the environment', () => {
    const config = loadConfig({
        BARGE_IN_SENSITIVITY: '0.55',
        BARGE_IN_MIN_SPEECH_MS: '400',
        BARGE_IN_SILENCE_TIMEOUT_MS: '700',
        POST_TTS_DELAY_MS: '500',
        END_OF_SPEECH_MS: '900',
    });

    assert.deepEqual(config.bargeIn, {
        enabled: false,
        sensitivity: 0.55,
        minimumSpeechMs: 400,
        silenceTimeoutMs: 700,
    });
    assert.equal(config.postTtsDelayMs, 500);
    assert.equal(config.endOfSpeechMs, 900);
    assert.equal(config.sarvam.sttVadThreshold, 0.55);
    assert.equal(config.sarvam.sttMinSpeechDurationMs, 400);
    assert.equal(config.sarvam.sttSilenceDurationMs, 700);
});

test('English and Hindi acknowledgement audio is prepared and reused for turns', async () => {
    const service = new SarvamTTSService({
        ttsModel: 'test-acknowledgements',
        ttsSpeaker: 'test-speaker',
        sampleRate: 8000,
    });
    const synthesized = [];
    service.synthesize = async (text, languageCode) => {
        synthesized.push({ text, languageCode });
        return Buffer.from(`${languageCode}:${text}`);
    };

    await service.prepareAcknowledgements();
    assert.equal(synthesized.length, 8);
    assert.equal(service.preparedAcknowledgement('en-IN', 0).text, 'Okay, got it.');
    assert.equal(service.preparedAcknowledgement('en-IN', 1).text, 'Right, I see.');
    assert.equal(service.preparedAcknowledgement('hi-IN', 0).text, 'ठीक है, समझ गई।');
    assert.equal(service.preparedAcknowledgement('en-IN', 2), null);
    assert.equal(service.preparedAcknowledgement('ta-IN', 0), null);
    assert.deepEqual(
        service.preparedAcknowledgement('hi-IN', 0).pcm,
        Buffer.from('hi-IN:ठीक है, समझ गई।'),
    );
});

test('Exotel candidate speech stops recruiter media when the transcript confirms it', async () => {
    const sent = [];
    const socket = {
        readyState: 1,
        send: (message) => sent.push(JSON.parse(message)),
    };
    const handler = new VoiceHandler(
        socket,
        {
            bargeIn: { minimumSpeechMs: 100 },
            sarvam: {},
            audio: {},
            endOfSpeechMs: 200,
        },
        { ai_call_id: 23 },
        async () => {},
    );
    handler.streamSid = 'stream-1';
    handler.activeResponseId = 4;
    handler.isAiSpeaking = true;
    handler.lastAiText = 'Tell me about your recent experience.';
    handler.activeTurnCheckpoint = {};
    handler.activeTurnText = 'My experience is in Kubernetes.';
    let llmAborted = false;
    let ttsAborted = false;
    handler.activeLlmController = { abort: () => { llmAborted = true; } };
    handler.activeTtsController = { abort: () => { ttsAborted = true; } };

    await handler.handleSttEvent(JSON.stringify({ event: 'vad.speech_start' }));
    assert.equal(handler.activeResponseId, 4);
    await handler.handleSttEvent(JSON.stringify({ event: 'transcript.final', text: 'great' }));

    assert.equal(handler.isAiSpeaking, false);
    assert.equal(handler.activeResponseId, null);
    assert.equal(llmAborted, true);
    assert.equal(ttsAborted, true);
    assert.equal(handler.transcriptBuffer.length, 1);
    assert.equal(handler.transcriptBuffer[0].text, 'My experience is in Kubernetes. great');
    assert.equal(handler.transcriptBuffer[0].duringAiSpeech, false);
    assert.deepEqual(sent, [{ event: 'clear', stream_sid: 'stream-1' }]);
});

test('Exotel streams PCM packets and clears queued speech when interrupted', async () => {
    const sent = [];
    const handler = new VoiceHandler(
        {
            readyState: 1,
            send: (message) => sent.push(JSON.parse(message)),
        },
        {
            sarvam: { sampleRate: 16000 },
            audio: {},
            postTtsDelayMs: 0,
        },
        { ai_call_id: 23 },
        async () => {},
    );
    handler.streamSid = 'stream-2';
    handler.ttsService.stream = (_text, _language, signal) => (async function* () {
        yield Buffer.alloc(3200);
        await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
        if (!signal.aborted) yield Buffer.alloc(3200);
    }());

    const speaking = handler.speak('Hello there.', 'en-IN');
    const timeoutAt = Date.now() + 1000;
    while (!sent.some(({ event }) => event === 'media') && Date.now() < timeoutAt) {
        await new Promise((resolve) => setTimeout(resolve, 1));
    }
    assert.equal(sent[0]?.event, 'media');
    assert.equal(Buffer.from(sent[0].media.payload, 'base64').length, 3200);

    handler.interruptPlayback('candidate_speech');
    await speaking;

    assert.deepEqual(sent.map(({ event }) => event), ['media', 'clear']);
});

test('Exotel interrupts on a non-echo partial without waiting for transcript finalization', async () => {
    const handler = new VoiceHandler(
        { readyState: 1, send: () => {} },
        { bargeIn: { minimumSpeechMs: 1000 }, sarvam: {}, audio: {} },
        { ai_call_id: 23 },
        async () => {},
    );
    handler.activeResponseId = 4;
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
        text: 'I want to ask something',
    }));

    assert.equal(handler.activeResponseId, null);
    assert.equal(handler.isAiSpeaking, false);
    assert.equal(llmAborted, true);
    assert.equal(ttsAborted, true);
});

test('Exotel recruiter echo does not interrupt playback or cancel an LLM turn', async () => {
    const handler = new VoiceHandler(
        { readyState: 1, send: () => {} },
        { bargeIn: { minimumSpeechMs: 100 }, sarvam: {}, audio: {} },
        { ai_call_id: 23 },
        async () => {},
    );
    handler.activeResponseId = 4;
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
        text: 'Tell me about your recent experience',
    }));
    await handler.handleSttEvent(JSON.stringify({
        event: 'transcript.final',
        text: 'Tell me about your recent experience',
    }));

    assert.equal(handler.activeResponseId, 4);
    assert.equal(handler.isAiSpeaking, true);
    assert.equal(llmAborted, false);
    assert.equal(ttsAborted, false);
    assert.equal(handler.transcriptBuffer.length, 0);
});

test('audio processing controls can be configured from the environment', () => {
    const config = loadConfig({
        AUDIO_PROCESSING_ENABLED: 'false',
        AUDIO_NOISE_SUPPRESSION_ENABLED: 'false',
        AUDIO_VAD_ENABLED: 'false',
        AUDIO_ECHO_CANCELLATION_ENABLED: 'false',
        AUDIO_VAD_THRESHOLD_DB: '-38',
    });

    assert.deepEqual(config.audio, {
        enabled: false,
        noiseSuppression: false,
        vadEnabled: false,
        echoCancellation: false,
        vadThresholdDb: -38,
    });
});

test('Sarvam STT keepalive uses a WebSocket ping frame', () => {
    let pinged = false;
    let sent = false;
    const socket = {
        readyState: 1,
        ping: () => { pinged = true; },
        send: () => { sent = true; },
    };

    new SarvamSTTService({}).keepAlive(socket);

    assert.equal(pinged, true);
    assert.equal(sent, false);
});

test('Exotel provider fails closed until AgentStream is explicitly enabled', async () => {
    const provider = new ExotelProvider({
        exotel: { enabled: false },
    });

    await assert.rejects(provider.start(), /Exotel AgentStream mode is pending configuration/);
});

test('Exotel call hang-up updates the provider call after speech playback', async () => {
    const originalFetch = globalThis.fetch;
    let request;
    globalThis.fetch = async (url, options) => {
        request = { url: String(url), options };
        return { ok: true, status: 200 };
    };

    try {
        await hangupExotelCall({
            baseUrl: 'https://api.in.exotel.com',
            accountSid: 'account',
            apiKey: 'key',
            apiToken: 'token',
        }, 'CA/123');
    } finally {
        globalThis.fetch = originalFetch;
    }

    assert.equal(request.options.method, 'PUT');
    assert.equal(request.url, 'https://api.in.exotel.com/v1/Accounts/account/Calls/CA%2F123.json');
    assert.equal(request.options.body.get('Status'), 'completed');
});

test('completed Exotel calls hang up only once before reporting the result', async () => {
    const originalFetch = globalThis.fetch;
    let hangupCount = 0;
    globalThis.fetch = async () => {
        hangupCount += 1;
        return { ok: true, status: 200 };
    };

    const reported = [];
    const handler = new VoiceHandler(
        { readyState: 3 },
        {
            exotel: {
                baseUrl: 'https://api.in.exotel.com',
                accountSid: 'account',
                apiKey: 'key',
                apiToken: 'token',
            },
            sarvam: {},
            audio: {},
        },
        { ai_call_id: 23 },
        async (result) => reported.push(result),
    );
    handler.providerCallId = 'CA123';
    handler.endCallRequested = true;
    handler.conversation = {
        result: () => ({ summary: 'Screening summary.' }),
        canSummarize: false,
        transcript: () => 'AI: Thank you.',
        messages: [],
    };

    try {
        await handler.finish('completed');
        await handler.finish('completed');
    } finally {
        globalThis.fetch = originalFetch;
    }

    assert.equal(hangupCount, 1);
    assert.equal(reported.length, 1);
    assert.equal(reported[0].status, 'completed');
});
