import { SarvamAIClient } from 'sarvamai';

export function createSarvamRecruitmentLlm(config) {
    if (!config.apiKey) {
        throw new Error('SARVAM_API_KEY is required for the local test server.');
    }

    const client = new SarvamAIClient({
        apiSubscriptionKey: config.apiKey,
        maxRetries: 0,
    });

    return {
        async complete(messages, { signal } = {}) {
            const response = await client.chat.completions({
                model: config.llmModel,
                messages,
                temperature: 0.3,
                max_tokens: 700,
                response_format: { type: 'json_object' },
            }, { abortSignal: signal });

            const content = response?.choices?.[0]?.message?.content;
            if (typeof content !== 'string' || !content.trim()) {
                throw new Error('Sarvam LLM returned an empty response.');
            }

            try {
                const result = JSON.parse(content);
                if (!result || typeof result !== 'object' || Array.isArray(result)) {
                    throw new Error();
                }
                return result;
            } catch {
                throw new Error('Sarvam LLM response was not valid JSON.');
            }
        },
    };
}
