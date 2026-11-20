import WebSocket from 'ws';
import { makeExotelMediaEvent } from '../services/audio-processor.service.js';
import { hangupExotelCall } from '../services/exotel.service.js';
import { ConversationService } from '../services/ConversationService.js';
import { SarvamLLMService } from '../services/SarvamLLMService.js';
import { SarvamInterviewLLMService } from '../services/SarvamInterviewLLMService.js';
import { SarvamSTTService } from '../services/SarvamSTTService.js';
import { SarvamTTSService } from '../services/SarvamTTSService.js';
import { InterviewAgent } from '../agents/interview-agent.js';
import { InboundAudioProcessor } from '../services/inbound-audio-processor.service.js';
import { packetizePcm16Stream } from '../utils/audio-utils.js';
import { shouldHangUp } from '../agents/RecruitmentPrompt.js';
import { asksQuestion, cleanCandidateTranscript, isBackchannelOnly, matchesAiSpeech } from '../utils/conversation-turn.js';

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const SILENCE_PROMPT = "I'm still here, can you hear me okay?";

export class VoiceHandler {
    constructor(socket, config, callContext, reportResult) {
        this.socket = socket;
        this.config = config;
        this.callContext = callContext;
        this.reportResult = reportResult;
        this.sttService = new SarvamSTTService(config.sarvam);
        this.ttsService = new SarvamTTSService(config.sarvam);
        this.audioProcessor = new InboundAudioProcessor(config.audio, config.sarvam.sampleRate);
        this.streamSid = null;
        this.providerCallId = null;
        this.callStartedAt = null;
        this.stt = null;
        this.conversation = null;
        this.audioQueue = [];
        this.turnQueue = Promise.resolve();
        this.activeLlmController = null;
        this.activeTtsController = null;
        this.responseSequence = 0;
        this.activeResponseId = null;
        this.isAiSpeaking = false;
        this.interruptionCount = 0;
        this.failedTurnCount = 0;
        this.lastAiText = '';
        this.aiAskedQuestion = false;
        this.transcriptBuffer = [];
        this.interruptedTurnText = null;
        this.activeTurnCheckpoint = null;
        this.activeTurnText = null;
        this.activeTurnInterrupted = false;
        this.transcriptTimer = null;
        this.speechActive = false;
        this.speechStartedAt = null;
        this.speechStartedDuringAiSpeech = false;
        this.speechStartedDuringAiTurn = false;
        this.silencePromptTimer = null;
        this.unansweredPrompts = 0;
        this.lastLanguageCode = 'en-IN';
        this.lastSocketPongAt = Date.now();
        this.finished = false;
        this.completionPending = false;
        this.endCallRequested = false;
        this.hangupPromise = null;
        this.isInterview = Boolean(callContext.interview);
    }

    attach() {
        this.socket.on('message', (data) => {
            this.handleExotelEvent(data.toString()).catch((error) => this.reportFailure(error));
        });
        this.socket.once('close', (code) => {
            if (!this.finished) {
                console.warn('Recruitment WebSocket closed', {
                    reason: code === 1000 ? 'remote_stream_closed' : 'websocket_disconnected',
                });
                this.finish('completed').catch((error) => this.logFailure(error));
            }
        });
        this.socket.on('error', (error) => this.reportFailure(error));
        this.socket.on('pong', () => {
            this.lastSocketPongAt = Date.now();
        });
        this.socketHeartbeat = setInterval(() => {
            if (this.finished || this.socket.readyState !== WebSocket.OPEN) return;
            if (Date.now() - this.lastSocketPongAt > this.config.websocketIdleTimeoutMs) {
                console.warn('Recruitment WebSocket idle timeout', { reason: 'websocket_idle_timeout' });
                this.socket.terminate();
                return;
            }
            try {
                this.socket.ping();
            } catch (error) {
                this.logFailure(error);
            }
        }, this.config.websocketPingIntervalMs);
    }

