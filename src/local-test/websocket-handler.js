import WebSocket from 'ws';
import { ConversationService } from '../services/ConversationService.js';
import { InterviewAgent, generateInterviewSetup } from '../agents/interview-agent.js';
import { SarvamLLMService } from '../services/SarvamLLMService.js';
import { SarvamInterviewLLMService } from '../services/SarvamInterviewLLMService.js';
import { SarvamSTTService } from '../services/SarvamSTTService.js';
import { SarvamTTSService } from '../services/SarvamTTSService.js';
import { InboundAudioProcessor } from '../services/inbound-audio-processor.service.js';
import { decodeWavPcm16, resamplePcm16 } from '../utils/audio-utils.js';
import { shouldHangUp } from '../agents/RecruitmentPrompt.js';
import { asksQuestion, cleanCandidateTranscript, isBackchannelOnly, matchesAiSpeech } from '../utils/conversation-turn.js';

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const SILENCE_PROMPT = "I'm still here, can you hear me okay?";

export class LocalTestHandler {
    constructor(socket, config, context, callSessionService, onDone) {
        this.socket = socket;
        this.config = config;
        this.context = context;
        this.isInterview = Boolean(context.interview);
        this.callSessionService = callSessionService;
        this.onDone = onDone;
        this.stt = null;
        this.sttService = new SarvamSTTService(config.sarvam);
        this.ttsService = new SarvamTTSService(config.sarvam);
        this.audioProcessor = new InboundAudioProcessor(config.audio, config.sarvam.sampleRate);
        this.conversation = null;
        this.startedAt = null;
        this.started = false;
        this.finished = false;
        this.finishing = false;
        this.endRequested = false;
        this.completionPending = false;
        this.turnQueue = Promise.resolve();
        this.keepalive = null;
        this.endTimer = null;
        this.startTimer = null;
        this.speechEndedAt = null;
        this.speechStartedAt = null;
        this.speechActive = false;
        this.speechStartedDuringAiSpeech = false;
        this.speechStartedDuringAiTurn = false;
        this.pendingTranscript = [];
        this.pendingTranscriptLanguage = 'en-IN';
        this.interruptedTurnText = null;
        this.activeTurnCheckpoint = null;
        this.activeTurnText = null;
        this.activeTurnInterrupted = false;
        this.transcriptTimer = null;
        this.noTranscriptTimer = null;
        this.isAiSpeaking = false;
        this.interruptionCount = 0;
        this.failedTurnCount = 0;
        this.lastAiText = '';
        this.aiAskedQuestion = false;
        this.responseSequence = 0;
        this.activeResponseId = null;
        this.lastInterruptedResponseId = null;
        this.playbackFallbackTimer = null;
        this.playbackCompletionResponseId = null;
        this.playbackCompletion = null;
        this.playbackFinishedPromise = null;
        this.playbackCompletionResolve = null;
        this.activeTtsController = null;
        this.activeLlmController = null;
        this.unansweredPrompts = 0;
        this.lastLanguageCode = 'en-IN';
        this.lastSocketPongAt = Date.now();
    }

    attach() {
        this.startTimer = setTimeout(() => {
            if (!this.started && !this.finished) {
                this.fail(new Error('The local test WebSocket did not receive a start message.'))
                    .catch((error) => this.logError(error));
            }
        }, this.config.websocketIdleTimeoutMs);
        this.socket.on('message', (data, isBinary) => {
            const task = isBinary
                ? this.handleAudio(data)
                : this.handleClientMessage(data.toString());
            task.catch((error) => this.fail(error).catch((failure) => this.logError(failure)));
        });

        this.socket.once('close', () => {
            if (!this.finished && !this.finishing) {
                console.warn('Local test WebSocket closed', { reason: 'remote_stream_closed' });
                this.finish('completed')
                    .catch((error) => this.logError(error));
            }
        });
        this.socket.on('error', (error) => this.logError(error));
        this.socket.on('pong', () => {
            this.lastSocketPongAt = Date.now();
        });
        this.socketHeartbeat = setInterval(() => {
            if (this.finished || this.socket.readyState !== WebSocket.OPEN) return;
            if (Date.now() - this.lastSocketPongAt > this.config.websocketIdleTimeoutMs) {
                console.warn('Local test WebSocket idle timeout', { reason: 'websocket_idle_timeout' });
                this.socket.terminate();
                return;
            }
            try {
                this.socket.ping();
            } catch (error) {
                this.logError(error);
            }
        }, this.config.websocketPingIntervalMs);
    }

