export function loadConfig(env = process.env) {
    const bargeIn = {
        enabled: env.BARGE_IN_ENABLED === 'true',
        sensitivity: Number(env.BARGE_IN_SENSITIVITY ?? env.SARVAM_STT_VAD_THRESHOLD ?? 0.3),
        minimumSpeechMs: Number(env.BARGE_IN_MIN_SPEECH_MS ?? env.SARVAM_STT_MIN_SPEECH_DURATION_MS ?? 250),
        silenceTimeoutMs: Number(env.BARGE_IN_SILENCE_TIMEOUT_MS ?? env.SARVAM_STT_SILENCE_DURATION_MS ?? 700),
    };
    const audio = {
        enabled: env.AUDIO_PROCESSING_ENABLED !== 'false',
        noiseSuppression: env.AUDIO_NOISE_SUPPRESSION_ENABLED !== 'false',
        vadEnabled: env.AUDIO_VAD_ENABLED === 'true',
        echoCancellation: env.AUDIO_ECHO_CANCELLATION_ENABLED !== 'false',
        vadThresholdDb: Number(env.AUDIO_VAD_THRESHOLD_DB ?? -42),
    };

    return {
        voiceProvider: env.VOICE_PROVIDER || 'browser',
        port: Number(env.PORT || 3100),
        localTestPort: Number(env.LOCAL_TEST_PORT || 3200),
        llmTimeoutMs: Number(env.LLM_TIMEOUT_MS ?? 25000),
        llmRetries: Number(env.LLM_RETRIES ?? 1),
        silencePromptSeconds: Number(env.SILENCE_PROMPT_SECONDS ?? 8),
        postTtsDelayMs: Number(env.POST_TTS_DELAY_MS ?? 0),
        endOfSpeechMs: Number(env.END_OF_SPEECH_MS ?? 400),
        maxCallDurationSeconds: Number(env.MAX_CALL_DURATION_SECONDS ?? 360),
        websocketPingIntervalMs: Number(env.WEBSOCKET_PING_INTERVAL_MS ?? 30000),
        websocketIdleTimeoutMs: Number(env.WEBSOCKET_IDLE_TIMEOUT_MS ?? 120000),
        sttKeepAliveIntervalMs: Number(env.STT_KEEP_ALIVE_INTERVAL_MS ?? 30000),
        httpKeepAliveTimeoutMs: Number(env.HTTP_KEEP_ALIVE_TIMEOUT_MS ?? 120000),
        serviceToken: env.AI_VOICE_AGENT_TOKEN || '',
        sharedSecret: env.AI_VOICE_AGENT_SHARED_SECRET || '',
        laravelWebhookUrl: env.LARAVEL_WEBHOOK_URL || '',
        bargeIn,
        acknowledgementsEnabled: env.ACK_ENABLED === 'true',
        audio,
        sarvam: {
            apiKey: env.SARVAM_API_KEY || '',
            sttModel: env.SARVAM_STT_MODEL || 'saaras:v4',
            ttsModel: env.SARVAM_TTS_MODEL || 'bulbul:v4-flash',
            ttsSpeaker: env.SARVAM_TTS_SPEAKER || 'ishita_enhi_customer',
            ttsPace: Number(env.SARVAM_TTS_PACE ?? 1.0),
            sampleRate: Number(env.SARVAM_SAMPLE_RATE || ((env.VOICE_PROVIDER || 'browser') === 'exotel' ? 8000 : 16000)),
            sttVadThreshold: bargeIn.sensitivity,
            sttSilenceDurationMs: bargeIn.silenceTimeoutMs,
            sttMinSpeechDurationMs: bargeIn.minimumSpeechMs,
            llmModel: env.SARVAM_LLM_MODEL || 'sarvam-105b-conversations',
        },
        exotel: {
            enabled: env.ENABLE_EXOTEL_AGENTSTREAM === 'true',
            baseUrl: env.EXOTEL_BASE_URL || 'https://api.in.exotel.com',
            accountSid: env.EXOTEL_ACCOUNT_SID || '',
            apiKey: env.EXOTEL_API_KEY || '',
            apiToken: env.EXOTEL_API_TOKEN || '',
            callerId: env.EXOTEL_CALLER_ID || '',
            flowId: env.EXOTEL_FLOW_ID || '',
            region: env.EXOTEL_REGION || '',
        },
    };
}

