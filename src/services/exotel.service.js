export async function startExotelCall(config, request) {
    const form = new FormData();
    form.append('From', request.phone);
    form.append('CallerId', config.callerId);
    form.append('StreamUrl', request.stream_url);
    form.append('StreamType', 'bidirectional');
    form.append('CustomField', String(request.ai_call_id).slice(0, 128));
    form.append('TimeLimit', String(config.maxCallDurationSeconds ?? 360));

    const credentials = Buffer.from(`${config.apiKey}:${config.apiToken}`).toString('base64');
    const url = `${config.baseUrl.replace(/\/$/, '')}/v1/Accounts/${encodeURIComponent(config.accountSid)}/Calls/connect`;
    const response = await fetch(url, {
        method: 'POST',
        headers: { Authorization: `Basic ${credentials}` },
        body: form,
        signal: AbortSignal.timeout(15000),
    });

    if (!response.ok) {
        throw new Error(`Exotel call request failed with HTTP ${response.status}.`);
    }

    let payload;
    try {
        payload = await response.json();
    } catch {
        throw new Error('Exotel returned a non-JSON call response.');
    }

    const providerCallId = payload?.Call?.Sid;
    if (typeof providerCallId !== 'string' || !providerCallId) {
        throw new Error('Exotel response did not contain a call SID.');
    }

    return {
        provider_call_id: providerCallId,
        status: payload.Call.Status === 'in-progress' ? 'in-progress' : 'queued',
    };
}

export async function hangupExotelCall(config, providerCallId) {
    if (!providerCallId) {
        throw new Error('Cannot hang up an Exotel call without its provider call ID.');
    }

    const form = new FormData();
    form.append('Status', 'completed');
    const credentials = Buffer.from(`${config.apiKey}:${config.apiToken}`).toString('base64');
    const url = `${config.baseUrl.replace(/\/$/, '')}/v1/Accounts/${encodeURIComponent(config.accountSid)}`
        + `/Calls/${encodeURIComponent(providerCallId)}.json`;
    const response = await fetch(url, {
        method: 'PUT',
        headers: { Authorization: `Basic ${credentials}` },
        body: form,
        signal: AbortSignal.timeout(15000),
    });

    if (!response.ok) {
        throw new Error(`Exotel call hang-up failed with HTTP ${response.status}.`);
    }
}
