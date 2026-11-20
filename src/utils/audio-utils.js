export function decodeWavPcm16(wav) {
    if (wav.length < 44 || wav.toString('ascii', 0, 4) !== 'RIFF' || wav.toString('ascii', 8, 12) !== 'WAVE') {
        throw new Error('Sarvam returned an invalid WAV response.');
    }

    let offset = 12;
    let format;
    let channels;
    let sampleRate;
    let bitsPerSample;
    let audioData;

    while (offset + 8 <= wav.length) {
        const chunkId = wav.toString('ascii', offset, offset + 4);
        const chunkSize = wav.readUInt32LE(offset + 4);
        const chunkStart = offset + 8;
        const chunkEnd = chunkStart + chunkSize;

        if (chunkEnd > wav.length) {
            throw new Error('Sarvam returned a truncated WAV response.');
        }

        if (chunkId === 'fmt ') {
            format = wav.readUInt16LE(chunkStart);
            channels = wav.readUInt16LE(chunkStart + 2);
            sampleRate = wav.readUInt32LE(chunkStart + 4);
            bitsPerSample = wav.readUInt16LE(chunkStart + 14);
        } else if (chunkId === 'data') {
            audioData = wav.subarray(chunkStart, chunkEnd);
        }

        offset = chunkEnd + (chunkSize % 2);
    }

    if (format !== 1 || ![1, 2].includes(channels) || bitsPerSample !== 16 || !sampleRate || !audioData) {
        throw new Error('Sarvam WAV must contain mono/stereo 16-bit PCM audio.');
    }
    if (audioData.length % (channels * 2) !== 0) {
        throw new Error('Sarvam WAV contains an incomplete PCM sample.');
    }

    if (channels === 1) {
        return { pcm: audioData, sampleRate };
    }

    const mono = Buffer.alloc(audioData.length / 2);
    for (let sourceOffset = 0, targetOffset = 0; sourceOffset + 3 < audioData.length; sourceOffset += 4, targetOffset += 2) {
        const left = audioData.readInt16LE(sourceOffset);
        const right = audioData.readInt16LE(sourceOffset + 2);
        mono.writeInt16LE(Math.round((left + right) / 2), targetOffset);
    }

    return { pcm: mono, sampleRate };
}

export function resamplePcm16(pcm, sourceRate, targetRate) {
    if (sourceRate === targetRate || pcm.length === 0) {
        return pcm;
    }

    if (pcm.length % 2 !== 0 || sourceRate <= 0 || targetRate <= 0) {
        throw new Error('Cannot resample malformed PCM audio.');
    }

    const sourceSamples = pcm.length / 2;
    const targetSamples = Math.ceil(sourceSamples * targetRate / sourceRate);
    const output = Buffer.alloc(targetSamples * 2);

    for (let targetIndex = 0; targetIndex < targetSamples; targetIndex++) {
        const sourcePosition = targetIndex * sourceRate / targetRate;
        const firstIndex = Math.min(Math.floor(sourcePosition), sourceSamples - 1);
        const secondIndex = Math.min(firstIndex + 1, sourceSamples - 1);
        const fraction = sourcePosition - firstIndex;
        const first = pcm.readInt16LE(firstIndex * 2);
        const second = pcm.readInt16LE(secondIndex * 2);
        const sample = Math.max(-32768, Math.min(32767, Math.round(first + (second - first) * fraction)));
        output.writeInt16LE(sample, targetIndex * 2);
    }

    return output;
}

export function packetizePcm16(pcm, chunkSize = 3200) {
    if (chunkSize < 3200 || chunkSize % 320 !== 0 || chunkSize % 2 !== 0 || pcm.length % 2 !== 0) {
        throw new Error('Audio chunk size must be an even multiple of 320 bytes and at least 3200 bytes.');
    }

    const chunks = [];
    for (let offset = 0; offset < pcm.length; offset += chunkSize) {
        let chunk = pcm.subarray(offset, Math.min(offset + chunkSize, pcm.length));
        if (chunk.length < chunkSize) {
            const paddedLength = Math.max(chunkSize, Math.ceil(chunk.length / 320) * 320);
            const padded = Buffer.alloc(paddedLength);
            chunk.copy(padded);
            chunk = padded;
        }
        chunks.push(chunk);
    }

    return chunks;
}

export async function* packetizePcm16Stream(audioChunks, chunkSize = 3200) {
    if (chunkSize < 3200 || chunkSize % 320 !== 0 || chunkSize % 2 !== 0) {
        throw new Error('Audio chunk size must be an even multiple of 320 bytes and at least 3200 bytes.');
    }

    let pending = Buffer.alloc(0);
    let receivedAudio = false;
    for await (const source of audioChunks) {
        const chunk = Buffer.isBuffer(source) ? source : Buffer.from(source);
        if (chunk.length === 0) continue;
        receivedAudio = true;
        pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;

        const completeLength = Math.floor(pending.length / chunkSize) * chunkSize;
        for (let offset = 0; offset < completeLength; offset += chunkSize) {
            yield pending.subarray(offset, offset + chunkSize);
        }
        pending = pending.subarray(completeLength);
    }

    if (!receivedAudio) {
        throw new Error('Sarvam TTS returned an empty audio stream.');
    }
    if (pending.length % 2 !== 0) {
        throw new Error('Sarvam TTS returned an incomplete PCM sample.');
    }
    if (pending.length > 0) {
        const paddedLength = Math.max(chunkSize, Math.ceil(pending.length / 320) * 320);
        const padded = Buffer.alloc(paddedLength);
        pending.copy(padded);
        yield padded;
    }
}