    async handleClientMessage(raw) {
        let message;
        try {
            message = JSON.parse(raw);
        } catch {
            throw new Error('Browser WebSocket messages must be valid JSON.');
        }

        if (message.type === 'start') {
            await this.start();
        } else if (message.type === 'end') {
            this.requestEnd();
        } else if (message.type === 'audio_end') {
            this.sendSttEnd();
        } else if (message.type === 'playback_finished') {
            if (message.response_id === this.activeResponseId) {
                await this.completePlayback(message.response_id);
            }
        } else {
            throw new Error('Unsupported local test WebSocket message.');
        }
    }

    async start() {
        if (this.started) {
            throw new Error('This test call has already started.');
        }
        clearTimeout(this.startTimer);
        this.started = true;
        this.startedAt = Date.now();
        this.callDurationTimer = setTimeout(() => {
            if (this.completionPending) return;
            const end = { end_call: true, end_reason: 'max_duration_reached' };
            if (shouldHangUp(end, this.conversation?.elapsedSeconds() ?? 0)) {
                console.warn('Local test call hang-up', { reason: 'max_duration_reached' });
                this.finish('completed').catch((error) => this.logError(error));
            }
        }, this.config.maxCallDurationSeconds * 1000);

        const sttPromise = this.sttService.connect({
            requisition: this.context.requisition,
            companyName: this.context.company_name,
        });
        let openingPromise;
        if (this.isInterview) {
            const llm = new SarvamInterviewLLMService({
                ...this.config.sarvam,
                timeoutMs: this.config.llmTimeoutMs,
            });
            const interviewContext = {
                ...this.context.interview,
                candidate: this.context.candidate,
                requisition: this.context.requisition,
                companyName: this.context.company_name,
            };
            openingPromise = generateInterviewSetup(llm, interviewContext).then((setup) => {
                interviewContext.questions = setup.questions;
                interviewContext.previousScreeningSummary = setup.previousScreeningSummary;
                this.conversation = new InterviewAgent({
                    llm,
                    context: interviewContext,
                    questions: setup.questions,
                });
                return this.conversation.start();
            });
        } else {
            const llm = new SarvamLLMService(this.config.sarvam);
            this.conversation = new ConversationService({
                llm,
                candidate: this.context.candidate,
                requisition: this.context.requisition,
                companyName: this.context.company_name,
                questions: this.context.screening_questions,
                llmTimeoutMs: this.config.llmTimeoutMs,
                llmRetries: this.config.llmRetries,
            });
            openingPromise = this.conversation.start();
        }
        const [stt, opening] = await Promise.all([sttPromise, openingPromise]);
        const openingLanguage = opening.languageCode || 'en-IN';
        this.lastLanguageCode = openingLanguage;
        this.stt = stt;
        this.stt.on('message', (data) => {
            this.handleSttEvent(data.toString())
                .catch((error) => this.fail(error).catch((failure) => this.logError(failure)));
        });
        this.stt.on('error', (error) => this.fail(error).catch((failure) => this.logError(failure)));
        this.stt.on('close', (code, reason) => {
            if (!this.finished && !this.finishing && !this.endRequested) {
                const detail = reason?.length ? `: ${reason.toString()}` : '';
                this.fail(new Error(`Sarvam STT disconnected unexpectedly (code ${code}${detail}).`))
                    .catch((error) => this.logError(error));
            }
        });
        this.keepalive = setInterval(() => {
            if (this.stt?.readyState === WebSocket.OPEN) {
                this.sttService.keepAlive(this.stt);
            }
        }, this.config.sttKeepAliveIntervalMs);
        this.sendJson({
            type: 'ready',
            call_id: this.context.test_call_id,
            sample_rate: this.config.sarvam.sampleRate,
            browser_mode: this.isInterview ? 'interview' : 'screening',
            ...(!this.isInterview ? { screening_progress: this.conversation.screeningProgress() } : {}),
            audio_processing: {
                noise_suppression: this.config.audio.enabled && this.config.audio.noiseSuppression,
                echo_cancellation: this.config.audio.enabled && this.config.audio.echoCancellation,
            },
        });
        await this.sendAiResponseSafely(opening.reply, openingLanguage);
        await this.persist('in-progress');
    }