    async handleExotelEvent(raw) {
        const event = JSON.parse(raw);
        if (this.finished || this.finishing) {
            return;
        }
        if (event.event === 'start') {
            await this.start(event.start);
        } else if (event.event === 'media') {
            if (this.completionPending) return;
            const pcm = Buffer.from(event.media.payload, 'base64');
            const filtered = this.audioProcessor.process(pcm);
            if (filtered.length === 0) {
                return;
            }
            const muted = this.config.bargeIn?.enabled === false
                && (this.isAiSpeaking || this.activeResponseId !== null);
            const processed = muted ? Buffer.alloc(filtered.length) : filtered;
            const payload = processed.toString('base64');
            if (this.stt?.readyState === WebSocket.OPEN) {
                this.sttService.sendAudio(this.stt, payload);
            } else if (this.audioQueue.length < 100) {
                this.audioQueue.push(payload);
            } else {
                throw new Error('Speech recognition startup exceeded the audio buffer limit.');
            }
        } else if (event.event === 'stop') {
            console.info('Recruitment call ended by telephony provider', { reason: 'remote_stop_event' });
            await this.finish('completed');
        }
    }

    async start(startEvent) {
        if (!startEvent?.stream_sid || !startEvent?.call_sid) {
            throw new Error('Exotel start event is missing stream or call identifiers.');
        }
        const format = startEvent.media_format || {};
        if (format.encoding !== 'audio/x-raw' || Number(format.bit_rate) !== 16
            || Number(format.sample_rate) !== this.config.sarvam.sampleRate
            || (format.channels !== undefined && Number(format.channels) !== 1)) {
            throw new Error('Exotel audio format does not match the configured 16-bit PCM sample rate.');
        }

        this.streamSid = startEvent.stream_sid;
        this.providerCallId = startEvent.call_sid;
        this.callStartedAt = Date.now();
        this.callDurationTimer = setTimeout(() => {
            if (this.completionPending) return;
            const end = { end_call: true, end_reason: 'max_duration_reached' };
            if (shouldHangUp(end, this.conversation?.elapsedSeconds() ?? 0)) {
                console.warn('Recruitment call hang-up', { reason: 'max_duration_reached' });
                this.endCallRequested = true;
                this.finish('completed').catch((error) => this.logFailure(error));
            }
        }, this.config.maxCallDurationSeconds * 1000);
        this.stt = await this.sttService.connect({
            requisition: this.callContext.requisition,
            companyName: this.callContext.company_name,
        });
        this.stt.on('message', (message) => {
            this.handleSttEvent(message.toString()).catch((error) => this.reportFailure(error));
        });
        this.stt.on('error', (error) => this.reportFailure(error));
        this.sttKeepalive = setInterval(() => {
            if (this.stt?.readyState === WebSocket.OPEN) {
                this.sttService.keepAlive(this.stt);
            }
        }, this.config.sttKeepAliveIntervalMs);

        for (const payload of this.audioQueue.splice(0)) {
            this.sttService.sendAudio(this.stt, payload);
        }

        if (this.isInterview) {
            this.conversation = new InterviewAgent({
                llm: new SarvamInterviewLLMService({
                    ...this.config.sarvam,
                    timeoutMs: this.config.llmTimeoutMs,
                }),
                context: this.callContext.interview,
                questions: this.callContext.interview.questions,
            });
        } else {
            const llm = new SarvamLLMService(this.config.sarvam);
            this.conversation = new ConversationService({
                llm,
                candidate: this.callContext.candidate,
                requisition: this.callContext.requisition,
                companyName: this.callContext.company_name,
                questions: this.callContext.screening_questions,
                llmTimeoutMs: this.config.llmTimeoutMs,
                llmRetries: this.config.llmRetries,
            });
        }
        await this.reportResult({
            ai_call_id: this.callContext.ai_call_id,
            provider_call_id: this.providerCallId,
            status: 'in-progress',
        });
        const opening = await this.conversation.start();
        if (this.isInterview) {
            await this.reportResult({
                ai_call_id: this.callContext.ai_call_id,
                provider_call_id: this.providerCallId,
                status: 'in-progress',
                transcript: this.conversation.transcript(),
            });
        }
        await this.speakSafely(opening.reply, opening.languageCode || 'en-IN');
    }

