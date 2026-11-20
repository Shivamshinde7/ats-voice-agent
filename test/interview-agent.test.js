import test from 'node:test';
import assert from 'node:assert/strict';
import { InterviewAgent, generateInterviewQuestions, generateInterviewSetup } from '../src/agents/interview-agent.js';

const questions = Array.from({ length: 10 }, (_, index) => `Describe a requisition-specific example for topic ${index + 1}?`);
function createLlm() {
    return {
        async complete(messages) {
            const instruction = messages
                .filter((message) => message.role === 'system')
                .map((message) => message.content)
                .join('\n');
            const answer = messages.at(-1)?.content || '';
            if (instruction.includes('Write the first spoken greeting')) {
                return {
                    reply: 'Hello, this is the interviewer calling about the Platform Engineer role. Is now a good time to talk?',
                    language_code: 'en-IN',
                };
            }
            if (instruction.includes('Classify the latest candidate turn')) {
                return {
                    identity_confirmed: true,
                    permission_granted: true,
                    declined: false,
                    reply: 'Thanks for confirming.',
                    language_code: 'en-IN',
                };
            }
            if (instruction.includes('Current unanswered interview topic:') && answer === 'I introduced a cache.') {
                return {
                    answer_status: 'answered',
                    candidate_question: false,
                    candidate_end: false,
                    acknowledgement: '',
                    follow_up_needed: true,
                    follow_up_question: 'What changed after the cache was introduced?',
                    transition: '',
                    language_code: 'en-IN',
                };
            }
            return {
                answer_status: answer === 'I do not know' ? 'skipped' : 'answered',
                candidate_question: false,
                candidate_end: false,
                acknowledgement: '',
                follow_up_needed: false,
                follow_up_question: '',
                transition: 'Right.',
                language_code: 'en-IN',
                ...(answer === 'I do not know' ? { follow_up_needed: true, follow_up_question: 'Could you clarify?' } : {}),
            };
        },
    };
}

test('generates exactly ten distinct questions from real candidate and requisition context', async () => {
    let prompt = '';
    const llm = {
        async complete(messages) {
            prompt = messages.map(({ content }) => content).join('\n');
            return { questions };
        },
    };
    const generated = await generateInterviewQuestions(llm, {
        candidate: { name: 'Casey', experience_years: '5 years' },
        requisition: { job_title: 'Platform Engineer', skills: 'Go, Kubernetes', level_requisitions: 'L3' },
        difficulty: 'Advanced',
    });

    assert.equal(generated.length, 10);
    assert.match(prompt, /Advanced/);
    assert.match(prompt, /L3/);
    assert.match(prompt, /Kubernetes/);
    assert.match(prompt, /Casey/);
});

test('uses the previous screening transcript to avoid repeating covered topics', async () => {
    let prompt = '';
    const llm = {
        async complete(messages) {
            prompt = messages.map(({ content }) => content).join('\n');
            return { questions };
        },
    };
    await generateInterviewQuestions(llm, {
        candidate: { name: 'Casey' },
        requisition: { job_title: 'Platform Engineer' },
        difficulty: 'Intermediate',
        previousScreeningTranscript: 'Candidate discussed Kubernetes operations and a recent migration.',
    });

    assert.match(prompt, /Kubernetes operations and a recent migration/);
    assert.match(prompt, /avoid repeating topics already covered/i);
});

test('generates the interview setup and prior-screening recap in one LLM request', async () => {
    let calls = 0;
    const setup = await generateInterviewSetup({
        async complete() {
            calls += 1;
            return {
                questions,
                previous_screening_summary: 'The candidate described Kubernetes operations and a recent migration.',
            };
        },
    }, {
        candidate: { name: 'Casey' },
        requisition: { job_title: 'Platform Engineer' },
        difficulty: 'Intermediate',
        previousScreeningTranscript: 'Candidate discussed Kubernetes operations and a recent migration.',
    });

    assert.equal(calls, 1);
    assert.equal(setup.questions.length, 10);
    assert.equal(setup.previousScreeningSummary, 'The candidate described Kubernetes operations and a recent migration.');
});

