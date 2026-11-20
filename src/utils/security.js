import { createHmac, timingSafeEqual } from 'node:crypto';

function safeEqual(left, right) {
    const leftBuffer = Buffer.from(left);
    const rightBuffer = Buffer.from(right);

    return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

export function isAuthorizedBearer(header, token) {
    const supplied = /^Bearer (.+)$/i.exec(header || '')?.[1] || '';

    return Boolean(token && safeEqual(supplied, token));
}

export function createStreamSignature(callId, issuedAt, secret) {
    return createHmac('sha256', secret).update(`${callId}:${issuedAt}`).digest('hex');
}

export function verifyStreamSignature(callId, issuedAt, signature, secret, now = Date.now()) {
    const issuedAtNumber = Number(issuedAt);
    if (!Number.isInteger(issuedAtNumber) || Math.abs(Math.floor(now / 1000) - issuedAtNumber) > 300) {
        return false;
    }

    return safeEqual(createStreamSignature(callId, issuedAtNumber, secret), signature || '');
}

export function signWebhookBody(body, timestamp, secret) {
    return createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
}
