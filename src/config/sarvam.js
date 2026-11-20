import { SarvamAI } from "sarvamai";

const sarvam = new SarvamAI({
    apiSubscriptionKey: process.env.SARVAM_API_KEY
});

export default sarvam;