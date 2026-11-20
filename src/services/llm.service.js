export async function createLlmClient(config) {
    return {
        async complete(messages, { signal } = {}) {
            const baseUrl = config.baseUrl.replace(/\/$/, '');
            const endpoint = baseUrl.endsWith('/chat/completions')
                ? baseUrl
                : `${baseUrl}/chat/completions`;
            const response = await fetch(endpoint, {
                method: 'POST',
                headers: {
                    Authorization: `Bearer ${config.apiKey}`,
                    'content-type': 'application/json',
                },
                body: JSON.stringify({
                    model: config.model,
                    messages,
                    temperature: 0.3,
                    max_tokens: 700,
                    response_format: { type: 'json_object' },
                }),
                signal,
            });

            if (!response.ok) {
                throw new Error(`LLM request failed with HTTP ${response.status}.`);
            }

            const payload = await response.json();
            const content = payload?.choices?.[0]?.message?.content;
            if (typeof content !== 'string' || !content.trim()) {
                throw new Error('LLM returned an empty response.');
            }

            try {
                const result = JSON.parse(content);
                if (!result || typeof result !== 'object' || Array.isArray(result)) {
                    throw new Error();
                }
                return result;
            } catch {
                throw new Error('LLM response was not valid JSON.');
            }
        },
    };
}
