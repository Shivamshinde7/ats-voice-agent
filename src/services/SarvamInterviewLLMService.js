import { SarvamAIClient } from 'sarvamai';

export class SarvamInterviewLLMService {
    constructor(config) {
        if (!config.apiKey) throw new Error('SARVAM_API_KEY is required for AI interviews.');
        this.client = new SarvamAIClient({
            apiSubscriptionKey: config.apiKey,
            maxRetries: 0,
        });
        this.model = config.llmModel;
        this.timeoutMs = config.timeoutMs ?? 60000;
    }

    async complete(messages, { signal } = {}) {
        const stream = await this.client.chat.completions({
            model: this.model,
            messages,
            temperature: 0.25,
            max_tokens: 1800,
            response_format: { type: 'json_object' },
            stream: true,
        }, {
            abortSignal: signal
                ? AbortSignal.any([signal, AbortSignal.timeout(this.timeoutMs)])
                : AbortSignal.timeout(this.timeoutMs),
        });
        let content = '';
        for await (const chunk of stream) {
            content += chunk?.choices?.[0]?.delta?.content || '';
        }
        if (!content.trim()) {
            throw new Error('Sarvam returned an empty AI interview response.');
        }
        try {
            const result = JSON.parse(content);
            if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error();
            return result;
        } catch {
            throw new Error('Sarvam returned invalid JSON for the AI interview.');
        }
    }
}