test('tracks interview topics, allows one relevant follow-up, and accepts unknown answers without probing', async () => {
    const agent = new InterviewAgent({
        llm: createLlm(),
        context: {
            difficulty: 'Intermediate',
            candidate: { name: 'Casey' },
            requisition: { job_title: 'Platform Engineer', level_requisitions: 'L2' },
        },
        questions,
    });

    const opening = (await agent.start()).reply;
    assert.match(opening, /is now a good time to talk/i);
    assert.doesNotMatch(opening, /ten|10|question/i);
    const consent = await agent.handleCandidate('Yes, this is Casey and you may begin.');
    assert.equal(consent.questionNumber, 1);
    assert.ok(consent.reply.includes(questions[0]));

    const first = await agent.handleCandidate('I introduced a cache.');
    assert.equal(first.questionNumber, 1);
    assert.match(first.reply, /What changed after the cache/);
    assert.equal(agent.currentIndex, 0);
    assert.equal(agent.questionStatuses[0], 'pending');

    const followup = await agent.handleCandidate('It reduced repeated database requests.');
    assert.equal(followup.questionNumber, 2);
    assert.match(followup.answer, /Follow-up:/);
    assert.equal(agent.questionStatuses[0], 'answered');

    const unknown = await agent.handleCandidate('I do not know');
    assert.equal(unknown.questionNumber, 3);
    assert.equal(agent.answers[1], null);
    assert.equal(agent.questionStatuses[1], 'skipped');

    let final;
    for (let index = 2; index < 10; index += 1) {
        final = await agent.handleCandidate(`Example answer ${index + 1}.`);
    }

    assert.equal(final.completed, true);
    assert.equal(agent.completed, true);
    assert.equal(agent.answers.length, 10);
    assert.doesNotMatch(final.reply, /ten questions|question \d+ of \d+|assessment|score/i);
    await assert.rejects(() => agent.handleCandidate('Another answer'), /already complete/);
});

test('accepts a short yes only for a yes/no interview question', async () => {
    const yesNoQuestions = ['Have you used Kubernetes in production?', ...questions.slice(1)];
    const agent = new InterviewAgent({
        llm: createLlm(),
        context: {
            difficulty: 'Intermediate',
            candidate: { name: 'Casey' },
            requisition: { job_title: 'Platform Engineer', level_requisitions: 'L2' },
        },
        questions: yesNoQuestions,
    });

    await agent.start();
    await agent.handleCandidate('Yes, this is Casey and you may begin.');

    const acknowledgement = await agent.handleCandidate('Okay');
    assert.equal(acknowledgement.questionNumber, 1);
    assert.equal(agent.questionStatuses[0], 'needs_clarification');

    const affirmative = await agent.handleCandidate('Yes');
    assert.equal(affirmative.questionNumber, 2);
    assert.equal(agent.questionStatuses[0], 'answered');
    assert.equal(agent.answers[0], 'Yes');
});

test('does not accept a standalone affirmative for an open-ended interview question', async () => {
    const agent = new InterviewAgent({
        llm: createLlm(),
        context: {
            difficulty: 'Intermediate',
            candidate: { name: 'Casey' },
            requisition: { job_title: 'Platform Engineer', level_requisitions: 'L2' },
        },
        questions,
    });

    await agent.start();
    await agent.handleCandidate('Yes, this is Casey and you may begin.');

    const result = await agent.handleCandidate('Haan');
    assert.equal(result.questionNumber, 1);
    assert.equal(agent.questionStatuses[0], 'needs_clarification');
    assert.equal(agent.answers[0], null);
});

test('asks all ten prepared questions even when the LLM recommends early completion', async () => {
    let turns = 0;
    const llm = {
        async complete(messages) {
            const instruction = messages.filter(({ role }) => role === 'system').map(({ content }) => content).join('\n');
            if (instruction.includes('Write the first spoken greeting')) {
                return {
                    reply: 'Hello Casey, this is the interviewer calling about the Platform Engineer role. Is now a good time to talk?',
                    language_code: 'en-IN',
                };
            }
            if (instruction.includes('Classify the latest candidate turn')) {
                return { identity_confirmed: true, permission_granted: true, language_code: 'en-IN' };
            }
            turns += 1;
            return {
                candidate_question: false,
                candidate_end: false,
                answer_status: 'answered',
                interview_complete: turns === 5,
                acknowledgement: '',
                follow_up_needed: false,
                transition: '',
                next_question: questions[turns] || '',
                closing_statement: 'Thanks for walking me through that. The recruiter will be in touch.',
                language_code: 'en-IN',
            };
        },
    };
    const agent = new InterviewAgent({
        llm,
        context: { difficulty: 'Intermediate', candidate: { name: 'Casey' }, requisition: { job_title: 'Platform Engineer' } },
        questions,
    });

    await agent.start();
    await agent.handleCandidate('Yes, this is Casey and now is a good time.');
    let result;
    for (let index = 0; index < 9; index += 1) {
        result = await agent.handleCandidate(`Relevant answer ${index + 1}.`);
    }

    assert.equal(result.completed, undefined);
    assert.equal(agent.currentIndex, 9);
    result = await agent.handleCandidate('Relevant answer 10.');
    assert.equal(result.completed, true);
    assert.match(result.reply, /Thanks for walking me through that/);
    assert.equal(Object.hasOwn(result, 'assessment'), false);
});

