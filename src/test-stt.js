
import dotenv from "dotenv";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { SarvamAIClient } from "sarvamai";

const currentDir = path.dirname(fileURLToPath(import.meta.url));

const envPath = path.resolve(currentDir, "../../.env");

dotenv.config({ path: envPath });

if (!process.env.SARVAM_API_KEY) {
    console.error("SARVAM_API_KEY is missing.");
    process.exit(1);
}

const client = new SarvamAIClient({
    apiSubscriptionKey: process.env.SARVAM_API_KEY
});

async function testSTT() {
    try {
        console.log("Testing Sarvam Speech-to-Text...");

        const audioPath = path.join(currentDir, "recruiter-test.wav");

        if (!fs.existsSync(audioPath)) {
            throw new Error("Audio file not found: " + audioPath);
        }

        const audioFile = fs.createReadStream(audioPath);

        const response = await client.speechToText.transcribe({
            file: audioFile,
            model: "saaras:v4",
            mode: "transcribe"
        });

        console.log("\n========== STT RESULT ==========");
        console.log("Detected Language:", response.language_code);
        console.log("Recognized Text:", response.transcript);
        console.log("================================");

    } catch (error) {
        console.error("STT Error:", error.message);
        console.error("Status:", error.statusCode);
        console.error("Details:", error.body);
    }
}

testSTT();
