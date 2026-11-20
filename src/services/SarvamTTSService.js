import { streamSpeech, synthesizeSpeech } from './sarvam-tts.service.js';

const ACKNOWLEDGEMENTS = {
    'en-IN': ['Okay, got it.', 'Right, I see.', 'That’s helpful, thank you.', 'Understood.'],
    'hi-IN': ['ठीक है, समझ गई।', 'अच्छा, समझ गई।', 'समझ गई, धन्यवाद।', 'ठीक है।'],
};
const preparedAudio = new Map();

export class SarvamTTSService {
    constructor(config) {
        this.config = config;
        this.acknowledgements = new Map();
    }

    synthesize(text, languageCode, signal) {
        return synthesizeSpeech(this.config, text, languageCode, signal);
    }

    stream(text, languageCode, signal) {
        return streamSpeech(this.config, text, languageCode, signal);
    }

    prepareAcknowledgements() {
        const tasks = [];
        for (const [languageCode, phrases] of Object.entries(ACKNOWLEDGEMENTS)) {
            for (const text of phrases) {
                const key = this.cacheKey(languageCode, text);
                let audio = preparedAudio.get(key);
                if (!audio) {
                    audio = this.synthesize(text, languageCode).catch((error) => {
                        preparedAudio.delete(key);
                        throw error;
                    });
                    preparedAudio.set(key, audio);
                }
                const task = audio.then((pcm) => {
                    this.acknowledgements.set(key, pcm);
                });
                tasks.push(task);
            }
        }
        return Promise.all(tasks);
    }

    preparedAcknowledgement(languageCode, turnNumber) {
        if (turnNumber % 3 === 2) return null;
        if (!Object.hasOwn(ACKNOWLEDGEMENTS, languageCode)) return null;
        const language = languageCode;
        const phrases = ACKNOWLEDGEMENTS[language];
        const text = phrases[Math.abs(turnNumber) % phrases.length];
        const pcm = this.acknowledgements.get(this.cacheKey(language, text));
        return pcm ? { text, pcm } : null;
    }

    cacheKey(languageCode, text) {
        return [
            this.config.ttsModel,
            this.config.ttsSpeaker,
            this.config.ttsPace ?? 1.0,
            this.config.sampleRate,
            languageCode,
            text,
        ].join(':');
    }
}
