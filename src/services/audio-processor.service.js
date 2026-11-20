import { packetizePcm16 } from '../utils/audio-utils.js';

export function makeExotelMediaEvent(streamSid, pcm) {
    return JSON.stringify({
        event: 'media',
        stream_sid: streamSid,
        media: { payload: pcm.toString('base64') },
    });
}

export function makeExotelMediaEvents(streamSid, pcm) {
    return packetizePcm16(pcm).map((chunk) => makeExotelMediaEvent(streamSid, chunk));
}