test('keeps listener acknowledgements on the current topic while classifying them in context', async () => {
    let llmCalls = 0;
    const llm = {
        async complete(messages) {
            llmCalls += 1;
            const instruction = messages
                .filter(({ role }) => role === 'system')
                .map(({ content }) => content)
                .join('\n');
            const answer = messages.at(-1)?.content || '';
            if (instruction.includes('Classify the latest candidate turn')) {
                return {
                    identity_confirmed: true,
                    permission_granted: true,
                    language_code: 'en-IN',
                };
            }
            return {
                answer_status: 'answered',
                candidate_question: false,
                follow_up_question: 'Of course. Take your time; what example comes to mind?',
                language_code: 'en-IN',
                answer,
            };
        },
    };
    const agent = new InterviewAgent({
        llm,
        context: { difficulty: 'Intermediate', candidate: { name: 'Casey' }, requisition: { job_title: 'Engineer' } },
        questions,
    });
    await agent.start();
    await agent.handleCandidate('Yes, this is Casey and now is a good time.');
    const callsAfterConsent = llmCalls;

    for (const response of ['Yes', 'Okay', 'Hmm', 'Right', 'Achha', 'It is so']) {
        const result = await agent.handleCandidate(response);
        assert.equal(result.questionStatus, 'needs_clarification', response);
        assert.equal(agent.currentIndex, 0, response);
        assert.equal(agent.questionStatuses[0], 'needs_clarification', response);
        assert.match(result.reply, /take your time/i);
    }

    assert.equal(llmCalls, callsAfterConsent + 6);
    assert.equal(agent.answers[0], null);
});

test('keeps incomplete or unrelated answers on the current question until a relevant answer arrives', async () => {
    const llm = {
        async complete(messages) {
            const latest = messages.at(-1).content;
            const instruction = messages
                .filter(({ role }) => role === 'system')
                .map(({ content }) => content)
                .join('\n');
            if (instruction.includes('Write the first spoken greeting')) {
                return {
                    reply: 'Hello Casey, this is the interviewer calling about the Engineer role. Is now a good time to talk?',
                    language_code: 'en-IN',
                };
            }
            if (instruction.includes('Classify the latest candidate turn')) {
                return {
                    identity_confirmed: true,
                    permission_granted: true,
                    language_code: 'en-IN',
                };
            }
            if (latest === 'My favorite food is pasta.') {
                return {
                    answer_status: 'needs_clarification',
                    follow_up_question: 'Could you relate that to the caching approach you used?',
                    language_code: 'en-IN',
                };
            }
            return { answer_status: 'answered', language_code: 'en-IN', transition: 'Got it.' };
        },
    };
    const agent = new InterviewAgent({
        llm,
        context: { difficulty: 'Intermediate', candidate: { name: 'Casey' }, requisition: { job_title: 'Engineer' } },
        questions,
    });
    await agent.start();
    await agent.handleCandidate('Yes, this is Casey and now is a good time.');
    const unrelated = await agent.handleCandidate('My favorite food is pasta.');

    assert.equal(unrelated.questionStatus, 'needs_clarification');
    assert.equal(agent.currentIndex, 0);
    assert.equal(agent.answers[0], null);
    assert.match(unrelated.reply, /relate that to the caching approach/i);

    const relevant = await agent.handleCandidate('I used Redis to cache repeated database reads.');
    assert.equal(agent.currentIndex, 1);
    assert.equal(agent.questionStatuses[0], 'answered');
    assert.match(agent.answers[0], /Redis/);
    assert.equal(relevant.questionStatus, 'pending');
});

