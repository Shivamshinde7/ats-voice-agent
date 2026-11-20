import test from 'node:test';
import assert from 'node:assert/strict';
import { RecruitmentAgent } from '../src/agents/recruitment-agent.js';

const knownCandidate = {
    name: 'Test Candidate',
    current_company: 'Known Company',
    current_designation: 'Platform Engineer',
    experience_years: '8 years',
    relevant_experience: '5 years',
    skills: 'Kubernetes, Go',
    current_ctc: '20 LPA',
    expected_ctc: '25 LPA',
    notice_period: '30 days',
};

const screeningQuestions = [
    { id: 'interest', stage: 'opportunity', text: 'Confirm interest.' },
    { id: 'technical_basic_1', stage: 'technical', level: 'basic', text: 'Ask a basic question about Kubernetes.' },
    { id: 'technical_basic_2', stage: 'technical', level: 'basic', text: 'Ask a basic question about Go.' },
    { id: 'technical_basic_3', stage: 'technical', level: 'basic', text: 'Ask a basic question about platform operations.' },
    { id: 'technical_advanced', stage: 'technical', level: 'advanced', text: 'Do not ask this question.' },
    { id: 'current_ctc', stage: 'availability', text: 'Ask current CTC.' },
];

const createAgent = (llm, candidate = knownCandidate, questions = screeningQuestions, options = {}) => {
    const candidateName = typeof candidate.name === 'string' ? candidate.name : 'the candidate';
    const openingAwareLlm = {
        async complete(messages, requestOptions) {
            const request = messages.at(-1)?.content;
            let task = '';
            try {
                task = JSON.parse(request).task || '';
            } catch {
                task = '';
            }
            if (task.startsWith('Start with Hello')) {
                return {
                    reply: `Hello, main Isha Impact Infotech ki recruiting team se bol rahi hoon. Kya main ${candidateName} se baat kar rahi hoon?`,
                    language_code: 'hi-IN',
                };
            }
            return llm.complete(messages, requestOptions);
        },
    };

    return new RecruitmentAgent({
        llm: openingAwareLlm,
        candidate,
        requisition: {
            job_title: 'Platform Engineer',
            skills: 'Kubernetes, Go',
            job_description: 'Build and maintain container platforms.',
            location: 'Bengaluru',
        },
        companyName: 'Impact Infotech',
        questions,
        ...options,
    });
};

test('tracks four stages server-side, asks three basic skill questions, and closes after Stage 4', async () => {
    const replies = [
        { reply: 'Is now a good time to talk?', candidate_identity_confirmed: true, language_code: 'en-IN' },
        { reply: 'This is a Platform Engineer role in Bengaluru. Are you interested?', candidate_consented: true, language_code: 'en-IN' },
        { reply: 'What is a Kubernetes pod?', language_code: 'en-IN' },
        { reply: 'How does a service route traffic?', language_code: 'en-IN' },
        { reply: 'What is one basic Go concept you use?', language_code: 'en-IN' },
        { reply: 'When would you be available for an interview?', language_code: 'en-IN' },
        { reply: 'Thank you for your time. I’ll share this with the recruiter.', language_code: 'en-IN' },
        {
            reply: 'Thank you for your time. I’ll share this with the recruiter.',
            summary: 'The candidate expressed interest and discussed experience relevant to the requisition.',
            recommendation: 'proceed',
            recommendation_reason: 'The candidate provided relevant experience and screening answers.',
            strengths: ['Relevant platform experience'],
            concerns: [],
        },
        {
            reply: 'Thank you for your time.',
            summary: 'The candidate completed the screening.',
            recommendation: 'proceed',
            recommendation_reason: 'The screening was completed.',
            strengths: [],
            concerns: [],
        },
    ];
    const agent = createAgent({
        complete: async () => replies.shift() || {
            reply: 'Thank you for your time.',
            summary: 'The candidate completed the screening.',
            recommendation: 'proceed',
            recommendation_reason: 'The screening was completed.',
            strengths: [],
            concerns: [],
        },
    });

    const opening = await agent.start();
    assert.match(opening.reply, /recruiting team/i);
    assert.match(opening.reply, /Test Candidate/);
    const identity = await agent.handleCandidate('Yes, this is Test Candidate.', 'en-IN');
    assert.equal(identity.progress.current_stage, 'opportunity');

    const consent = await agent.handleCandidate('Yes, now is fine.', 'en-IN');
    assert.equal(consent.progress.current_stage, 'opportunity');
    assert.equal(agent.questions.filter(({ stage }) => stage === 'technical').length, 3);
    assert.equal(agent.questions.some(({ id }) => id === 'technical_advanced'), false);
    assert.equal(agent.questions.some(({ id }) => id === 'current_ctc'), false);

    await agent.handleCandidate('Yes, I am interested.', 'en-IN');
    assert.equal(agent.screeningProgress().current_stage, 'technical');
    await agent.handleCandidate('A pod is the smallest deployable unit.', 'en-IN');
    await agent.handleCandidate('A service routes network traffic to pods.', 'en-IN');
    const stageFour = await agent.handleCandidate('I use Go for platform tooling.', 'en-IN');
    assert.equal(stageFour.progress.current_stage, 'availability');

    const completed = await agent.handleCandidate('Next week works for an interview.', 'en-IN');
    assert.equal(completed.completed, true);
    assert.equal(completed.endReason, 'screening_complete');
    assert.equal(completed.progress.screening_complete, true);
    assert.deepEqual(completed.progress.stages.map(({ status }) => status), [
        'completed', 'completed', 'completed', 'completed',
    ]);
    assert.equal(agent.answers.interview_availability, 'Next week works for an interview.');

    const summary = await agent.summarize();
    assert.equal(summary.recommendation, 'proceed');
    assert.equal(summary.screening.screening_complete, true);
});

