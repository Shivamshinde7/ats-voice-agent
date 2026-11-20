export class InboundAudioProcessor {
    constructor(config, sampleRate) {
        this.config = config;
        this.frameBytes = Math.round(sampleRate / 50) * 2;
        this.highPassCoefficient = Math.exp(-2 * Math.PI * 80 / sampleRate);
        this.pending = Buffer.alloc(0);
        this.previousInput = 0;
        this.previousOutput = 0;
    }

    process(pcm) {
        if (pcm.length % 2 !== 0) {
            throw new Error('Incoming audio must contain complete 16-bit PCM samples.');
        }
        if (!this.config.enabled || (!this.config.noiseSuppression && !this.config.vadEnabled)) {
            return pcm;
        }

        const input = this.pending.length ? Buffer.concat([this.pending, pcm]) : pcm;
        const frameCount = Math.floor(input.length / this.frameBytes);
        const output = Buffer.alloc(frameCount * this.frameBytes);

        for (let frameIndex = 0; frameIndex < frameCount; frameIndex += 1) {
            const inputStart = frameIndex * this.frameBytes;
            const outputStart = inputStart;
            let sumSquares = 0;

            for (let sampleIndex = 0; sampleIndex < this.frameBytes; sampleIndex += 2) {
                const sample = input.readInt16LE(inputStart + sampleIndex);
                let filtered = sample;
                if (this.config.noiseSuppression) {
                    filtered = sample - this.previousInput + this.highPassCoefficient * this.previousOutput;
                    this.previousInput = sample;
                    filtered = Math.max(-32768, Math.min(32767, Math.round(filtered)));
                    this.previousOutput = filtered;
                }
                output.writeInt16LE(filtered, outputStart + sampleIndex);
                sumSquares += filtered * filtered;
            }

            const sampleCount = this.frameBytes / 2;
            const rms = Math.sqrt(sumSquares / sampleCount) / 32768;
            const levelDb = rms > 0 ? 20 * Math.log10(rms) : -Infinity;
            if (this.config.vadEnabled && levelDb < this.config.vadThresholdDb) {
                output.fill(0, outputStart, outputStart + this.frameBytes);
            }
        }

        const consumedBytes = frameCount * this.frameBytes;
        this.pending = input.subarray(consumedBytes);
        return output;
    }
}
