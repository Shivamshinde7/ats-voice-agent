import dotenv from "dotenv";
import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import { SarvamAIClient } from "sarvamai";

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const envPath = path.resolve(currentDir, "../../.env");
const envResult = dotenv.config({ path: envPath });

if (envResult.error && !process.env.SARVAM_API_KEY) {
    console.error(`Unable to load the Laravel environment file at ${envPath}.`);
    process.exitCode = 1;
} else if (!process.env.SARVAM_API_KEY) {
    console.error("SARVAM_API_KEY is missing from the Laravel .env file.");
    process.exitCode = 1;
} else {
    const client = new SarvamAIClient({
        apiSubscriptionKey: process.env.SARVAM_API_KEY
    });

    try {
        console.log("Testing Sarvam TTS...");

      const response = await client.textToSpeech.convert({
    model: "bulbul:v4-flash",
    text: `Hello Rahul ji! Good morning.
मेरा नाम HR team से है और मैं Impact Infotech से बात कर रहा हूँ।

Am I speaking with Rahul?

आपने हमारी company में Laravel Developer के लिए application submit किया था।

I just wanted to check, are you currently looking for a job and would you be interested in exploring this opportunity?

क्या अभी आपके पास 2 से 3 मिनट बात करने का समय है?`,
    language_code: "hi-IN",
    speaker: "ishita_enhi_customer",
    output_audio_codec: "wav",
    speech_sample_rate: 8000
});

        if (!Array.isArray(response?.audios) || response.audios.length === 0 ||
            response.audios.some((audio) => typeof audio !== "string" || !audio)) {
            throw new Error("Sarvam TTS returned an empty or invalid audio response.");
        }

        const audioBuffer = Buffer.from(response.audios.join(""), "base64");
        if (audioBuffer.length === 0) {
            throw new Error("Sarvam TTS returned empty audio data.");
        }

        const outputPath = path.join(currentDir, "recruiter-test.wav");
        await fs.writeFile(outputPath, audioBuffer);

        console.log("Audio generated successfully.");
        console.log("Saved at:", outputPath);
    } catch (error) {
        console.error("Sarvam TTS test failed:", error.message);
        process.exitCode = 1;
    }
}