test('records an unknown short answer once and advances without clarification', async () => {
    const agent = createAgent({
        complete: async () => ({
            reply: 'Could you briefly describe your background?',
            end_call: true,
            end_reason: 'asked_to_stop',
            language_code: 'en-IN',
        }),
    }, { name: 'Test Candidate' });
    agent.stage = 'screening';
    agent.screeningStartedAt = 0;

    const result = await agent.handleCandidate("I don't know.", 'en-IN');

    assert.equal(result.completed, false);
    assert.equal(agent.answers.interest, 'Candidate did not know / answer not provided.');
    assert.notEqual(agent.currentQuestion.id, 'interest');
    assert.equal(result.reply, 'Could you briefly describe your background?');
});

test('does not advance an unanswered topic when the candidate interrupts with a question', async () => {
    const replies = [
        {
            reply: 'The role is based in Bengaluru. Are you interested in exploring it?',
            candidate_question: true,
            current_topic_answered: false,
            language_code: 'en-IN',
        },
        {
            reply: 'What is your experience with Kubernetes?',
            current_topic_answered: true,
            language_code: 'en-IN',
        },
    ];
    const agent = createAgent({ complete: async () => replies.shift() });
    agent.stage = 'screening';
    agent.screeningStartedAt = 0;

    await agent.handleCandidate('What is the work location?', 'en-IN');
    assert.equal(agent.answers.interest, undefined);
    assert.equal(agent.currentQuestion.id, 'interest');

    await agent.handleCandidate('Yes, I am interested.', 'en-IN');
    assert.equal(agent.answers.interest, 'Yes, I am interested.');
    assert.equal(agent.currentQuestion.id, 'technical_basic_1');
});

test('accepts a short affirmative for the interest question', async () => {
    const agent = createAgent({
        complete: async () => ({
            reply: 'Great. What is a Kubernetes pod?',
            current_topic_answered: true,
            language_code: 'en-IN',
        }),
    });
    agent.stage = 'screening';
    agent.screeningStartedAt = Date.now();

    await agent.handleCandidate('Okay', 'en-IN');
    assert.equal(agent.answers.interest, undefined);
    assert.equal(agent.currentQuestion.id, 'interest');

    await agent.handleCandidate('Yes', 'en-IN');

    assert.equal(agent.answers.interest, 'Yes');
    assert.equal(agent.currentQuestion.id, 'technical_basic_1');
});

test('does not accept short acknowledgements as answers to open-ended screening topics', async () => {
    const agent = createAgent({
        complete: async () => ({
            reply: 'Take your time.',
            current_topic_answered: true,
            language_code: 'en-IN',
        }),
    });
    agent.stage = 'screening';
    agent.screeningStartedAt = Date.now();
    agent.answers.interest = 'Yes';
    agent.refreshQuestions();
    const topic = agent.currentQuestion;

    await agent.handleCandidate('Okay', 'en-IN');
    assert.equal(agent.answers[topic.id], undefined);
    assert.equal(agent.currentQuestion.id, topic.id);

    await agent.handleCandidate('Haan', 'hi-IN');
    assert.equal(agent.answers[topic.id], undefined);
    assert.equal(agent.currentQuestion.id, topic.id);
});

test('uses the spoken screening question to allow a yes/no answer when appropriate', async () => {
    const agent = createAgent({
        complete: async () => ({
            reply: 'What did you use it for?',
            current_topic_answered: true,
            language_code: 'en-IN',
        }),
    });
    agent.stage = 'screening';
    agent.screeningStartedAt = Date.now();
    agent.answers.interest = 'Yes';
    agent.refreshQuestions();
    agent.messages.push({ role: 'assistant', content: 'Have you used Kubernetes in production?' });

    await agent.handleCandidate('Yes', 'en-IN');

    assert.equal(agent.answers.technical_basic_1, 'Yes');
    assert.equal(agent.currentQuestion.id, 'technical_basic_2');
});