    async handleSttEvent(raw) {
        const event = JSON.parse(raw);
        if (this.finished || this.finishing || this.completionPending) {
            return;
        }

        if (event.event === 'transcript.partial') {
            if (this.speechStartedDuringAiTurn && event.text?.trim()) {
                if (!this.speechStartedDuringAiSpeech || !matchesAiSpeech(event.text, this.lastAiText)) {
                    this.interruptOnCandidatePartial();
                }
            }
        } else if (event.event === 'vad.speech_start') {
            clearTimeout(this.silencePromptTimer);
            this.silencePromptTimer = null;
            this.speechActive = true;
            this.speechStartedAt = Date.now();
            this.speechStartedDuringAiSpeech = this.config.bargeIn?.enabled !== false && (this.isAiSpeaking || this.activeResponseId !== null);
            this.speechStartedDuringAiTurn = this.speechStartedDuringAiSpeech || this.activeLlmController !== null;
            clearTimeout(this.transcriptTimer);
            this.transcriptTimer = null;
        } else if (event.event === 'vad.speech_end') {
            this.speechActive = false;
            this.speechStartedAt = null;
            this.armSilencePrompt();
            this.scheduleTranscriptProcessing();
        } else if (event.event === 'transcript.final' && event.text?.trim()) {
            const text = cleanCandidateTranscript(event.text, [
                this.callContext.company_name,
                this.callContext.requisition?.job_title,
                this.callContext.requisition?.department,
            ]);
            if (!text) {
                console.info('Ignored filler or noise transcript', { transcript: event.text, timestamp: Date.now() });
                return;
            }
            if ((this.isAiSpeaking || this.speechStartedDuringAiSpeech)
                && matchesAiSpeech(text, this.lastAiText)) {
                this.interruptedTurnText = null;
                this.speechStartedDuringAiTurn = false;
                console.info('Ignored candidate transcript matching recruiter speech', {
                    transcript: text,
                    timestamp: Date.now(),
                });
                this.speechStartedDuringAiSpeech = false;
                return;
            }
            if (this.speechStartedDuringAiTurn) {
                this.interruptForCandidateSpeech();
            }
            const turnText = this.interruptedTurnText
                ? `${this.interruptedTurnText} ${text}`
                : text;
            this.interruptedTurnText = null;
            this.transcriptBuffer.push({
                text: turnText,
                timestamp: Date.now(),
                language: event.language || 'en-IN',
                duringAiSpeech: false,
            });
            this.speechStartedDuringAiSpeech = false;
            this.speechStartedDuringAiTurn = false;
            console.info('Buffered candidate transcript', this.transcriptBuffer.at(-1));
            clearTimeout(this.silencePromptTimer);
            this.silencePromptTimer = null;
            this.unansweredPrompts = 0;
            this.scheduleTranscriptProcessing();
        } else if (event.event === 'error') {
            throw new Error(`Sarvam STT failed (${event.code || 'unknown'}): ${event.message || 'transcription failed'}`);
        }
    }

    interruptOnCandidatePartial() {
        if (!this.speechStartedDuringAiTurn
            || (this.activeResponseId === null && !this.activeLlmController)
            || this.activeTurnInterrupted) {
            return;
        }
        this.interruptForCandidateSpeech();
    }

    interruptForCandidateSpeech() {
        if (this.activeLlmController && this.activeTurnCheckpoint) {
            this.activeTurnInterrupted = true;
            this.interruptedTurnText = this.activeTurnText;
            this.activeLlmController.abort();
        }
        this.interruptPlayback('candidate_speech');
    }

    scheduleTranscriptProcessing() {
        clearTimeout(this.transcriptTimer);
        if (this.finished || this.finishing || this.completionPending || this.isAiSpeaking || this.speechActive || !this.transcriptBuffer.length) {
            return;
        }
        this.transcriptTimer = setTimeout(() => {
            this.transcriptTimer = null;
            this.processTranscriptBuffer();
        }, this.config.endOfSpeechMs ?? 400);
    }