export function assertRequiredConfig(config) {
    const required = [
        ['AI_VOICE_AGENT_TOKEN', config.serviceToken],
        ['AI_VOICE_AGENT_SHARED_SECRET', config.sharedSecret],
        ['LARAVEL_WEBHOOK_URL', config.laravelWebhookUrl],
        ['EXOTEL_ACCOUNT_SID', config.exotel.accountSid],
        ['EXOTEL_API_KEY', config.exotel.apiKey],
        ['EXOTEL_API_TOKEN', config.exotel.apiToken],
        ['EXOTEL_CALLER_ID', config.exotel.callerId],
        ['SARVAM_API_KEY', config.sarvam.apiKey],
    ];
    const missing = required.filter(([, value]) => !value).map(([name]) => name);

    if (missing.length) {
        throw new Error(`Missing required voice-agent configuration: ${missing.join(', ')}`);
    }

    assertRuntimeConfig(config);

    if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65535) {
        throw new Error('PORT must be a valid TCP port.');
    }
    if (![8000, 16000].includes(config.sarvam.sampleRate)) {
        throw new Error('SARVAM_SAMPLE_RATE must be 8000 or 16000.');
    }
    if (!Number.isFinite(config.bargeIn.sensitivity)
        || config.bargeIn.sensitivity < 0
        || config.bargeIn.sensitivity > 1) {
        throw new Error('BARGE_IN_SENSITIVITY must be between 0 and 1.');
    }
    if (!Number.isInteger(config.bargeIn.minimumSpeechMs)
        || config.bargeIn.minimumSpeechMs < 100
        || config.bargeIn.minimumSpeechMs > 2000) {
        throw new Error('BARGE_IN_MIN_SPEECH_MS must be an integer between 100 and 2000.');
    }
    if (!Number.isInteger(config.bargeIn.silenceTimeoutMs)
        || config.bargeIn.silenceTimeoutMs < 200
        || config.bargeIn.silenceTimeoutMs > 3000) {
        throw new Error('BARGE_IN_SILENCE_TIMEOUT_MS must be an integer between 200 and 3000.');
    }
    if (!Number.isFinite(config.audio.vadThresholdDb)
        || config.audio.vadThresholdDb < -100
        || config.audio.vadThresholdDb > 0) {
        throw new Error('AUDIO_VAD_THRESHOLD_DB must be between -100 and 0 dBFS.');
    }

    try {
        const webhookUrl = new URL(config.laravelWebhookUrl);
        if (webhookUrl.protocol !== 'https:' && webhookUrl.hostname !== 'localhost' && webhookUrl.hostname !== '127.0.0.1') {
            throw new Error();
        }
    } catch {
        throw new Error('LARAVEL_WEBHOOK_URL must use HTTPS (HTTP is allowed only for localhost).');
    }

    try {
        const exotelUrl = new URL(config.exotel.baseUrl);
        if (exotelUrl.protocol !== 'https:') {
            throw new Error();
        }
    } catch {
        throw new Error('EXOTEL_BASE_URL must use HTTPS.');
    }
}

export function assertRuntimeConfig(config) {
    if (!Number.isInteger(config.llmTimeoutMs) || config.llmTimeoutMs < 1000 || config.llmTimeoutMs > 120000) {
        throw new Error('LLM_TIMEOUT_MS must be an integer between 1000 and 120000.');
    }
    if (!Number.isInteger(config.llmRetries) || config.llmRetries < 0 || config.llmRetries > 3) {
        throw new Error('LLM_RETRIES must be an integer between 0 and 3.');
    }
    if (!Number.isFinite(config.sarvam.ttsPace)
        || config.sarvam.ttsPace < 0.5
        || config.sarvam.ttsPace > 2.0) {
        throw new Error('SARVAM_TTS_PACE must be between 0.5 and 2.0.');
    }
    if (!Number.isInteger(config.postTtsDelayMs) || config.postTtsDelayMs < 0 || config.postTtsDelayMs > 5000) {
        throw new Error('POST_TTS_DELAY_MS must be an integer between 0 and 5000.');
    }
    if (!Number.isInteger(config.endOfSpeechMs) || config.endOfSpeechMs < 200 || config.endOfSpeechMs > 3000) {
        throw new Error('END_OF_SPEECH_MS must be an integer between 200 and 3000.');
    }
    if (!Number.isInteger(config.silencePromptSeconds) || config.silencePromptSeconds < 3 || config.silencePromptSeconds > 60) {
        throw new Error('SILENCE_PROMPT_SECONDS must be an integer between 3 and 60.');
    }
    if (!Number.isInteger(config.maxCallDurationSeconds) || config.maxCallDurationSeconds < 60 || config.maxCallDurationSeconds > 14400) {
        throw new Error('MAX_CALL_DURATION_SECONDS must be an integer between 60 and 14400.');
    }
    if (!Number.isInteger(config.websocketPingIntervalMs) || config.websocketPingIntervalMs < 5000) {
        throw new Error('WEBSOCKET_PING_INTERVAL_MS must be an integer of at least 5000.');
    }
    if (!Number.isInteger(config.websocketIdleTimeoutMs)
        || config.websocketIdleTimeoutMs < config.websocketPingIntervalMs * 2) {
        throw new Error('WEBSOCKET_IDLE_TIMEOUT_MS must be at least twice WEBSOCKET_PING_INTERVAL_MS.');
    }
    if (!Number.isInteger(config.sttKeepAliveIntervalMs) || config.sttKeepAliveIntervalMs < 10000) {
        throw new Error('STT_KEEP_ALIVE_INTERVAL_MS must be an integer of at least 10000.');
    }
    if (!Number.isInteger(config.httpKeepAliveTimeoutMs) || config.httpKeepAliveTimeoutMs < 60000) {
        throw new Error('HTTP_KEEP_ALIVE_TIMEOUT_MS must be an integer of at least 60000.');
    }
}