test('requires confirmation before replacing a contradictory answer', async () => {
    const llm = {
        async complete(messages) {
            const latest = messages.at(-1).content;
            if (latest === 'I worked there for three years.') {
                return {
                    answer_status: 'answered',
                    follow_up_needed: true,
                    follow_up_question: 'How long did that take?',
                    language_code: 'en-IN',
                };
            }
            if (latest === 'Actually, it was two years.') {
                return { answer_status: 'needs_clarification', answer_conflicts_with_prior: true, language_code: 'en-IN' };
            }
            if (latest === 'Use the correction.') {
                return { answer_status: 'answered', correction_confirmed: 'yes', next_question: questions[1], language_code: 'en-IN' };
            }
            return { identity_confirmed: true, permission_granted: true, language_code: 'en-IN' };
        },
    };
    const agent = new InterviewAgent({
        llm,
        context: { difficulty: 'Intermediate', candidate: { name: 'Casey' }, requisition: { job_title: 'Engineer' } },
        questions,
    });
    await agent.start();
    await agent.handleCandidate('Yes, this is Casey and now is a good time.');
    const first = await agent.handleCandidate('I worked there for three years.');
    assert.equal(first.questionStatus, 'pending');
    const correction = await agent.handleCandidate('Actually, it was two years.');

    assert.equal(correction.questionStatus, 'needs_clarification');
    assert.equal(agent.currentIndex, 0);
    assert.equal(agent.answers[0], 'I worked there for three years.');

    await agent.handleCandidate('Use the correction.');
    assert.equal(agent.currentIndex, 1);
    assert.equal(agent.answers[0], 'Actually, it was two years.');
    assert.equal(agent.questionStatuses[0], 'answered');
});

test('accepts a direct yes only for a question that expects a yes/no answer', async () => {
    const yesNoQuestions = [...questions];
    yesNoQuestions[0] = 'Have you used Kubernetes professionally?';
    const llm = {
        async complete(messages) {
            if (messages.some(({ content }) => content.includes('Classify the latest candidate turn'))) {
                return { identity_confirmed: true, permission_granted: true, language_code: 'en-IN' };
            }
            return { answer_status: 'answered', next_question: questions[1], language_code: 'en-IN' };
        },
    };
    const agent = new InterviewAgent({
        llm,
        context: { difficulty: 'Intermediate', candidate: { name: 'Casey' }, requisition: { job_title: 'Engineer' } },
        questions: yesNoQuestions,
    });
    await agent.start();
    await agent.handleCandidate('Yes, this is Casey and now is a good time.');
    const result = await agent.handleCandidate('Yes');

    assert.equal(agent.currentIndex, 1);
    assert.equal(agent.questionStatuses[0], 'answered');
    assert.equal(agent.answers[0], 'Yes');
    assert.equal(result.questionStatus, 'pending');
});

test('uses the previous screening recap when generating the opening', async () => {
    let openingPrompt = '';
    const agent = new InterviewAgent({
        llm: {
            async complete(messages) {
                openingPrompt = messages.map(({ content }) => content).join('\n');
                return {
                    reply: 'Hello Casey, I have a brief note from our earlier conversation. I’ll build on that rather than ask you to repeat it. Is now a good time to talk?',
                    language_code: 'en-IN',
                };
            },
        },
        context: {
            companyName: 'Impact Infotech',
            previousScreeningSummary: 'you described five years of backend development experience.',
            candidate: { name: 'Casey' },
            requisition: { job_title: 'Platform Engineer' },
        },
        questions,
    });

    const opening = (await agent.start()).reply;
    assert.match(openingPrompt, /five years of backend development experience/);
    assert.match(openingPrompt, /prior screening recap/i);
    assert.match(opening, /build on that rather than ask you to repeat it/);
    assert.doesNotMatch(opening, /ten questions|10 questions/i);
});

test('rejects generated question sets with missing or duplicate questions', async () => {
    await assert.rejects(
        () => generateInterviewQuestions({ complete: async () => ({ questions: questions.slice(0, 9) }) }, {
            candidate: {},
            requisition: {},
            difficulty: 'Intermediate',
        }),
        /exactly ten/,
    );
    await assert.rejects(
        () => generateInterviewQuestions({ complete: async () => ({ questions: [...questions.slice(0, 9), questions[0]] }) }, {
            candidate: {},
            requisition: {},
            difficulty: 'Intermediate',
        }),
        /duplicate/,
    );
});