    processTranscriptBuffer() {
        if (this.isAiSpeaking || this.speechActive || this.finished || this.finishing || this.completionPending) return;
        const buffered = this.transcriptBuffer.splice(0);
        const transcript = buffered.map(({ text }) => text).join(' ').trim();
        if (!transcript) return;

        if (isBackchannelOnly(transcript)
            && (!this.aiAskedQuestion || buffered.every(({ duringAiSpeech }) => duringAiSpeech))) {
            console.info('Discarded candidate backchannel', {
                transcript,
                timestamps: buffered.map(({ timestamp }) => timestamp),
                ai_asked_question: this.aiAskedQuestion,
            });
            this.armSilencePrompt();
            return;
        }

        const language = buffered.at(-1)?.language || this.lastLanguageCode;
        console.info('Final candidate turn sent to LLM', {
            transcript,
            timestamps: buffered.map(({ timestamp }) => timestamp),
        });
        this.aiAskedQuestion = false;
        const process = this.turnQueue.catch((error) => this.logFailure(error)).then(async () => {
            if (this.finished || this.completionPending || !this.conversation) return;
            const turnStartedAt = performance.now();
            const controller = new AbortController();
            this.activeLlmController = controller;
            this.activeTurnCheckpoint = this.conversation.checkpoint?.() ?? null;
            this.activeTurnText = transcript;
            this.activeTurnInterrupted = false;
            const llmStartedAt = performance.now();
            const llmTurn = this.conversation.handleCandidate(transcript, language, {
                signal: controller.signal,
                acknowledgementPlayed: false,
            })
                .then(
                    (result) => ({ result, llmDurationMs: Math.round(performance.now() - llmStartedAt) }),
                    (error) => ({ error, llmDurationMs: Math.round(performance.now() - llmStartedAt) }),
                );
            const turn = await llmTurn;
            if (this.activeLlmController === controller) this.activeLlmController = null;
            if (turn.error) {
                if (controller.signal.aborted) {
                    this.restoreInterruptedTurn();
                    return;
                }
                throw turn.error;
            }
            if (this.activeTurnInterrupted) {
                this.restoreInterruptedTurn();
                return;
            }
            this.activeTurnCheckpoint = null;
            this.activeTurnText = null;
            const { result } = turn;
            const acknowledgementDurationMs = 0;
            if (this.finished || this.finishing) return;
            const turnEnded = result.completed || result.declined || result.interrupted;
            if (turnEnded) {
                this.completionPending = true;
                this.endCallRequested = true;
                clearTimeout(this.silencePromptTimer);
                clearTimeout(this.transcriptTimer);
                this.transcriptBuffer = [];
            }
            const replyLanguage = result.languageCode || 'en-IN';
            this.lastLanguageCode = replyLanguage;
            if (this.isInterview) {
                await this.reportResult({
                    ai_call_id: this.callContext.ai_call_id,
                    provider_call_id: this.providerCallId,
                    status: 'in-progress',
                    transcript: this.conversation.transcript(),
                });
            }
            const ttsStartedAt = performance.now();
            await this.speakSafely(result.reply, replyLanguage);
            console.info('Recruitment voice turn latency', {
                llm_ms: turn.llmDurationMs,
                acknowledgement_ms: acknowledgementDurationMs,
                tts_ms: Math.round(performance.now() - ttsStartedAt),
                total_ms: Math.round(performance.now() - turnStartedAt),
            });
            if (turnEnded) {
                setImmediate(() => this.finish('completed').catch((error) => this.reportFailure(error)));
            }
        });
        this.turnQueue = process.catch((error) => {
            if (error?.name === 'AbortError') return;
            this.failedTurnCount += 1;
            console.error('Recruitment voice turn failed', {
                failed_turns: this.failedTurnCount,
                error: error.name || 'voice_processing_error',
            });
            this.reportFailure(error);
        });
    }