    async handleAudio(buffer) {
        if (this.finished || this.endRequested || this.completionPending) {
            return;
        }
        if (!this.started || !this.stt) {
            throw new Error('Start the test call before sending audio.');
        }

        if (buffer.length >= 12 && buffer.toString('ascii', 0, 4) === 'RIFF'
            && buffer.toString('ascii', 8, 12) === 'WAVE') {
            await this.sendWav(buffer);
            return;
        }

        if (buffer.length % 2 !== 0) {
            throw new Error('Microphone audio must contain complete 16-bit PCM samples.');
        }

        this.sendPcm(buffer);
    }

    async sendWav(wav) {
        if (wav.length > 5 * 1024 * 1024) {
            throw new Error('Test WAV files must be no larger than 5 MB.');
        }

        const decoded = decodeWavPcm16(wav);
        const pcm = resamplePcm16(decoded.pcm, decoded.sampleRate, this.config.sarvam.sampleRate);
        await this.sendPcmPaced(pcm);
        await this.sendPcmPaced(Buffer.alloc(this.config.sarvam.sampleRate * 2));
        this.sendJson({ type: 'audio_source_complete' });
    }

    async sendPcmPaced(pcm) {
        const chunkSize = Math.max(3200, Math.floor((this.config.sarvam.sampleRate * 2) / 10 / 320) * 320);
        for (let offset = 0; offset < pcm.length; offset += chunkSize) {
            if (this.endRequested || this.finished) {
                break;
            }
            const chunk = pcm.subarray(offset, Math.min(offset + chunkSize, pcm.length));
            this.sendPcm(chunk);
            await delay(chunk.length / (this.config.sarvam.sampleRate * 2) * 1000);
        }
    }

    sendPcm(pcm) {
        if (this.stt?.readyState !== WebSocket.OPEN) {
            throw new Error('Sarvam STT is not ready to receive audio.');
        }

        const processed = this.audioProcessor.process(pcm);
        const muted = this.config.bargeIn?.enabled === false
            && (this.isAiSpeaking || this.activeResponseId !== null);
        const toSend = muted ? Buffer.alloc(processed.length) : processed;
        for (let offset = 0; offset < toSend.length; offset += 6400) {
            const chunk = toSend.subarray(offset, Math.min(offset + 6400, toSend.length));
            if (chunk.length > 0) {
                this.sttService.sendAudio(this.stt, chunk.toString('base64'));
            }
        }
    }

