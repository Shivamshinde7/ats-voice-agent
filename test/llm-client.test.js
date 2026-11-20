import test from 'node:test';
import assert from 'node:assert/strict';
import { parseModelReply, shouldHangUp } from '../src/agents/RecruitmentPrompt.js';
import { callLLMWithRetry, getReplySafely } from '../src/services/llmClient.js';

test('shouldHangUp only accepts approved end reasons and closes completed screenings immediately', () => {
    assert.equal(shouldHangUp({ end_call: false, end_reason: 'asked_to_stop' }, 500), false);
    assert.equal(shouldHangUp({ end_call: true, end_reason: 'unknown' }, 500), false);
    assert.equal(shouldHangUp({ end_call: true, end_reason: 'screening_complete' }, 0), true);
    assert.equal(shouldHangUp({ end_call: true, end_reason: 'screening_complete' }, 300), true);
    assert.equal(shouldHangUp({ end_call: true, end_reason: 'asked_to_stop' }, 0), true);
    assert.equal(shouldHangUp({ end_call: true, end_reason: 'silence_timeout' }, 0), true);
    assert.equal(shouldHangUp({ end_call: true, end_reason: 'max_duration_reached' }, 0), true);
});

test('parseModelReply handles JSON strings and fails safely on malformed JSON', () => {
    const parsed = parseModelReply('```json\n{"reply":"Hello","end_call":false,"language_code":"en-IN"}\n```');
    assert.equal(parsed.reply, 'Hello');
    assert.equal(parsed.end_call, false);

    const malformed = parseModelReply('not json');
    assert.equal(malformed.parse_failed, true);
    assert.equal(malformed.end_call, false);
    assert.equal(typeof malformed.reply, 'string');
});

test('callLLMWithRetry retries malformed JSON with a fresh abort signal', async () => {
    let attempts = 0;
    const signals = [];
    const llm = {
        async complete(_messages, { signal }) {
            attempts += 1;
            signals.push(signal);
            return attempts === 1
                ? '{malformed'
                : '{"reply":"Recovered","end_call":false}';
        },
    };

    const response = await callLLMWithRetry(llm, [], { timeoutMs: 200, retries: 1 });
    assert.equal(response.result.reply, 'Recovered');
    assert.equal(response.attempts, 2);
    assert.notEqual(signals[0], signals[1]);
});

test('getReplySafely returns a spoken fallback after timeout and keeps end_call false', async () => {
    const llm = {
        complete(_messages, { signal }) {
            return new Promise((_, reject) => {
                signal.addEventListener('abort', () => reject(signal.reason), { once: true });
            });
        },
    };

    const result = await getReplySafely(llm, [], { timeoutMs: 10, retries: 1 });
    assert.equal(result._llm.failed, true);
    assert.equal(result._llm.failure, 'timeout');
    assert.equal(result._llm.attempts, 2);
    assert.equal(result.end_call, false);
    assert.match(result.reply, /trouble connecting/i);
});
