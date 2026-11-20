import { decodeWavPcm16, resamplePcm16 } from '../utils/audio-utils.js';

function assertTtsInput(text) {
    if (!text || text.length > 2500) {
        throw new Error('TTS text must contain between 1 and 2500 characters.');
    }
}

function makeTtsPayload(config, text, languageCode, outputAudioCodec) {
    return {
        text,
        model: config.ttsModel,
        speaker: config.ttsSpeaker,
        language_code: languageCode,
        speech_sample_rate: config.sampleRate,
        output_audio_codec: outputAudioCodec,
        pace: config.ttsPace ?? 1.0,
        enable_preprocessing: true,
    };
}

async function requestSpeech(config, text, languageCode, outputAudioCodec, signal, streaming) {
    let response;
    try {
        response = await fetch(`https://api.sarvam.ai/text-to-speech${streaming ? '/stream' : ''}`, {
            method: 'POST',
            headers: {
                'api-subscription-key': config.apiKey,
                'content-type': 'application/json',
            },
            body: JSON.stringify(makeTtsPayload(config, text, languageCode, outputAudioCodec)),
            signal: signal
                ? AbortSignal.any([signal, AbortSignal.timeout(20000)])
                : AbortSignal.timeout(20000),
        });
    } catch (error) {
        if (signal?.aborted) {
            throw signal.reason ?? error;
        }
        if (error.name === 'TimeoutError') {
            throw new Error('Sarvam TTS request timed out after 20 seconds.');
        }
        throw new Error(`Sarvam TTS request failed: ${error.message}`);
    }

    if (!response.ok) {
        const detail = (await response.text()).slice(0, 500);
        throw new Error(`Sarvam TTS request failed with HTTP ${response.status}${detail ? `: ${detail}` : '.'}`);
    }
    return response;
}

export async function synthesizeSpeech(config, text, languageCode, signal) {
    assertTtsInput(text);

    const response = await requestSpeech(config, text, languageCode, 'wav', signal, false);

    let payload;
    try {
        payload = await response.json();
    } catch {
        throw new Error('Sarvam TTS returned an invalid JSON response.');
    }
    if (!Array.isArray(payload.audios) || !payload.audios.length || payload.audios.some((audio) => typeof audio !== 'string')) {
        throw new Error('Sarvam TTS returned an invalid audio response.');
    }

    const wav = Buffer.from(payload.audios.join(''), 'base64');
    if (!wav.length) {
        throw new Error('Sarvam TTS returned empty audio data.');
    }
    const decoded = decodeWavPcm16(wav);
    if (decoded.pcm.length === 0) {
        throw new Error('Sarvam TTS returned a WAV file with no speech audio.');
    }

    return resamplePcm16(decoded.pcm, decoded.sampleRate, config.sampleRate);
}

export async function* streamSpeech(config, text, languageCode, signal) {
    assertTtsInput(text);
    const response = await requestSpeech(config, text, languageCode, 'linear16', signal, true);
    if (!response.body) {
        throw new Error('Sarvam TTS returned no streaming audio body.');
    }

    const reader = response.body.getReader();
    let receivedAudio = false;
    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) {
                break;
            }
            if (value?.byteLength) {
                receivedAudio = true;
                yield Buffer.from(value);
            }
        }
    } catch (error) {
        if (signal?.aborted) {
            throw signal.reason ?? error;
        }
        if (error.name === 'TimeoutError') {
            throw new Error('Sarvam TTS stream timed out after 20 seconds.');
        }
        throw new Error(`Sarvam TTS stream failed: ${error.message}`);
    } finally {
        reader.releaseLock();
    }

    if (!receivedAudio) {
        throw new Error('Sarvam TTS returned an empty audio stream.');
    }
}
