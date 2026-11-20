import { parseModelReply } from '../agents/RecruitmentPrompt.js';

const FALLBACK_REPLY = "I'm sorry, I'm having trouble connecting. Could you please repeat that?";

export function trimHistory(messages, limit = 12) {
    const systemMessages = messages.filter(({ role }) => role === 'system');
    const conversationMessages = messages.filter(({ role }) => role !== 'system').slice(-limit);
    return [...systemMessages, ...conversationMessages];
}

export async function callLLMWithRetry(llm, messages, {
    signal,
    timeoutMs = 2500,
    retries = 1,
} = {}) {
    let lastError;
    for (let attempt = 1; attempt <= retries + 1; attempt += 1) {
        if (signal?.aborted) {
            throw signal.reason ?? new Error('LLM request was aborted.');
        }

        const controller = new AbortController();
        let timeout;
        let rejectAbort;
        const abortPromise = new Promise((_, reject) => {
            rejectAbort = reject;
        });
        const abortFromCaller = () => {
            const reason = signal.reason ?? new Error('LLM request was aborted.');
            controller.abort(reason);
            rejectAbort(reason);
        };
        signal?.addEventListener('abort', abortFromCaller, { once: true });

        try {
            const timeoutPromise = new Promise((_, reject) => {
                timeout = setTimeout(() => {
                    const error = new Error(`LLM request timed out after ${timeoutMs} ms.`);
                    error.name = 'TimeoutError';
                    controller.abort(error);
                    reject(error);
                }, timeoutMs);
            });
            const rawReply = await Promise.race([
                llm.complete(messages, { signal: controller.signal }),
                timeoutPromise,
                abortPromise,
            ]);
            const result = parseModelReply(rawReply);
            if (result.parse_failed) {
                throw new Error('LLM response was not valid JSON.');
            }
            return { result, attempts: attempt };
        } catch (error) {
            if (signal?.aborted) {
                throw signal.reason ?? error;
            }
            lastError = error;
            lastError.attempts = attempt;
        } finally {
            clearTimeout(timeout);
            signal?.removeEventListener('abort', abortFromCaller);
        }
    }

    throw lastError ?? new Error('LLM request failed.');
}

export async function getReplySafely(llm, messages, options = {}) {
    const startedAt = performance.now();
    try {
        const { result, attempts } = await callLLMWithRetry(llm, trimHistory(messages, 12), options);
        return {
            ...result,
            _llm: {
                latencyMs: Math.round(performance.now() - startedAt),
                attempts,
                failed: false,
            },
        };
    } catch (error) {
        if (options.signal?.aborted) {
            throw options.signal.reason ?? error;
        }
        return {
            ...parseModelReply({
                reply: FALLBACK_REPLY,
                end_call: false,
                end_reason: null,
                unclear: false,
            }),
            _llm: {
                latencyMs: Math.round(performance.now() - startedAt),
                attempts: error.attempts ?? (options.retries ?? 1) + 1,
                failed: true,
                failure: error.name === 'TimeoutError' ? 'timeout' : 'request_or_parse_error',
            },
            parse_failed: error.message === 'LLM response was not valid JSON.',
        };
    }
}
