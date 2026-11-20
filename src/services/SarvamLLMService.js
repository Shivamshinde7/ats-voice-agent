import { createSarvamRecruitmentLlm } from '../local-test/sarvam-llm.js';

export class SarvamLLMService {
    constructor(config) {
        this.client = createSarvamRecruitmentLlm({
            apiKey: config.apiKey,
            llmModel: config.llmModel,
        });
    }

    complete(messages, options) {
        return this.client.complete(messages, options);
    }
}
