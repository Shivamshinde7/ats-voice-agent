import test from 'node:test';
import assert from 'node:assert/strict';
import {
    createStreamSignature,
    isAuthorizedBearer,
    signWebhookBody,
    verifyStreamSignature,
} from '../src/utils/security.js';

test('requires the expected service bearer token', () => {
    assert.equal(isAuthorizedBearer('Bearer right-token', 'right-token'), true);
    assert.equal(isAuthorizedBearer('Bearer wrong-token', 'right-token'), false);
    assert.equal(isAuthorizedBearer('', 'right-token'), false);
});

test('accepts only recent signed stream URLs', () => {
    const now = 1_800_000_000_000;
    const issuedAt = Math.floor(now / 1000);
    const signature = createStreamSignature('42', issuedAt, 'test-secret');

    assert.equal(verifyStreamSignature('42', String(issuedAt), signature, 'test-secret', now), true);
    assert.equal(verifyStreamSignature('43', String(issuedAt), signature, 'test-secret', now), false);
    assert.equal(verifyStreamSignature('42', String(issuedAt - 301), signature, 'test-secret', now), false);
});

test('signs the exact Laravel webhook body with its timestamp', () => {
    const body = '{"ai_call_id":42,"status":"completed"}';
    const first = signWebhookBody(body, '1800000000', 'secret');
    const second = signWebhookBody(body, '1800000001', 'secret');

    assert.notEqual(first, second);
    assert.equal(first.length, 64);
});