    async handleSttEvent(raw) {
        let event;
        try {
            event = JSON.parse(raw);
        } catch {
            throw new Error('Sarvam STT sent an invalid event.');
        }
        if (this.finished || this.finishing || this.endRequested || this.completionPending) {
            return;
        }

        if (event.event === 'transcript.partial') {
            if (this.speechStartedDuringAiTurn && event.text?.trim()) {
                if (!this.speechStartedDuringAiSpeech || !matchesAiSpeech(event.text, this.lastAiText)) {
                    this.interruptOnCandidatePartial();
                }
            }
            this.sendJson({ type: 'transcript_partial', text: event.text || '', language: event.language || null });
        } else if (event.event === 'vad.speech_start') {
            clearTimeout(this.silencePromptTimer);
            this.silencePromptTimer = null;
            clearTimeout(this.noTranscriptTimer);
            this.noTranscriptTimer = null;
            this.speechActive = true;
            this.speechStartedAt = Date.now();
            this.speechEndedAt = null;
            this.speechStartedDuringAiSpeech = this.config.bargeIn?.enabled !== false && (this.isAiSpeaking || this.activeResponseId !== null);
            this.speechStartedDuringAiTurn = this.speechStartedDuringAiSpeech || this.activeLlmController !== null;
            clearTimeout(this.transcriptTimer);
            this.transcriptTimer = null;
            this.sendJson({ type: 'speech_start' });
        } else if (event.event === 'vad.speech_end') {
            this.speechEndedAt = performance.now();
            this.speechActive = false;
            const speechDurationMs = this.speechStartedAt === null
                ? 0
                : Date.now() - this.speechStartedAt;
            this.speechStartedAt = null;
            this.sendJson({ type: 'speech_end' });
            this.scheduleTranscriptProcessing();
            clearTimeout(this.noTranscriptTimer);
            if (speechDurationMs >= (this.config.bargeIn?.minimumSpeechMs ?? this.config.sarvam.sttMinSpeechDurationMs)) {
                this.noTranscriptTimer = setTimeout(() => {
                    if (!this.finished && !this.finishing && !this.speechActive && this.pendingTranscript.length === 0) {
                        this.queueUnheardClarification(event.language || 'en-IN')
                            .catch((error) => this.logError(error));
                    }
                }, this.config.silencePromptSeconds * 1000);
            } else {
                this.armSilencePrompt();
            }
        } else if (event.event === 'transcript.final') {
            if (typeof event.text !== 'string' || !event.text.trim()) {
                return;
            }
            const text = cleanCandidateTranscript(event.text, [
                this.context.company_name,
                this.context.requisition?.job_title,
                this.context.requisition?.department,
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
            clearTimeout(this.noTranscriptTimer);
            this.noTranscriptTimer = null;
            clearTimeout(this.silencePromptTimer);
            this.silencePromptTimer = null;
            this.unansweredPrompts = 0;
            const turnText = this.interruptedTurnText
                ? `${this.interruptedTurnText} ${text}`
                : text;
            this.interruptedTurnText = null;
            this.pendingTranscript.push({
                text: turnText,
                timestamp: Date.now(),
                language: event.language || this.pendingTranscriptLanguage || 'en-IN',
                duringAiSpeech: false,
            });
            this.speechStartedDuringAiSpeech = false;
            this.speechStartedDuringAiTurn = false;
            this.pendingTranscriptLanguage = event.language || this.pendingTranscriptLanguage || 'en-IN';
            console.info('Buffered candidate transcript', this.pendingTranscript.at(-1));
            this.sendJson({
                type: 'transcript_partial',
                text: this.pendingTranscript.map(({ text: part }) => part).join(' '),
            });
            this.scheduleTranscriptProcessing();
        } else if (event.event === 'error') {
            this.logError(new Error(`Sarvam STT error (${event.code || 'unknown'}).`));
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
        if (this.finished || this.finishing || this.endRequested || this.completionPending || this.isAiSpeaking
            || this.speechActive || !this.pendingTranscript.length) {
            return;
        }
        this.transcriptTimer = setTimeout(() => this.flushTranscript(), this.config.endOfSpeechMs ?? 400);
    }

    flushTranscript() {
        clearTimeout(this.transcriptTimer);
        this.transcriptTimer = null;
        if (this.isAiSpeaking || this.speechActive || this.completionPending) return;
        const buffered = this.pendingTranscript.splice(0);
        const transcript = buffered.map(({ text }) => text).join(' ').trim();
        if (!transcript || this.finished || this.finishing || this.endRequested || this.completionPending) {
            return;
        }
        const transcriptFinalAt = performance.now();
        const sttFinalizeMs = this.speechEndedAt === null
            ? null
            : Math.round(transcriptFinalAt - this.speechEndedAt);
        const language = buffered.at(-1)?.language || this.pendingTranscriptLanguage;
        this.sendJson({ type: 'transcript_final', text: transcript, language });
        if (isBackchannelOnly(transcript)
            && (!this.aiAskedQuestion || buffered.every(({ duringAiSpeech }) => duringAiSpeech))) {
            console.info('Discarded candidate backchannel', {
                transcript,
                timestamps: buffered.map(({ timestamp }) => timestamp),
                ai_asked_question: this.aiAskedQuestion,
            });
            this.pendingTranscriptLanguage = 'en-IN';
            this.armSilencePrompt();
            return;
        }
        console.info('Final candidate turn sent to LLM', {
            transcript,
            timestamps: buffered.map(({ timestamp }) => timestamp),
        });
        this.pendingTranscriptLanguage = 'en-IN';
        this.aiAskedQuestion = false;
        const process = this.turnQueue.catch((error) => {
            if (!error?.signalAborted) {
                this.logError(error);
            }
        }).then(() => this.processCandidateTurn(
            transcript,
            language,
            { transcriptFinalAt, sttFinalizeMs },
        ));
        this.turnQueue = process.catch((error) => {
            if (this.activeLlmController?.signal.aborted || error?.name === 'AbortError') {
                return;
            }
            this.failedTurnCount += 1;
            console.error('Local test voice turn failed', {
                failed_turns: this.failedTurnCount,
                error: error.name || 'voice_processing_error',
            });
            this.fail(error).catch((failure) => this.logError(failure));
        });
    }

    async processCandidateTurn(text, language, timings = {}) {
        if (this.finished || this.completionPending || !this.conversation) {
            return;
        }
        if (this.isAiSpeaking) {
            this.pendingTranscript.unshift({
                text,
                timestamp: Date.now(),
                language,
                duringAiSpeech: true,
            });
            console.info('Buffered queued candidate turn until recruiter playback ends', {
                transcript: text,
                timestamp: this.pendingTranscript[0].timestamp,
            });
            return;
        }

        const turnStartedAt = performance.now();
        const queueMs = timings.transcriptFinalAt
            ? Math.round(turnStartedAt - timings.transcriptFinalAt)
            : 0;
        const llmStartedAt = performance.now();
        const llmController = new AbortController();
        this.activeLlmController = llmController;
        this.activeTurnCheckpoint = this.conversation.checkpoint?.() ?? null;
        this.activeTurnText = text;
        this.activeTurnInterrupted = false;
        const llmTurn = this.conversation.handleCandidate(text, language, {
            signal: llmController.signal,
            acknowledgementPlayed: false,
        })
            .then(
                (result) => ({ result, llmDurationMs: Math.round(performance.now() - llmStartedAt) }),
                (error) => ({ error, llmDurationMs: Math.round(performance.now() - llmStartedAt) }),
            );
        const turn = await llmTurn;
        if (this.activeLlmController === llmController) this.activeLlmController = null;
        if (turn.error) {
            if (llmController.signal.aborted) {
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
        if (this.endRequested || this.finished || this.finishing) {
            return;
        }
        const turnEnded = result.completed || result.declined || result.interrupted;
        if (turnEnded) {
            this.completionPending = true;
            clearTimeout(this.noTranscriptTimer);
            clearTimeout(this.silencePromptTimer);
            clearTimeout(this.transcriptTimer);
            this.pendingTranscript = [];
        }
        if (!this.isInterview && result.progress) {
            this.sendJson({ type: 'screening_progress', progress: result.progress });
        }
        this.sendJson({ type: 'candidate_transcript', text });
        const ttsStartedAt = performance.now();
        this.lastLanguageCode = result.languageCode || language;
        await this.sendAiResponseSafely(result.reply, this.lastLanguageCode);
        const ttsDurationMs = Math.round(performance.now() - ttsStartedAt);
        console.info('Local test voice turn latency', {
            stt_finalize_ms: timings.sttFinalizeMs,
            queue_ms: queueMs,
            llm_ms: turn.llmDurationMs,
            acknowledgement_ms: acknowledgementDurationMs,
            tts_ms: ttsDurationMs,
            interruptions: this.interruptionCount,
            failed_turns: this.failedTurnCount,
            total_ms: Math.round(performance.now() - turnStartedAt),
        });
        if (turnEnded) {
            this.sendJson({ type: 'conversation_complete' });
            await this.waitForPlayback();
            setImmediate(() => this.finish('completed').catch((error) => this.fail(error).catch((failure) => this.logError(failure))));
        } else {
            await this.persist('in-progress');
        }
    }

    async queueUnheardClarification(language) {
        this.turnQueue = this.turnQueue.then(async () => {
            if (this.endRequested || this.completionPending || this.finished || this.finishing || this.isAiSpeaking
                || this.pendingTranscript.length || !this.conversation) {
                return;
            }
            if (this.unansweredPrompts >= 3) {
                const end = { end_call: true, end_reason: 'silence_timeout' };
                if (shouldHangUp(end, this.conversation.elapsedSeconds())) {
                    console.warn('Local test call hang-up', { reason: 'three_unanswered_silence_prompts' });
                    this.finish('completed').catch((error) => this.logError(error));
                }
                return;
            }
            this.unansweredPrompts += 1;
            this.sendJson({ type: 'transcript_unheard' });
            console.info('Local test silence prompt', {
                unansweredPrompts: this.unansweredPrompts,
                reason: 'candidate_silence',
            });
            await this.sendAiResponseSafely(SILENCE_PROMPT, language || this.lastLanguageCode);
        });
        return this.turnQueue;
    }

    async sendAiResponseSafely(text, languageCode) {
        try {
            await this.sendAiResponse(text, languageCode);
        } catch (error) {
            this.logError(error);
            if (this.completionPending) {
                return;
            }
            if (text !== SILENCE_PROMPT) {
                try {
                    await this.sendAiResponse(SILENCE_PROMPT, languageCode);
                    return;
                } catch (fallbackError) {
                    this.logError(fallbackError);
                }
            }
            this.armSilencePrompt();
        }
    }

    armSilencePrompt() {
        clearTimeout(this.silencePromptTimer);
        if (this.finished || this.finishing || this.completionPending || this.speechActive || this.isAiSpeaking || this.pendingTranscript.length) return;
        this.silencePromptTimer = setTimeout(() => {
            this.silencePromptTimer = null;
            if (this.isAiSpeaking || this.speechActive || this.pendingTranscript.length) return;
            this.queueUnheardClarification(this.lastLanguageCode)
                .catch((error) => this.logError(error));
        }, this.config.silencePromptSeconds * 1000);
    }

    async sendAiResponse(text, languageCode, preparedPcm = null) {
        if (this.activeResponseId !== null) {
            throw new Error('Cannot start recruiter speech while another response is active.');
        }

        const responseId = ++this.responseSequence;
        const controller = new AbortController();
        this.activeResponseId = responseId;
        this.activeTtsController = controller;
        this.sendJson({ type: 'ai_response', text, response_id: responseId });

        try {
            const synthesisStartedAt = performance.now();
            const pcm = preparedPcm || await this.ttsService.synthesize(text, languageCode, controller.signal);
            const synthesisMs = preparedPcm ? 0 : Math.round(performance.now() - synthesisStartedAt);
            if (controller.signal.aborted || this.activeResponseId !== responseId
                || this.socket.readyState !== WebSocket.OPEN) {
                return;
            }
            if (pcm.length === 0) {
                throw new Error('Speech synthesis returned no audio to play.');
            }

            const wav = makeWav(pcm, this.config.sarvam.sampleRate);
            this.isAiSpeaking = true;
            this.lastAiText = text;
            this.aiAskedQuestion = asksQuestion(text);
            this.playbackFinishedPromise = new Promise((resolve) => {
                this.playbackCompletionResolve = resolve;
            });
            console.info('ai_speech_start', { response_id: responseId, text, timestamp: Date.now() });
            console.info('Sending recruiter audio', {
                language: languageCode,
                audio_bytes: pcm.length,
            });
            this.sendJson({ type: 'audio_start', response_id: responseId, format: 'wav', bytes: wav.length });
            this.socket.send(wav, { binary: true });
            this.sendJson({ type: 'audio_end', response_id: responseId });
            const playbackStartedAt = performance.now();
            this.playbackFallbackTimer = setTimeout(
                () => this.completePlayback(responseId).catch((error) => this.logError(error)),
                pcm.length / (this.config.sarvam.sampleRate * 2) * 1000 + 2500,
            );
            await this.playbackFinishedPromise;
            console.info('Voice audio latency', {
                response_id: responseId,
                tts_synthesis_ms: synthesisMs,
                audio_playback_ms: Math.round(performance.now() - playbackStartedAt),
                interrupted: this.lastInterruptedResponseId === responseId,
            });
        } catch (error) {
            if (controller.signal.aborted) {
                return;
            }
            throw error;
        } finally {
            if (this.activeTtsController === controller) {
                this.activeTtsController = null;
            }
            if (controller.signal.aborted && this.activeResponseId === responseId) {
                this.activeResponseId = null;
            }
        }
    }

    interruptPlayback(reason) {
        const responseId = this.activeResponseId;
        if (responseId === null) return false;

        this.interruptionCount += 1;
        this.lastInterruptedResponseId = responseId;
        clearTimeout(this.playbackFallbackTimer);
        this.playbackFallbackTimer = null;
        this.activeTtsController?.abort();
        this.activeResponseId = null;
        this.isAiSpeaking = false;
        this.playbackCompletionResolve?.();
        this.playbackCompletionResolve = null;
        this.playbackFinishedPromise = null;
        this.playbackCompletionResponseId = null;
        this.playbackCompletion = null;
        this.sendJson({ type: 'barge_in', response_id: responseId });
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

    async completePlayback(responseId) {
        if (responseId !== this.activeResponseId) return;
        if (this.playbackCompletionResponseId === responseId) {
            return this.playbackCompletion;
        }

        this.playbackCompletionResponseId = responseId;
        clearTimeout(this.playbackFallbackTimer);
        this.playbackFallbackTimer = null;
        this.playbackCompletion = (async () => {
            await delay(this.config.postTtsDelayMs ?? 0);
            if (responseId !== this.activeResponseId) return;
            this.isAiSpeaking = false;
            this.activeResponseId = null;
            this.playbackCompletionResponseId = null;
            console.info('ai_speech_end', { response_id: responseId, timestamp: Date.now() });
            this.playbackCompletionResolve?.();
            this.playbackCompletionResolve = null;
            this.playbackFinishedPromise = null;
            this.scheduleTranscriptProcessing();
            this.armSilencePrompt();
            this.playbackCompletion = null;
        })();
        return this.playbackCompletion;
    }

    waitForPlayback() {
        return this.isAiSpeaking && this.playbackFinishedPromise
            ? this.playbackFinishedPromise
            : Promise.resolve();
    }

    requestEnd() {
        if (this.finished || this.endRequested || this.completionPending) {
            return;
        }
        const end = { end_call: true, end_reason: 'asked_to_stop' };
        if (!shouldHangUp(end, this.conversation?.elapsedSeconds() ?? 0)) return;
        console.info('Local test call hang-up', { reason: 'candidate_requested_end' });
        this.endRequested = true;
        this.sendJson({ type: 'ending' });
        this.sendSttEnd();
        this.endTimer = setTimeout(() => {
            this.finish('completed').catch((error) => this.fail(error).catch((failure) => this.logError(failure)));
        }, 1500);
    }

    sendSttEnd() {
        clearTimeout(this.noTranscriptTimer);
        this.noTranscriptTimer = null;
        if (this.stt?.readyState === WebSocket.OPEN) {
            this.sttService.end(this.stt);
        }
    }

    async persist(status, errorMessage = null) {
        const transcript = this.conversation?.transcript() || '';
        const duration = this.startedAt
            ? Math.max(0, Math.round((Date.now() - this.startedAt) / 1000))
            : 0;
        await this.callSessionService.updateBrowserSession(this.context.test_call_id, {
            status,
            duration_seconds: duration,
            transcript,
            ...(!this.isInterview ? { evaluation: this.conversation?.result() || {} } : {}),
            error_message: errorMessage,
        });
    }

    async finish(status, errorMessage = null) {
        if (this.finished || this.finishing) {
            return;
        }
        this.finishing = true;
        clearTimeout(this.startTimer);
        clearTimeout(this.endTimer);
        try {
            if (status === 'completed' && !this.endRequested) {
                await this.turnQueue;
            } else if (status === 'completed' && this.endRequested) {
                let drainTimer;
                const drained = await Promise.race([
                    this.turnQueue.then(() => true),
                    new Promise((resolve) => {
                        drainTimer = setTimeout(() => resolve(false), 2500);
                    }),
                ]);
                clearTimeout(drainTimer);
                if (!drained) {
                    console.warn('Ending local test call before pending turn processing completed', {
                        test_call_id: this.context.test_call_id,
                    });
                }
            }

            let evaluation;
            if (!this.isInterview) evaluation = this.conversation?.result() || {};
            if (!this.isInterview && status === 'completed' && this.conversation && !this.endRequested) {
                if (this.conversation.canSummarize && this.conversation.messages.some(({ role }) => role === 'user')) {
                    try {
                        evaluation = await this.conversation.summarize();
                    } catch (error) {
                        evaluation.summary_error = 'AI summary unavailable; review the transcript.';
                        console.error('Local test summary failed', {
                            test_call_id: this.context.test_call_id,
                            message: error.message,
                        });
                    }
                }
            }

            const duration = this.startedAt
                ? Math.max(0, Math.round((Date.now() - this.startedAt) / 1000))
                : 0;
            await this.callSessionService.updateBrowserSession(this.context.test_call_id, {
                status,
                duration_seconds: duration,
                transcript: this.conversation?.transcript() || '',
                ...(!this.isInterview ? { evaluation } : {}),
                error_message: errorMessage,
            });

            this.finished = true;
            clearInterval(this.keepalive);
            clearTimeout(this.noTranscriptTimer);
            clearTimeout(this.transcriptTimer);
            clearTimeout(this.playbackFallbackTimer);
            clearTimeout(this.silencePromptTimer);
            clearTimeout(this.callDurationTimer);
            clearInterval(this.socketHeartbeat);
            this.activeLlmController?.abort();
            this.activeTtsController?.abort();
            this.playbackCompletionResolve?.();
            this.playbackCompletionResolve = null;
            this.sttService.close(this.stt);
            this.sendJson({
                type: 'call_finished',
                status,
                duration_seconds: duration,
                ...(!this.isInterview ? { evaluation } : {}),
            });
            if (this.socket.readyState === WebSocket.OPEN) {
                this.socket.close(1000);
            }
            this.onDone();
        } finally {
            this.finishing = false;
        }
    }

    async fail(error) {
        if (this.finished || this.finishing) {
            return;
        }
        this.logError(error);
        if (this.isInterview) {
            await this.finish('failed', 'The microphone interview could not continue. Please start a new interview session.');
            return;
        }
        const detail = error instanceof Error ? error.message : String(error);
        this.sendJson({
            type: 'error',
            message: `Voice processing failed${detail ? `: ${detail}` : ''}. The call is still active.`,
        });
    }

    sendJson(payload) {
        if (this.socket.readyState === WebSocket.OPEN) {
            this.socket.send(JSON.stringify(payload));
        }
    }

    logError(error) {
        console.error('Local test call failed', {
            error: error?.name || 'voice_processing_error',
            message: error?.message || String(error),
        });
    }
}

function makeWav(pcm, sampleRate) {
    const header = Buffer.alloc(44);
    header.write('RIFF', 0);
    header.writeUInt32LE(36 + pcm.length, 4);
    header.write('WAVE', 8);
    header.write('fmt ', 12);
    header.writeUInt32LE(16, 16);
    header.writeUInt16LE(1, 20);
    header.writeUInt16LE(1, 22);
    header.writeUInt32LE(sampleRate, 24);
    header.writeUInt32LE(sampleRate * 2, 28);
    header.writeUInt16LE(2, 32);
    header.writeUInt16LE(16, 34);
    header.write('data', 36);
    header.writeUInt32LE(pcm.length, 40);
    return Buffer.concat([header, pcm]);
}
