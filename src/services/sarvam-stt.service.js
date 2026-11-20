import WebSocket from 'ws';

function addKeyterm(terms, seen, value) {
    if (typeof value !== 'string') return;
    const term = value.trim().replace(/^["']|["']$/g, '');
    const key = term.toLocaleLowerCase();
    if (!term || term.length > 64 || seen.has(key) || terms.length >= 50) return;
    seen.add(key);
    terms.push(term);
}

function addSkillTerms(terms, seen, value) {
    if (Array.isArray(value)) {
        for (const item of value) addKeyterm(terms, seen, item);
        return;
    }
    if (typeof value !== 'string') return;

    const trimmed = value.trim();
    if (trimmed.startsWith('[')) {
        try {
            const parsed = JSON.parse(trimmed);
            if (Array.isArray(parsed)) {
                for (const item of parsed) addKeyterm(terms, seen, item);
                return;
            }
        } catch {
            // Treat non-JSON skill strings as delimited text.
        }
    }
    for (const item of trimmed.split(/[,;\n|]+/)) addKeyterm(terms, seen, item);
}

export function buildSttKeyterms({ requisition = {} } = {}) {
    const terms = [];
    const seen = new Set();
    addSkillTerms(terms, seen, requisition.skills);
    return terms;
}

export function connectSarvamStt(config, keyterms = []) {
    const query = new URLSearchParams({
        language_code: 'auto',
        model: config.sttModel,
        stream_type: 'fast',
        mode: 'codemix',
        endpointing: 'vad',
        threshold: String(config.sttVadThreshold ?? 0.3),
        silence_duration_ms: String(config.sttSilenceDurationMs ?? 700),
        min_speech_duration_ms: String(config.sttMinSpeechDurationMs ?? 250),
        encoding: 'linear16',
        sample_rate: String(config.sampleRate),
    });
    if (config.sttModel === 'saaras:v4' && keyterms.length > 0) {
        query.set('keyterms', JSON.stringify(keyterms));
    }
    const socket = new WebSocket(`wss://api.sarvam.ai/speech-to-text-realtime/ws?${query}`, {
        headers: { 'api-subscription-key': config.apiKey },
    });

    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            socket.terminate();
            reject(new Error('Sarvam STT connection timed out.'));
        }, 8000);

        socket.once('open', () => {
            clearTimeout(timer);
            resolve(socket);
        });
        socket.once('error', () => {
            clearTimeout(timer);
            reject(new Error('Sarvam STT connection failed.'));
        });
    });
}

export function sendSarvamAudio(socket, payload) {
    if (socket.readyState !== WebSocket.OPEN) {
        throw new Error('Sarvam STT connection is not open.');
    }

    socket.send(JSON.stringify({ event: 'audio_input', audio: payload }));
}
