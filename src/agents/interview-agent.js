import {
    interviewConsentPrompt,
    interviewOpeningPrompt,
    interviewQuestionGenerationPrompt,
    interviewSystemPrompt,
    interviewTurnPrompt,
} from './InterviewPrompt.js';
import { isBackchannelOnly, isExplicitYesNoAnswer } from '../utils/conversation-turn.js';
import { getReplySafely } from '../services/llmClient.js';

const UNKNOWN_ANSWER = /^\s*(?:i\s+(?:(?:really|honestly)\s+)?(?:don't|do not)\s+know\b|dont know\b|idk\b|not sure\b|no idea\b|unsure\b|pata nahi\b|maloom nahi\b|मुझे नहीं पता|नहीं पता|no sé\b|不知道)/iu;
const SKIP_ANSWER = /^\s*(?:skip|pass|prefer not to answer|next question)\s*[.! ]*$/iu;
const VALID_ANSWER_STATUSES = new Set(['answered', 'needs_clarification', 'skipped']);

function expectedAnswerType(question) {
    if (!/\bdo you mind\b/i.test(question)
        && /\b(?:do|did|have|has|is|are|was|were)\s+you\b/i.test(question)) {
        return 'yes_or_no_with_optional_context';
    }
    if (/\b(?:how many|how much|how long|what year|when|duration|percentage|number of)\b/i.test(question)) return 'quantity_or_time';
    if (/\b(?:describe|explain|walk me through|tell me about|what was your|how did you|how would you)\b/i.test(question)) return 'relevant_explanation_or_example';
    return 'relevant_short_or_detailed_response';
}

export async function generateInterviewSetup(llm, context) {
    const { system, user } = interviewQuestionGenerationPrompt(context);
    const generated = await llm.complete([
        { role: 'system', content: system },
        { role: 'user', content: user },
    ]);
    const questions = generated?.questions;
    if (!Array.isArray(questions) || questions.length !== 10
        || questions.some((question) => typeof question !== 'string' || question.trim().length < 8)) {
        throw new Error('Sarvam did not generate exactly ten valid interview questions.');
    }

    const normalized = questions.map((question) => question.toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim());
    if (new Set(normalized).size !== 10) {
        throw new Error('Sarvam generated duplicate interview questions.');
    }
    const storedSummary = typeof context.previousScreeningSummary === 'string'
        ? context.previousScreeningSummary.trim()
        : '';
    const generatedSummary = typeof generated.previous_screening_summary === 'string'
        ? generated.previous_screening_summary.trim()
        : '';
    return {
        questions: questions.map((question) => question.trim()),
        previousScreeningSummary: (storedSummary || generatedSummary).slice(0, 350),
    };
}

export async function generateInterviewQuestions(llm, context) {
    const { questions } = await generateInterviewSetup(llm, context);
    return questions;
}

export async function summarizePreviousScreening(llm, transcript) {
    if (typeof transcript !== 'string' || !transcript.trim()) return '';
    const result = await llm.complete([
        {
            role: 'system',
            content: 'Summarize only the candidate’s explicitly stated background, experience, preferences, and prior screening topics as one concise sentence addressed naturally to the candidate. Do not infer facts. Return JSON: {"summary":"..."}',
        },
        { role: 'user', content: transcript.slice(0, 18000) },
    ]);
    if (typeof result?.summary !== 'string' || !result.summary.trim()) {
        throw new Error('Sarvam did not return a usable summary of the previous screening transcript.');
    }
    return result.summary.trim().slice(0, 350);
}

export class InterviewAgent {
    constructor({ llm, context, questions }) {
        if (!Array.isArray(questions) || questions.length !== 10) {
            throw new Error('An interview session must contain exactly ten questions.');
        }
        this.llm = llm;
        this.context = context;
        this.questions = questions;
        this.systemPrompt = interviewSystemPrompt(context);
        this.state = 'consent';
        this.consentAttempts = 0;
        this.currentIndex = 0;
        this.currentPrompt = questions[0];
        this.followUpAsked = false;
        this.answers = Array(10).fill(null);
        this.questionStatuses = Array(10).fill('pending');
        this.pendingCorrection = null;
        this.pendingConflict = false;
        this.messages = [];
        this.completed = false;
        this.languageCode = 'en-IN';
        this.startedAt = null;
    }

    async start() {
        this.startedAt = Date.now();
        const name = typeof this.context.candidate?.name === 'string' && this.context.candidate.name.trim()
            ? this.context.candidate.name.trim()
            : 'there';
        const role = this.context.requisition.job_title || 'the open role';
        const company = this.context.companyName || 'the recruiting team';
        const opening = await getReplySafely(this.llm, [
            { role: 'system', content: this.systemPrompt },
            { role: 'system', content: interviewOpeningPrompt(this.context) },
            {
                role: 'user',
                content: JSON.stringify({
                    candidate: this.context.candidate,
                    company: this.context.companyName,
                    role: this.context.requisition,
                    previousScreeningSummary: this.context.previousScreeningSummary || null,
                }),
            },
        ], { timeoutMs: this.llm.timeoutMs ?? 25000, retries: 0 });
        if (opening._llm.failed) {
            console.warn('AI interview opening generation failed; using a brief fallback greeting.', {
                reason: opening._llm.failure,
            });
        }
        const reply = opening._llm.failed
            ? `Hello, this is the interview team calling about the ${role} role at ${company}. Is now a good time to talk?`
            : opening.reply;
        this.languageCode = 'en-IN';
        this.remember('assistant', reply);
        return { reply, languageCode: this.languageCode };
    }

    async handleCandidate(text, detectedLanguage, { acknowledgementPlayed = false, signal } = {}) {
        if (this.completed) throw new Error('This AI interview is already complete.');
        const answer = String(text ?? '').trim();
        if (!answer) throw new Error('A final speech transcript is required.');
        this.remember('user', answer);

        if (this.state === 'consent') return this.handleConsent(answer, signal);
        return this.handleInterviewTurn(answer, detectedLanguage, acknowledgementPlayed, signal);
    }

    checkpoint() {
        return {
            state: this.state,
            consentAttempts: this.consentAttempts,
            currentIndex: this.currentIndex,
            currentPrompt: this.currentPrompt,
            followUpAsked: this.followUpAsked,
            answers: [...this.answers],
            questionStatuses: [...this.questionStatuses],
            pendingCorrection: this.pendingCorrection,
            pendingConflict: this.pendingConflict,
            messages: this.messages.map((message) => ({ ...message })),
            completed: this.completed,
            languageCode: this.languageCode,
        };
    }

    restore(checkpoint) {
        Object.assign(this, checkpoint);
    }

    transcript() {
        return this.messages.map(({ role, content }) => `${role === 'assistant' ? 'Interviewer' : 'Candidate'}: ${content}`).join('\n');
    }

    elapsedSeconds() {
        return this.startedAt ? Math.max(0, Math.floor((Date.now() - this.startedAt) / 1000)) : 0;
    }

    remember(role, content) {
        this.messages.push({ role, content });
        if (this.messages.length > 40) this.messages.splice(1, this.messages.length - 40);
    }

    async complete(messages, signal) {
        return this.llm.complete([
            { role: 'system', content: this.systemPrompt },
            ...messages,
        ], { signal });
    }

    async handleConsent(answer, signal) {
        this.consentAttempts += 1;
        const result = await this.complete([
            { role: 'system', content: interviewConsentPrompt(this.questions[0]) },
            { role: 'user', content: answer },
        ], signal);
        this.languageCode = 'en-IN';
        if (result.declined === true || (result.identity_confirmed === true && result.permission_granted === false)) {
            this.completed = true;
            const reply = typeof result.reply === 'string' && result.reply.trim()
                ? result.reply.trim()
                : 'No problem. Thank you for your time.';
            this.remember('assistant', reply);
            return { reply, languageCode: this.languageCode, declined: true };
        }
        if (result.identity_confirmed === true && result.permission_granted === true) {
            this.state = 'interview';
            const transition = typeof result.reply === 'string' ? result.reply.trim() : '';
            this.currentPrompt = typeof result.first_question === 'string' && result.first_question.trim()
                ? result.first_question.trim()
                : this.questions[0];
            const reply = [transition, `Let’s begin. ${this.currentPrompt}`].filter(Boolean).join(' ');
            this.remember('assistant', reply);
            return { reply, languageCode: this.languageCode, questionNumber: 1, questionText: this.currentPrompt };
        }
        if (this.consentAttempts >= 2) {
            this.completed = true;
            const reply = 'I’m unable to confirm permission to continue, so I’ll end the interview here. Thank you.';
            this.remember('assistant', reply);
            return { reply, languageCode: this.languageCode, declined: true };
        }
        const reply = typeof result.reply === 'string' && result.reply.trim()
            ? result.reply.trim()
            : 'Could you please confirm your name and whether you’re happy to begin?';
        this.remember('assistant', reply);
        return { reply, languageCode: this.languageCode };
    }

    async handleInterviewTurn(answer, detectedLanguage, acknowledgementPlayed, signal) {
        const question = this.questions[this.currentIndex];
        const priorAnswer = this.answers[this.currentIndex];
        const answerType = expectedAnswerType(question);

        const mode = interviewTurnPrompt({
            question,
            expectedAnswerType: answerType,
            questions: this.questions,
            answers: this.answers,
            questionStatuses: JSON.stringify(this.questionStatuses),
            recentConversation: this.messages.slice(-7, -1)
                .map(({ role, content }) => `${role === 'assistant' ? 'Interviewer' : 'Candidate'}: ${content}`)
                .join('\n'),
            answeredCount: this.questionStatuses.filter((status) => status === 'answered' || status === 'skipped').length,
            previousAnswer: this.followUpAsked ? priorAnswer : '',
            followUpAsked: this.followUpAsked,
            isLastQuestion: this.currentIndex === 9,
            acknowledgementPlayed,
            languageCode: detectedLanguage || this.languageCode,
            nextQuestion: this.questions[this.currentIndex + 1] || null,
            pendingCorrection: this.pendingCorrection,
            pendingConflict: this.pendingConflict,
        });
        const result = await this.complete([
            { role: 'system', content: mode },
            { role: 'user', content: answer },
        ], signal);
        this.languageCode = 'en-IN';

        if (result.candidate_end === true) {
            this.completed = true;
            const reply = this.languageCode === 'en-IN'
                ? 'Thank you for your time. I’ll share the responses recorded so far with the recruiter.'
                : 'Thank you for your time. I’ll share the responses recorded so far with the recruiter.';
            this.remember('assistant', reply);
            return { reply, languageCode: this.languageCode, interrupted: true };
        }

        if (result.candidate_question === true) {
            const response = typeof result.candidate_question_answer === 'string'
                ? result.candidate_question_answer.trim()
                : '';
            const prompt = this.currentPrompt;
            const roleResponse = response || (this.languageCode === 'en-IN'
                ? 'I can only confirm what is in the role description.'
                : 'I can only confirm what is in the role description.');
            const reply = [roleResponse, prompt].join(' ');
            this.remember('assistant', reply);
            return {
                reply,
                languageCode: this.languageCode,
                questionNumber: this.currentIndex + 1,
                questionText: prompt,
                answer: this.answers[this.currentIndex],
                answeredNumber: this.currentIndex + 1,
                candidateQuestion: true,
                questionStatus: this.questionStatuses[this.currentIndex],
            };
        }

        const acknowledgement = '';
        const transition = '';

        if (this.pendingCorrection) {
            if (result.correction_confirmed === 'yes') {
                this.answers[this.currentIndex] = this.pendingCorrection;
                this.pendingCorrection = null;
                this.questionStatuses[this.currentIndex] = 'answered';
            } else if (result.correction_confirmed === 'no') {
                this.pendingCorrection = null;
                this.questionStatuses[this.currentIndex] = 'answered';
            } else {
                this.questionStatuses[this.currentIndex] = 'needs_clarification';
                const reply = this.languageCode === 'en-IN'
                    ? 'I want to record that correctly. Should I keep your earlier answer, or use the correction you just gave?'
                    : 'I want to record that correctly. Should I keep your earlier answer, or use the correction you just gave?';
                this.remember('assistant', reply);
                return {
                    reply,
                    languageCode: this.languageCode,
                    questionNumber: this.currentIndex + 1,
                    questionText: this.currentPrompt,
                    questionStatus: 'needs_clarification',
                    answer: priorAnswer,
                };
            }
        } else if (UNKNOWN_ANSWER.test(answer) || SKIP_ANSWER.test(answer)) {
            this.answers[this.currentIndex] = null;
            this.questionStatuses[this.currentIndex] = 'skipped';
            this.pendingConflict = false;
        } else if (result.answer_conflicts_with_prior === true) {
            this.pendingCorrection = priorAnswer ? answer : null;
            this.pendingConflict = !priorAnswer;
            this.questionStatuses[this.currentIndex] = 'needs_clarification';
            const reply = priorAnswer
                ? `I heard “${priorAnswer}” earlier and “${answer}” just now. Which one should I record?`
                : 'I heard two different details there. Which one should I use for your answer?';
            this.remember('assistant', reply);
            return {
                reply,
                languageCode: this.languageCode,
                questionNumber: this.currentIndex + 1,
                questionText: this.currentPrompt,
                questionStatus: 'needs_clarification',
                answer: priorAnswer,
            };
        } else if (!VALID_ANSWER_STATUSES.has(result.answer_status)
            || result.answer_status === 'needs_clarification'
            || ((isBackchannelOnly(answer) || isExplicitYesNoAnswer(answer))
                && !(answerType === 'yes_or_no_with_optional_context' && isExplicitYesNoAnswer(answer))
                && !this.pendingCorrection)) {
            this.questionStatuses[this.currentIndex] = 'needs_clarification';
            const clarification = typeof result.follow_up_question === 'string'
                ? result.follow_up_question.trim()
                : '';
            const reply = clarification || 'Of course, take your time. What comes to mind?';
            this.remember('assistant', reply);
            return {
                reply,
                languageCode: this.languageCode,
                questionNumber: this.currentIndex + 1,
                questionText: this.currentPrompt,
                questionStatus: 'needs_clarification',
                answer: priorAnswer,
            };
        } else {
            this.answers[this.currentIndex] = this.followUpAsked && priorAnswer
                ? `${priorAnswer}\nFollow-up: ${answer}`
                : answer;
            this.questionStatuses[this.currentIndex] = 'answered';
            this.pendingConflict = false;
        }

        if (this.questionStatuses[this.currentIndex] === 'answered'
            && !this.followUpAsked && !UNKNOWN_ANSWER.test(answer) && result.follow_up_needed === true
            && typeof result.follow_up_question === 'string' && result.follow_up_question.trim()) {
            this.followUpAsked = true;
            this.questionStatuses[this.currentIndex] = 'pending';
            this.currentPrompt = result.follow_up_question.trim();
            const reply = [
                acknowledgement,
                this.currentPrompt,
            ].filter(Boolean).join(' ');
            this.remember('assistant', reply);
            return {
                reply,
                languageCode: this.languageCode,
                questionNumber: this.currentIndex + 1,
                questionText: this.currentPrompt,
                questionStatus: this.questionStatuses[this.currentIndex],
                answer: this.answers[this.currentIndex],
                answeredNumber: this.currentIndex + 1,
            };
        }

        const answeredNumber = this.currentIndex + 1;
        const recordedAnswer = this.answers[this.currentIndex];
        if (this.currentIndex === 9) {
            this.completed = true;
            const closing = typeof result.closing_statement === 'string' && result.closing_statement.trim()
                ? result.closing_statement.trim()
                : 'Thank you for sharing your experience. That’s all I needed for now, and the recruiter will follow up with you.';
            const reply = [acknowledgement, closing]
                .filter(Boolean).join(' ');
            this.remember('assistant', reply);
            return {
                reply,
                languageCode: this.languageCode,
                completed: true,
                answeredNumber,
                answer: recordedAnswer,
                questionStatus: this.questionStatuses[this.currentIndex],
            };
        }

        this.currentIndex += 1;
        this.followUpAsked = false;
        const nextQuestion = typeof result.next_question === 'string' && result.next_question.trim()
            ? result.next_question.trim()
            : this.questions[this.currentIndex];
        this.currentPrompt = nextQuestion;
        const reply = [acknowledgement, transition, nextQuestion].filter(Boolean).join(' ');
        this.remember('assistant', reply);
        return {
            reply,
            languageCode: this.languageCode,
            questionNumber: this.currentIndex + 1,
            questionText: nextQuestion,
            questionStatus: this.questionStatuses[this.currentIndex],
            answeredNumber,
            answer: recordedAnswer,
        };
    }

}