    async speak(text, languageCode, preparedPcm = null) {
        if (this.activeResponseId !== null) {
            throw new Error('Cannot start recruiter speech while another response is active.');
        }
        const responseId = ++this.responseSequence;
        const controller = new AbortController();
        this.activeResponseId = responseId;
        this.activeTtsController = controller;
        this.lastAiText = '';
        this.aiAskedQuestion = false;
        const synthesisStartedAt = performance.now();
        let synthesisMs = null;
        let playbackStartedAt = null;
        let audioStarted = false;
        let interrupted = false;
        let sentMs = 0;
        let clockStart = 0;
        const LEAD_MS = 1200;
        try {
            const audio = preparedPcm
                ? (async function* () { yield preparedPcm; }())
                : this.ttsService.stream(text, languageCode, controller.signal);
            for await (const chunk of packetizePcm16Stream(audio)) {
                if (controller.signal.aborted
                    || this.activeResponseId !== responseId
                    || this.socket.readyState !== WebSocket.OPEN) {
                    interrupted = true;
                    if (!controller.signal.aborted) {
                        controller.abort(new Error('Exotel playback stopped before TTS completed.'));
                    }
                    break;
                }
                if (!audioStarted) {
                    synthesisMs = preparedPcm ? 0 : Math.round(performance.now() - synthesisStartedAt);
                    playbackStartedAt = performance.now();
                    clockStart = playbackStartedAt;
                    this.isAiSpeaking = true;
                    this.lastAiText = text;
                    this.aiAskedQuestion = asksQuestion(text);
                    console.info('ai_speech_start', { response_id: responseId, text, timestamp: Date.now() });
                }
                this.socket.send(makeExotelMediaEvent(this.streamSid, chunk));
                audioStarted = true;
                sentMs += chunk.length / (this.config.sarvam.sampleRate * 2) * 1000;
                const ahead = sentMs - (performance.now() - clockStart);
                if (ahead > LEAD_MS) await delay(ahead - LEAD_MS);
            }
            while (audioStarted && !controller.signal.aborted && this.activeResponseId === responseId) {
                const remaining = sentMs - (performance.now() - clockStart);
                if (remaining <= 0) break;
                await delay(Math.min(remaining, 100));
            }
            if (this.activeResponseId !== responseId || controller.signal.aborted) {
                interrupted = true;
            }
        } catch (error) {
            if (controller.signal.aborted || this.activeResponseId !== responseId) {
                interrupted = true;
            } else if (audioStarted) {
                const partialPlaybackError = new Error(
                    `Sarvam TTS stream failed after playback began: ${error.message}`,
                    { cause: error },
                );
                partialPlaybackError.partialPlayback = true;
                throw partialPlaybackError;
            } else {
                throw error;
            }
        } finally {
            if (this.activeTtsController === controller) {
                this.activeTtsController = null;
            }
            if (this.activeResponseId === responseId) {
                this.activeResponseId = null;
            }
            this.isAiSpeaking = false;
        }

        if (!interrupted) await delay(this.config.postTtsDelayMs ?? 0);
        this.isAiSpeaking = false;
        console.info('Voice audio latency', {
            response_id: responseId,
            tts_first_audio_ms: synthesisMs,
            audio_playback_ms: playbackStartedAt === null
                ? 0
                : Math.round(performance.now() - playbackStartedAt),
            interrupted,
        });
        console.info('ai_speech_end', { response_id: responseId, timestamp: Date.now() });
        this.lastLanguageCode = languageCode;
        this.scheduleTranscriptProcessing();
        this.armSilencePrompt();
    }

    interruptPlayback(reason) {
        const responseId = this.activeResponseId;
        if (responseId === null) return false;

        this.interruptionCount += 1;
        this.activeTtsController?.abort();
        this.activeResponseId = null;
        this.isAiSpeaking = false;
        if (this.streamSid && this.socket.readyState === WebSocket.OPEN) {
            this.socket.send(JSON.stringify({ event: 'clear', stream_sid: this.streamSid }));
        }
        console.info('Recruiter playback interrupted', {
            response_id: responseId,
            reason,
            interruptions: this.interruptionCount,
        });
        return true;
    }

    restoreInterruptedTurn() {
        if (!this.activeTurnInterrupted) return;
        if (this.activeTurnCheckpoint) {
            this.conversation?.restore?.(this.activeTurnCheckpoint);
        }
        this.activeTurnCheckpoint = null;
        this.activeTurnText = null;
        this.activeTurnInterrupted = false;
        this.activeLlmController = null;
    }