test('keeps acknowledgement-only screening turns pending until the candidate answers', async () => {
    const responses = [
        { reply: 'Of course. Take your time.', current_topic_answered: false, language_code: 'en-IN' },
        {
            reply: 'No problem. What example comes to mind?',
            current_topic_answered: false,
            end_call: true,
            end_reason: 'asked_to_stop',
            language_code: 'en-IN',
        },
        { reply: 'That makes sense. What is a Kubernetes pod?', current_topic_answered: true, language_code: 'en-IN' },
    ];
    let prompt = '';
    const agent = createAgent({
        complete: async (messages) => {
            prompt = messages.map(({ content }) => content).join('\n');
            return responses.shift();
        },
    });
    agent.stage = 'screening';
    agent.screeningStartedAt = Date.now();
    agent.answers.interest = 'Yes';
    agent.refreshQuestions();
    const currentTopic = agent.currentQuestion;

    await agent.handleCandidate('Okay', 'en-IN');
    assert.equal(agent.answers[currentTopic.id], undefined);
    assert.equal(agent.currentQuestion.id, currentTopic.id);
    assert.match(prompt, /current_topic_answered/);

    await agent.handleCandidate('It is so', 'en-IN');
    assert.equal(agent.answers[currentTopic.id], undefined);
    assert.equal(agent.currentQuestion.id, currentTopic.id);

    await agent.handleCandidate('A Kubernetes pod is the smallest deployable unit.', 'en-IN');
    assert.equal(agent.answers[currentTopic.id], 'A Kubernetes pod is the smallest deployable unit.');
    assert.equal(agent.currentQuestion.id, 'technical_basic_2');
});

test('asks only for missing background and Stage 4 fields, skipping profile details', () => {
    const agent = createAgent({ complete: async () => ({}) }, {
        name: 'Test Candidate',
        current_company: 'Known Company',
        current_designation: 'Platform Engineer',
        experience_years: '8 years',
        relevant_experience: '5 years',
        skills: 'Kubernetes',
        current_ctc: '20 LPA',
    });

    assert.equal(agent.questions.some(({ id }) => id === 'candidate_background'), false);
    assert.equal(agent.questions.some(({ id }) => id === 'current_ctc'), false);
    assert.equal(agent.questions.some(({ id }) => id === 'expected_ctc'), true);
    assert.equal(agent.questions.some(({ id }) => id === 'notice_period'), true);
    assert.equal(agent.questions.some(({ id }) => id === 'interview_availability'), true);
});

test('ends politely when the person is not the named candidate', async () => {
    const agent = createAgent({
        complete: async () => ({
            reply: 'Sorry about that. Thank you for your time.',
            candidate_declined: true,
            end_call: true,
            end_reason: 'not_candidate',
            language_code: 'en-IN',
        }),
    });

    await agent.start();
    const result = await agent.handleCandidate('No, you have the wrong number.', 'en-IN');

    assert.equal(result.completed, true);
    assert.equal(agent.stage, 'complete');
    assert.equal(agent.candidateConsentAt, null);
});

test('asks for an unclear identity response without advancing', async () => {
    const agent = createAgent({
        complete: async () => ({
            reply: 'I heard something unclear.',
            unclear: true,
            candidate_identity_confirmed: false,
            language_code: 'en-IN',
        }),
    });

    await agent.start();
    const result = await agent.handleCandidate('...', 'en-IN');

    assert.equal(result.completed, false);
    assert.equal(agent.stage, 'identity');
    assert.match(result.reply, /couldn’t hear that clearly/i);
});

test('short identity replies and LLM timeouts do not complete the call', async () => {
    const shortReplyAgent = createAgent({
        complete: async () => ({
            reply: 'Goodbye.',
            end_call: true,
            end_reason: 'asked_to_stop',
            language_code: 'en-IN',
        }),
    });
    await shortReplyAgent.start();
    const shortReply = await shortReplyAgent.handleCandidate('hmm', 'en-IN');
    assert.equal(shortReply.completed, false);
    assert.equal(shortReplyAgent.stage, 'identity');

    const timeoutAgent = createAgent({ complete: () => new Promise(() => {}) }, knownCandidate, screeningQuestions, {
        llmTimeoutMs: 10,
        llmRetries: 0,
    });
    await timeoutAgent.start();
    const timeout = await timeoutAgent.handleCandidate('Yes, this is Test Candidate.', 'en-IN');
    assert.equal(timeout.completed, false);
    assert.equal(timeoutAgent.stage, 'identity');
    assert.match(timeout.reply, /trouble connecting/i);
});
