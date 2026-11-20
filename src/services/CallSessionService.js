import { randomUUID } from 'node:crypto';
import { createLocalTestCall, updateLocalTestCall } from '../local-test/laravel-client.js';
import { signWebhookBody } from '../utils/security.js';

export class CallSessionService {
    constructor(config) {
        this.config = config;
    }

    async createBrowserSession(record) {
        const testCallId = randomUUID();
        const call = await createLocalTestCall(this.config, {
            test_call_id: testCallId,
            candidate_id: record.candidate_id,
            initiated_by: record.initiated_by,
            ...(record.browser_context_expires
                ? {
                    browser_context_expires: record.browser_context_expires,
                    browser_context_signature: record.browser_context_signature,
                }
                : {}),
            browser_mode: record.browser_mode || 'screening',
            ...(record.interview_session_id
                ? { interview_session_id: record.interview_session_id }
                : {}),
        });

        return {
            ai_call_id: call.ai_call_id,
            test_call_id: testCallId,
            context: call.context,
        };
    }

    updateBrowserSession(testCallId, update) {
        return updateLocalTestCall(this.config, testCallId, update);
    }

    async updateExotelSession(payload) {
        const timestamp = String(Math.floor(Date.now() / 1000));
        const body = JSON.stringify(payload);
        const response = await fetch(this.config.laravelWebhookUrl, {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                'X-AI-Calling-Timestamp': timestamp,
                'X-AI-Calling-Signature': signWebhookBody(body, timestamp, this.config.sharedSecret),
            },
            body,
            signal: AbortSignal.timeout(10000),
        });

        if (!response.ok) {
            throw new Error(`Laravel call update failed with HTTP ${response.status}.`);
        }
    }
}