    async speakSafely(text, languageCode) {
        try {
            await this.speak(text, languageCode);
        } catch (error) {
            if (this.finished) return;
            this.logFailure(error);
            if (error.partialPlayback) {
                this.armSilencePrompt();
                return;
            }
            if (this.completionPending) {
                return;
            }
            if (text !== SILENCE_PROMPT) {
                try {
                    await this.speak(SILENCE_PROMPT, languageCode);
                    return;
                } catch (fallbackError) {
                    this.logFailure(fallbackError);
                }
            }
            this.armSilencePrompt();
        }
    }

    armSilencePrompt() {
        clearTimeout(this.silencePromptTimer);
        if (this.finished || this.finishing || this.speechActive || this.isAiSpeaking || this.transcriptBuffer.length) return;
        this.silencePromptTimer = setTimeout(() => {
            this.silencePromptTimer = null;
            if (this.finished || this.finishing || this.speechActive || this.isAiSpeaking || this.transcriptBuffer.length) return;
            if (this.unansweredPrompts >= 3) {
                const end = { end_call: true, end_reason: 'silence_timeout' };
                if (shouldHangUp(end, this.conversation?.elapsedSeconds() ?? 0)) {
                    console.warn('Recruitment call hang-up', { reason: 'three_unanswered_silence_prompts' });
                    this.endCallRequested = true;
                    this.finish('completed').catch((error) => this.logFailure(error));
                }
                return;
            }
            this.unansweredPrompts += 1;
            console.info('Recruitment silence prompt', {
                unansweredPrompts: this.unansweredPrompts,
                reason: 'candidate_silence',
            });
            this.speakSafely(SILENCE_PROMPT, this.lastLanguageCode).catch((error) => this.logFailure(error));
        }, this.config.silencePromptSeconds * 1000);
    }

    async finish(status, errorMessage = null) {
        if (this.finished || this.finishing) {
            return;
        }
        this.finishing = true;
        try {
            this.activeLlmController?.abort();
            this.activeTtsController?.abort();
            clearTimeout(this.transcriptTimer);
            clearTimeout(this.silencePromptTimer);
            clearTimeout(this.callDurationTimer);
            clearInterval(this.socketHeartbeat);
            if (status === 'completed') {
                await this.turnQueue;
            }

            let evaluation = this.isInterview ? undefined : (this.conversation?.result() ?? {});
            if (!this.isInterview && status === 'completed' && this.conversation?.canSummarize && this.conversation.transcript()) {
                if (!this.conversation.messages.some(({ role }) => role === 'user')) {
                    evaluation = this.conversation.result();
                } else {
                    try {
                        evaluation = await this.conversation.summarize();
                    } catch (error) {
                        evaluation.summary_error = 'AI summary unavailable; review the transcript.';
                        console.error('AI screening summary failed', { reason: error.name || 'summary_failure' });
                    }
                }
            }

            const duration = this.callStartedAt ? Math.max(0, Math.round((Date.now() - this.callStartedAt) / 1000)) : null;
            clearInterval(this.sttKeepalive);
            this.stt?.close();
            let finalStatus = status;
            let finalErrorMessage = errorMessage;
            if (this.endCallRequested && this.providerCallId) {
                this.hangupPromise ??= hangupExotelCall(this.config.exotel, this.providerCallId);
                try {
                    await this.hangupPromise;
                } catch (error) {
                    this.logFailure(error);
                    finalStatus = 'failed';
                    finalErrorMessage = 'The Exotel call could not be terminated automatically.';
                }
            }
            await this.reportResult({
                ai_call_id: this.callContext.ai_call_id,
                provider_call_id: this.providerCallId,
                status: finalStatus,
                duration_seconds: duration,
                transcript: this.conversation?.transcript() ?? '',
                ...(evaluation === undefined ? {} : { evaluation }),
                ...(finalErrorMessage ? { error_message: finalErrorMessage } : {}),
            });
            this.finished = true;
            if (this.socket.readyState === WebSocket.OPEN) {
                this.socket.close(1000);
            }
        } finally {
            this.finishing = false;
        }
    }

    async fail(error) {
        if (this.finished || this.finishing) {
            return;
        }
        this.logFailure(error);
    }

    reportFailure(error) {
        this.logFailure(error);
    }

    logFailure(error) {
        console.error('Voice call processing failed', { error: error.name || 'voice_processing_error' });
    }
}
