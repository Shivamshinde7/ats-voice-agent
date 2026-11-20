import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const envPath = path.resolve(currentDir, "../../.env");
const projectEnvPath = path.resolve(currentDir, "../.env");
const result = dotenv.config({ path: envPath });
const projectResult = dotenv.config({ path: projectEnvPath });

if (!process.env.SARVAM_API_KEY) {
    if (result.error && projectResult?.error) {
        console.error(`Unable to load a Laravel or voice-agent environment file (${envPath}, ${projectEnvPath}).`);
    } else {
        console.error("SARVAM_API_KEY is missing from the Laravel and voice-agent environment files.");
    }
    process.exit(1);
}

console.log("Sarvam API key loaded successfully!");