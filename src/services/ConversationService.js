import { RecruitmentAgent } from '../agents/recruitment-agent.js';

export class ConversationService {
    constructor({ llm, candidate, requisition, companyName, questions, llmTimeoutMs, llmRetries }) {
        this.agent = new RecruitmentAgent({
            llm,
            candidate,
            requisition,
            companyName,
            questions,
            llmTimeoutMs,
            llmRetries,
        });
    }

    start() {
        return this.agent.start();
    }

    handleCandidate(transcript, languageCode, options) {
        return this.agent.handleCandidate(transcript, languageCode, options);
    }

    checkpoint() {
        return this.agent.checkpoint();
    }

    restore(checkpoint) {
        this.agent.restore(checkpoint);
    }

    clarifyUnheard(languageCode) {
        return this.agent.clarifyUnheard(languageCode);
    }

    summarize() {
        return this.agent.summarize();
    }

    transcript() {
        return this.agent.transcript();
    }

    result() {
        return this.agent.result();
    }

    screeningProgress() {
        return this.agent.screeningProgress();
    }

    elapsedSeconds() {
        return this.agent.elapsedSeconds();
    }

    get canSummarize() {
        return this.agent.canSummarize;
    }

    get messages() {
        return this.agent.messages;
    }
}
