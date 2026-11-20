import test from 'node:test';
import assert from 'node:assert/strict';
import { packetizePcm16, packetizePcm16Stream, resamplePcm16 } from '../src/utils/audio-utils.js';
import { InboundAudioProcessor } from '../src/services/inbound-audio-processor.service.js';

const audioConfig = {
    enabled: true,
    noiseSuppression: false,
    vadEnabled: true,
    vadThresholdDb: -42,
};

test('packetizes PCM into Exotel-compatible audio chunks', () => {
    const pcm = Buffer.alloc(6400, 1);
    const chunks = packetizePcm16(pcm);

    assert.equal(chunks.length, 2);
    assert.deepEqual(chunks.map((chunk) => chunk.length), [3200, 3200]);
});

test('pads the final PCM chunk to the supported minimum size', () => {
    const chunks = packetizePcm16(Buffer.alloc(1000, 1));

    assert.equal(chunks.length, 1);
    assert.equal(chunks[0].length, 3200);
    assert.equal(chunks[0].readUInt8(0), 1);
    assert.equal(chunks[0].readUInt8(1000), 0);
});

test('packetizes streamed PCM across arbitrary response boundaries', async () => {
    const pcm = Buffer.alloc(6400);
    for (let offset = 0; offset < pcm.length; offset += 1) pcm[offset] = offset % 256;
    const source = (async function* () {
        yield pcm.subarray(0, 1001);
        yield pcm.subarray(1001, 4200);
        yield pcm.subarray(4200);
    }());
    const chunks = [];
    for await (const chunk of packetizePcm16Stream(source)) chunks.push(chunk);

    assert.deepEqual(chunks.map((chunk) => chunk.length), [3200, 3200]);
    assert.deepEqual(Buffer.concat(chunks), pcm);
});

test('pads the final streamed PCM packet and rejects incomplete samples', async () => {
    const source = (async function* () {
        yield Buffer.alloc(1000, 1);
    }());
    const chunks = [];
    for await (const chunk of packetizePcm16Stream(source)) chunks.push(chunk);

    assert.equal(chunks.length, 1);
    assert.equal(chunks[0].length, 3200);
    assert.equal(chunks[0].readUInt8(1000), 0);

    await assert.rejects(async () => {
        for await (const _chunk of packetizePcm16Stream([Buffer.alloc(1)])) {}
    }, /incomplete PCM sample/);
});

test('resamples signed 16-bit PCM and preserves the sample count ratio', () => {
    const pcm = Buffer.alloc(8);
    pcm.writeInt16LE(0, 0);
    pcm.writeInt16LE(1000, 2);
    pcm.writeInt16LE(2000, 4);
    pcm.writeInt16LE(3000, 6);

    const result = resamplePcm16(pcm, 16000, 8000);

    assert.equal(result.length, 4);
});

test('gates quiet frames and preserves speech-level PCM', () => {
    const processor = new InboundAudioProcessor(audioConfig, 8000);
    const quiet = Buffer.alloc(320);
    const speech = Buffer.alloc(320);
    for (let offset = 0; offset < speech.length; offset += 2) {
        speech.writeInt16LE(4000, offset);
    }

    const quietResult = processor.process(quiet);
    const speechResult = processor.process(speech);

    assert.equal(quietResult.length, quiet.length);
    assert.equal(quietResult.every((sample) => sample === 0), true);
    assert.equal(speechResult.readInt16LE(0), 4000);
});

test('buffers incomplete frames without corrupting PCM', () => {
    const processor = new InboundAudioProcessor({ ...audioConfig, vadThresholdDb: -100 }, 8000);
    const first = Buffer.alloc(100, 1);
    const second = Buffer.alloc(220, 2);

    assert.equal(processor.process(first).length, 0);
    const result = processor.process(second);

    assert.equal(result.length, 320);
    assert.equal(result.readUInt8(0), 1);
    assert.equal(result.readUInt8(100), 2);
});
