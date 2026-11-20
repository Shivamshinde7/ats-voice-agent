import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { RecruitmentAgent } from './agents/recruitment-agent.js';
import { SarvamLLMService } from './services/SarvamLLMService.js';
import { loadConfig } from './config/env.js';

const currentDir = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(currentDir, '../../.env') });

async function main() {
    const config = loadConfig();
    if (!config.sarvam.apiKey) {
        throw new Error('SARVAM_API_KEY is required to test the recruiter prompt.');
    }

    let context;
    try {
        context = JSON.parse(process.env.AI_CALLING_TEST_CONTEXT_JSON || '');
    } catch {
        throw new Error('Set AI_CALLING_TEST_CONTEXT_JSON to a JSON object with candidate, requisition, company_name, and screening_questions.');
    }
    if (!context?.candidate || !context?.requisition || !context?.company_name
        || !Array.isArray(context?.screening_questions)) {
        throw new Error('AI_CALLING_TEST_CONTEXT_JSON must include candidate, requisition, company_name, and screening_questions.');
    }

    const agent = new RecruitmentAgent({
        llm: new SarvamLLMService(config.sarvam),
        candidate: context.candidate,
        requisition: context.requisition,
        companyName: context.company_name,
        questions: context.screening_questions,
    });
    const opening = await agent.start();
    console.log('Sarvam recruiter opening:');
    console.log(opening.reply);
}

main().catch((error) => {
    console.error('Sarvam recruiter prompt test failed:', error.message);
    process.exitCode = 1;
});
