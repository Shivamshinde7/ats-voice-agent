import {
    createRecruitmentSystemPrompt,
    shouldHangUp,
} from './RecruitmentPrompt.js';
import { getReplySafely } from '../services/llmClient.js';
import { asksYesNoQuestion, isBackchannelOnly, isExplicitYesNoAnswer } from '../utils/conversation-turn.js';

const KNOWN_CANDIDATE_FIELDS = {
    current_ctc: ['current_ctc'],
    expected_ctc: ['expected_ctc'],
    notice_period: ['notice_period'],
};

const STAGES = [
    { id: 'opportunity', title: 'Introduction and opportunity', shortTitle: 'Opportunity' },
    { id: 'background', title: 'Candidate background and experience', shortTitle: 'Background' },
    { id: 'technical', title: 'Basic requisition skills', shortTitle: 'Skills' },
    { id: 'availability', title: 'Compensation and availability', shortTitle: 'Availability' },
];
const RECOMMENDATIONS = new Set(['proceed', 'recruiter_review', 'not_interested', 'incomplete']);
const DEFAULT_EXPECTED_ANSWER_TYPES = {
    interest: 'yes_no',
    candidate_background: 'open_ended',
    technical_basic_1: 'open_ended',
    technical_basic_2: 'open_ended',
    technical_basic_3: 'open_ended',
    current_ctc: 'specific_detail',
    expected_ctc: 'specific_detail',
    notice_period: 'specific_detail',
    interview_availability: 'specific_detail',
};
const UNKNOWN_ANSWER = /^(?:i\s+(?:don't|do not)\s+know|dont know|idk|not sure|no idea|unsure|pata nahi|maloom nahi)[.! ]*$/i;
const NONTERMINAL_SHORT_REPLY = /^(?:h+m+|u+m+|u+h+|o+k(?:ay)?|achha|hello|yes|yeah|yep|haan)[.!? ]*$/i;
const PROFILE_BACKGROUND_FIELDS = [
    ['current_company', 'current company'],
    ['current_designation', 'current role'],
    ['experience_years', 'total experience'],
    ['relevant_experience', 'relevant experience'],
    ['skills', 'key skills'],
];

const hasValue = (value) => value !== null && value !== undefined && String(value).trim() !== '';

const hasCandidateValue = (candidate, topicId) => {
    const fields = KNOWN_CANDIDATE_FIELDS[topicId];
    return fields?.every((field) => hasValue(candidate[field])) ?? false;
};

function createScreeningQuestions(candidate, configuredQuestions) {
    const configured = Array.isArray(configuredQuestions)
        ? configuredQuestions.filter((question) => question && typeof question === 'object')
        : [];
    const interest = configured.find((question) => question.id === 'interest') ?? {
        id: 'interest',
        text: 'Briefly confirm whether the candidate is interested in exploring this opportunity.',
    };
    const missingBackground = PROFILE_BACKGROUND_FIELDS
        .filter(([field]) => !hasValue(candidate[field]))
        .map(([, label]) => label);
    const background = missingBackground.length
        ? [{
            id: 'candidate_background',
            stage: 'background',
            expected_answer_type: DEFAULT_EXPECTED_ANSWER_TYPES.candidate_background,
            text: `Ask one brief, open-ended background question focused only on these missing details: ${missingBackground.join(', ')}. Do not list them as separate questions.`,
        }]
        : [];
    const technical = configured
        .filter(({ stage, level }) => stage === 'technical' && (!level || level === 'basic'))
        .slice(0, 3)
        .map((question, index) => ({
            ...question,
            id: `technical_basic_${index + 1}`,
            stage: 'technical',
            level: 'basic',
            expected_answer_type: question.expected_answer_type || DEFAULT_EXPECTED_ANSWER_TYPES[`technical_basic_${index + 1}`],
        }));
    while (technical.length < 3) {
        const index = technical.length + 1;
        technical.push({
            id: `technical_basic_${index}`,
            stage: 'technical',
            level: 'basic',
            expected_answer_type: DEFAULT_EXPECTED_ANSWER_TYPES[`technical_basic_${index}`],
            text: `Ask one short, basic question about a verified requisition skill or responsibility (${index} of 3).`,
        });
    }

    const availability = [
        ['current_ctc', 'Ask the candidate’s current CTC.'],
        ['expected_ctc', 'Ask the candidate’s expected CTC.'],
        ['notice_period', 'Ask the candidate’s notice period.'],
        ['interview_availability', 'Ask when the candidate would be available for an interview.'],
    ].filter(([id]) => !hasCandidateValue(candidate, id))
        .map(([id, text]) => ({
            id,
            stage: 'availability',
            expected_answer_type: configured.find((question) => question.id === id)?.expected_answer_type
                || DEFAULT_EXPECTED_ANSWER_TYPES[id],
            text: configured.find((question) => question.id === id)?.text ?? text,
        }));

    return [
        {
            ...interest,
            stage: 'opportunity',
            expected_answer_type: interest.expected_answer_type || DEFAULT_EXPECTED_ANSWER_TYPES.interest,
        },
        ...background,
        ...technical,
        ...availability,
    ];
};

export class RecruitmentAgent {
    constructor({
        llm,
        candidate = {},
        requisition = {},
        companyName,
        questions = [],
        llmTimeoutMs = Number(process.env.LLM_TIMEOUT_MS ?? 25000),
        llmRetries = Number(process.env.LLM_RETRIES ?? 1),
        now = Date.now,
    }) {
        this.llm = llm;
        this.candidate = candidate;
        this.requisition = requisition;
        this.companyName = companyName;
        this.llmTimeoutMs = llmTimeoutMs;
        this.llmRetries = llmRetries;
        this.now = now;
        this.lastCandidateText = '';
        this.allQuestions = createScreeningQuestions(candidate, questions);
        this.systemPrompt = createRecruitmentSystemPrompt({
            candidate,
            requisition,
            companyName,
            questions: this.allQuestions,
        });
        this.questions = this.allQuestions.filter((question) => !hasCandidateValue(candidate, question.id));
        this.answers = {};
        this.messages = [];
        this.stage = 'identity';
        this.candidateConsentAt = null;
        this.screeningStartedAt = null;
        this.candidateStatus = null;
        this.finalEndReason = null;
        this.completed = false;
        this.screeningFinished = false;
    }

    get currentQuestion() {
        return this.questions[0] ?? null;
    }

    get currentScreeningStage() {
        return this.currentQuestion?.stage
            ?? (this.screeningFinished ? 'complete' : (this.stage === 'screening' ? 'availability' : null));
    }

    get canSummarize() {
        return this.finalEndReason !== null;
    }

    elapsedSeconds() {
        return this.screeningStartedAt === null
            ? 0
            : Math.max(0, Math.floor((this.now() - this.screeningStartedAt) / 1000));
    }

    checkpoint() {
        return {
            lastCandidateText: this.lastCandidateText,
            systemPrompt: this.systemPrompt,
            questions: [...this.questions],
            answers: { ...this.answers },
            messages: this.messages.map((message) => ({ ...message })),
            stage: this.stage,
            candidateConsentAt: this.candidateConsentAt,
            screeningStartedAt: this.screeningStartedAt,
            candidateStatus: this.candidateStatus,
            finalEndReason: this.finalEndReason,
            completed: this.completed,
            screeningFinished: this.screeningFinished,
        };
    }

    restore(checkpoint) {
        Object.assign(this, checkpoint);
    }

    currentStageNumber() {
        if (this.stage === 'complete' || this.screeningFinished) return 4;
        const stageId = this.currentQuestion?.stage
            ?? (this.stage === 'screening' ? 'availability' : 'opportunity');
        return Math.max(1, STAGES.findIndex(({ id }) => id === stageId) + 1);
    }

    async start() {
        const candidateName = typeof this.candidate.name === 'string' && this.candidate.name.trim()
            ? this.candidate.name.trim()
            : 'the candidate';
        const opening = await this.generateTurn(
            'Start with Hello and speak clear, natural professional Indian English. Introduce yourself as Isha from the recruiting team and the verified company, then ask whether you are speaking with the named candidate. Use en-IN. Do not ask for consent or begin screening yet.',
            'en-IN',
        );
        this.finalEndReason = null;
        const reply = opening._llm.failed || opening.parse_failed
            ? `Hello, this is Isha from ${this.companyName || 'the recruiting team'}. Am I speaking with ${candidateName}?`
            : opening.reply;
        this.remember('assistant', reply);
        return { reply, languageCode: 'en-IN' };
    }

    async handleCandidate(text, detectedLanguage, { signal } = {}) {
        if (this.completed) {
            throw new Error('The recruitment conversation is already complete.');
        }

        this.remember('user', text);
        this.lastCandidateText = String(text ?? '').trim();
        if (this.stage === 'identity') {
            return this.handleIdentity(detectedLanguage, signal);
        }
        if (this.stage === 'consent') {
            return this.handleConsent(detectedLanguage, signal);
        }

        return this.handleScreening(detectedLanguage, signal);
    }

    clarifyUnheard(languageCode = 'en-IN') {
        return this.handleUnclear(languageCode);
    }

    unheardReply(languageCode = 'en-IN') {
        return 'Sorry, I couldn’t hear that clearly. Could you please repeat?';
    }

    handleUnclear(languageCode = 'en-IN') {
        const reply = this.unheardReply(languageCode);
        this.remember('assistant', reply);
        return { reply, completed: false, languageCode: 'en-IN', progress: this.progress() };
    }

    async handleIdentity(detectedLanguage, signal) {
        const result = await this.generateTurn(
            'Determine whether this person confirms they are the named candidate. If yes, ask whether now is a good time to talk. Do not say great to chat or add small talk. If they are someone else or decline, close politely. If unclear, ask one brief identity clarification.',
            detectedLanguage,
            signal,
        );

        if (result.end_call) {
            return this.close(result);
        }
        if (result.parse_failed) {
            return this.returnTurn(result);
        }
        if (result.unclear) {
            return this.handleUnclear(result.language_code || detectedLanguage);
        }
        if (result.candidate_identity_confirmed) {
            if (result.candidate_consented) {
                this.candidateConsentAt = new Date().toISOString();
                this.screeningStartedAt = this.now();
                this.stage = 'screening';
                const next = await this.generateTurn(
                    'The candidate has already confirmed their identity and clearly said this is a good time to continue. Do not ask about timing or permission again. Briefly explain the verified opportunity and ask the first unanswered screening topic with one short question.',
                    detectedLanguage,
                    signal,
                );
                if (next.end_call) {
                    return this.close(next);
                }
                this.captureAnswers(next.captured_answers);
                this.refreshQuestions();
                this.remember('assistant', next.reply);
                return {
                    reply: next.reply,
                    completed: this.completed,
                    languageCode: next.language_code,
                    progress: this.progress(),
                };
            }
            this.stage = 'consent';
        } else {
            this.remember('assistant', result.reply);
            return {
                reply: result.reply,
                completed: false,
                languageCode: result.language_code,
                progress: this.progress(),
            };
        }

        this.remember('assistant', result.reply);
        return { reply: result.reply, completed: this.completed, languageCode: result.language_code, progress: this.progress() };
    }

    async handleConsent(detectedLanguage, signal) {
        const result = await this.generateTurn(
            'Interpret whether the candidate has time and clearly consents to continue. If they agree, briefly explain the verified opportunity and ask the first unanswered screening topic with one short question. If they are busy or decline, close politely. Never begin screening without clear consent. Ask whether now is a good time to talk, not whether it is great to chat.',
            detectedLanguage,
            signal,
        );

        if (result.end_call) {
            return this.close(result);
        }
        if (result.parse_failed) {
            return this.returnTurn(result);
        }
        if (result.unclear) {
            return this.handleUnclear(result.language_code || detectedLanguage);
        }
        if (!result.candidate_consented) {
            this.remember('assistant', result.reply);
            return { reply: result.reply, completed: false, languageCode: result.language_code, progress: this.progress() };
        }

        this.captureAnswers(result.captured_answers);
        this.refreshQuestions();
        this.candidateConsentAt = new Date().toISOString();
        this.screeningStartedAt = this.now();
        this.stage = 'screening';
        this.remember('assistant', result.reply);
        return { reply: result.reply, completed: this.completed, languageCode: result.language_code, progress: this.progress() };
    }

    async handleScreening(detectedLanguage, signal) {
        const currentQuestion = this.currentQuestion;
        if (!currentQuestion) {
            return this.completeScreening(detectedLanguage, signal);
        }

        const nextQuestion = this.questions[1] ?? null;
        const lastQuestion = [...this.messages].reverse()
            .find(({ role }) => role === 'assistant')?.content || '';
        const expectedAnswerType = currentQuestion.expected_answer_type === 'yes_no'
            || asksYesNoQuestion(lastQuestion)
            ? 'yes_no'
            : currentQuestion.expected_answer_type;
        const task = `Current screening topic: "${currentQuestion.text}". Expected answer type: ${expectedAnswerType}. Decide whether the candidate answered it, asked a question, or is simply acknowledging you. Set current_topic_answered=true only when their turn answers this topic; a bare acknowledgement does not answer an open-ended question, while a clear yes or no can answer a yes/no question. If they ask anything outside screening, say the recruiter can follow up after screening and continue this topic. If they also answered the topic, move to the next unanswered topic. If they are only acknowledging, respond naturally and leave the topic open without repeating it word for word. If they answered, move to the next unanswered topic${nextQuestion ? `: ${nextQuestion.text}` : ' and close briefly'}. Do not ask for details they have already given.`;
        const result = await this.generateTurn(task, detectedLanguage, signal);

        if (result.parse_failed) {
            return this.returnTurn(result);
        }

        const acknowledgementOnly = isBackchannelOnly(this.lastCandidateText)
            || isExplicitYesNoAnswer(this.lastCandidateText);
        const validShortAnswer = expectedAnswerType === 'yes_no'
            && isExplicitYesNoAnswer(this.lastCandidateText);
        const topicAnswered = (!acknowledgementOnly || validShortAnswer)
            && (result.current_topic_answered === true
                || (typeof result.current_topic_answered !== 'boolean'
                    && result.candidate_question !== true
                    && !acknowledgementOnly));
        if (topicAnswered) {
            this.answers[currentQuestion.id] = UNKNOWN_ANSWER.test(this.lastCandidateText)
                ? 'Candidate did not know / answer not provided.'
                : this.lastCandidateText;
            this.refreshQuestions();
        }

        if (result.end_call) {
            this.captureAnswers(result.captured_answers, topicAnswered ? [] : [currentQuestion.id]);
            this.refreshQuestions();
            return this.close(result);
        }
        this.captureAnswers(result.captured_answers, topicAnswered ? [] : [currentQuestion.id]);
        this.refreshQuestions();

        if (!this.currentQuestion) {
            this.finalEndReason = 'screening_complete';
            return this.close({
                ...result,
                reply: result.language_code === 'en-IN'
                    ? 'Thank you for your time. The recruiter will follow up with you.'
                    : 'Thank you for your time. Recruiter aapse follow up karenge.',
                end_call: true,
                end_reason: 'screening_complete',
            });
        }

        this.remember('assistant', result.reply);
        return { reply: result.reply, completed: false, languageCode: result.language_code, progress: this.progress() };
    }

    async completeScreening(detectedLanguage) {
        this.finalEndReason = 'screening_complete';
        return this.close({
            reply: 'Thank you for your time. The recruiter will follow up with you.',
            language_code: 'en-IN',
            end_call: true,
            end_reason: 'screening_complete',
        });
    }
    refreshQuestions() {
        this.questions = this.questions.filter((question) => !this.answers[question.id]);
    }

    finishScreeningIfReady() {
        return this.questions.length === 0 && this.screeningStartedAt !== null;
    }

    progress() {
        const stages = STAGES.map((stage) => {
            const questions = this.allQuestions.filter((question) => question.stage === stage.id);
            const covered = questions.filter((question) => (
                Boolean(this.answers[question.id]) || hasCandidateValue(this.candidate, question.id)
            )).length;
            return {
                id: stage.id,
                title: stage.title,
                total: questions.length,
                completed: covered,
                status: covered === questions.length ? 'completed' : (covered > 0 ? 'in_progress' : 'pending'),
            };
        });
        const stage = STAGES.find(({ id }) => id === this.currentScreeningStage);
        return {
            current_stage: stage?.id ?? (this.screeningFinished ? 'complete' : null),
            current_stage_title: stage?.shortTitle ?? (this.screeningFinished ? 'Complete' : 'Getting started'),
            stages,
            screening_complete: this.screeningFinished,
        };
    }

    captureAnswers(capturedAnswers, excludedTopicIds = []) {
        if (!capturedAnswers || typeof capturedAnswers !== 'object' || Array.isArray(capturedAnswers)) {
            return;
        }
        const validTopicIds = new Set(this.allQuestions.map(({ id }) => id));
        const technicalTopicIds = new Set(
            this.allQuestions.filter(({ stage }) => stage === 'technical').map(({ id }) => id),
        );
        for (const [topicId, value] of Object.entries(capturedAnswers)) {
            if (validTopicIds.has(topicId) && !excludedTopicIds.includes(topicId)
                && !technicalTopicIds.has(topicId)
                && typeof value === 'string' && value.trim()) {
                this.answers[topicId] ??= value.trim();
            }
        }
    }

    close(result, terminalStatus = null) {
        if (result.candidate_not_interested) {
            this.candidateStatus = 'not_interested';
        } else if (result.candidate_busy) {
            this.candidateStatus = 'busy';
        } else if (result.candidate_declined) {
            this.candidateStatus = 'declined';
        } else if (terminalStatus) {
            this.candidateStatus = terminalStatus;
        }
        if (result.end_reason === 'not_candidate') {
            this.candidateStatus = 'not_candidate';
        }
        if (result.end_reason === 'declined_opportunity' && !this.candidateStatus) {
            this.candidateStatus = 'not_interested';
        }
        if (result.end_reason === 'busy_confirmed' && !this.candidateStatus) {
            this.candidateStatus = 'busy';
        }
        if (result.end_reason === 'screening_complete') {
            this.screeningFinished = true;
        }
        this.completed = true;
        this.stage = 'complete';
        this.remember('assistant', result.reply);
        return {
            reply: result.reply,
            completed: true,
            languageCode: result.language_code,
            candidateStatus: this.candidateStatus,
            endReason: this.finalEndReason,
            progress: this.progress(),
        };
    }

    returnTurn(result) {
        this.remember('assistant', result.reply);
        return {
            reply: result.reply,
            completed: false,
            languageCode: result.language_code,
            progress: this.progress(),
        };
    }

    async summarize() {
        if (!this.canSummarize) {
            throw new Error('A screening summary is available only after the configured screening topics are complete, or a final candidate status.');
        }
        const result = await this.generateTurn(
            'This is the final recruiter review after the screening. Summarize the conversation concisely using only candidate statements and verified requisition details. Set recommendation to "not_interested" only if the candidate explicitly declined; set "incomplete" if any configured screening topic is not covered; otherwise choose "proceed" only when recorded evidence supports a next conversation, or "recruiter_review" when evidence is mixed or insufficient. Give a brief factual recommendation_reason, and evidence-based strengths and concerns arrays. Do not infer facts, penalize missing information, make a hiring decision, or change ATS candidate status.',
            'en-IN',
            undefined,
            { retainAssessment: true },
        );

        if (typeof result.summary !== 'string' || !result.summary.trim()) {
            throw new Error('LLM did not return a screening summary.');
        }
        const progress = this.progress();
        const explicitlyNotInterested = this.candidateStatus === 'not_interested'
            || (Boolean(this.answers.interest) && /not interested|declin|not proceed|not looking/i.test(this.answers.interest));
        const recommendation = explicitlyNotInterested
            ? 'not_interested'
            : (!progress.screening_complete
                ? 'incomplete'
                : result.recommendation);
        if (!RECOMMENDATIONS.has(recommendation)) {
            throw new Error('LLM did not return a valid screening recommendation.');
        }
        if (typeof result.recommendation_reason !== 'string' || !result.recommendation_reason.trim()
            || !Array.isArray(result.strengths) || !Array.isArray(result.concerns)) {
            throw new Error('LLM did not return the required recruiter assessment details.');
        }

        return {
            summary: result.summary.trim(),
            answers: this.answers,
            screening: progress,
            candidate_status: this.candidateStatus,
            recommendation,
            recommendation_reason: explicitlyNotInterested
                ? 'The candidate explicitly declined the opportunity.'
                : result.recommendation_reason.trim(),
            strengths: result.strengths.filter((item) => typeof item === 'string'),
            concerns: result.concerns.filter((item) => typeof item === 'string'),
            consent: {
                candidate_confirmed: Boolean(this.candidateConsentAt),
                candidate_consented: Boolean(this.candidateConsentAt),
                candidate_consented_at: this.candidateConsentAt,
            },
        };
    }

    async generateTurn(task, detectedLanguage = 'en-IN', signal, { retainAssessment = false } = {}) {
        const elapsedSeconds = this.elapsedSeconds();
        const context = {
            task,
            current_topic: this.currentQuestion,
            screening_progress: this.progress(),
            answers_already_given: this.answers,
            candidate_language: detectedLanguage,
            recent_conversation: this.messages.slice(-12),
        };
        this.systemPrompt = createRecruitmentSystemPrompt({
            candidate: this.candidate,
            requisition: this.requisition,
            companyName: this.companyName,
            questions: this.allQuestions,
            elapsedSeconds,
            currentStage: this.currentStageNumber(),
        });
        const result = await getReplySafely(this.llm, [
            { role: 'system', content: this.systemPrompt },
            { role: 'user', content: JSON.stringify(context) },
        ], {
            signal,
            timeoutMs: this.llmTimeoutMs,
            retries: this.llmRetries,
        });

        if (retainAssessment) {
            result.end_call = false;
            result.end_reason = null;
        } else {
            if (result.end_call && (
                UNKNOWN_ANSWER.test(this.lastCandidateText)
                || NONTERMINAL_SHORT_REPLY.test(this.lastCandidateText)
                || isBackchannelOnly(this.lastCandidateText)
            )) {
                result.end_call = false;
                result.end_reason = null;
                result.summary = null;
                result.recommendation = null;
                result.recommendation_reason = null;
            }
            if (result.end_call && result.end_reason === 'screening_complete') {
                result.end_call = false;
                result.end_reason = null;
                result.summary = null;
                result.recommendation = null;
                result.recommendation_reason = null;
            }

            if (result.end_call && !shouldHangUp(result, elapsedSeconds)) {
                result.end_call = false;
                result.end_reason = null;
                result.summary = null;
                result.recommendation = null;
                result.recommendation_reason = null;
            }

            if (result.end_call && shouldHangUp(result, elapsedSeconds)) {
                this.finalEndReason = result.end_reason;
                console.info('Recruitment call hang-up', { reason: result.end_reason });
            } else {
                result.end_call = false;
                result.end_reason = null;
                result.summary = null;
                result.recommendation = null;
                result.recommendation_reason = null;
            }
        }

        if (result._llm.failed) {
            result.reply = "I'm sorry, I'm having trouble connecting. Please give me a moment.";
        }

        const languageCode = 'en-IN';

        console.info('Recruitment turn', {
            elapsedSeconds,
            stage: this.currentStageNumber(),
            llmLatencyMs: result._llm.latencyMs,
            attempts: result._llm.attempts,
            end_call: result.end_call,
            end_reason: result.end_reason,
            llmFailure: result._llm.failed ? result._llm.failure : null,
        });
        return { ...result, reply: result.reply.trim(), language_code: languageCode };
    }

    transcript() {
        return this.messages.map(({ role, content }) => `${role === 'assistant' ? 'AI' : 'Candidate'}: ${content}`).join('\n');
    }

    result() {
        const progress = this.progress();
        const explicitlyNotInterested = this.candidateStatus === 'not_interested'
            || (Boolean(this.answers.interest) && /not interested|declin|not proceed|not looking/i.test(this.answers.interest));
        return {
            answers: this.answers,
            screening: progress,
            candidate_status: this.candidateStatus,
            recommendation: explicitlyNotInterested
                ? 'not_interested'
                : (progress.screening_complete ? 'recruiter_review' : 'incomplete'),
            recommendation_reason: explicitlyNotInterested
                ? 'The candidate explicitly declined the opportunity.'
                : (progress.screening_complete
                    ? 'The screening stages are complete and awaiting recruiter review.'
                    : 'The screening ended before all stages were completed.'),
            consent: {
                candidate_confirmed: Boolean(this.candidateConsentAt),
                candidate_consented: Boolean(this.candidateConsentAt),
                candidate_consented_at: this.candidateConsentAt,
            },
        };
    }

    screeningProgress() {
        return this.progress();
    }

    remember(role, content) {
        this.messages.push({ role, content });
    }
}
