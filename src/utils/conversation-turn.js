const BACKCHANNEL_PHRASES = [
    'okay', 'ok', 'yes', 'yeah', 'yep', 'yup', 'hmm', 'hm', 'mm', 'mmm', 'uh', 'um',
    'great', 'fine', 'sure', 'right', 'good', 'alright', 'it is so', 'it s so', 'thats right',
    'that s right', 'that is right',
    'no', 'nope', 'nah', 'nahi', 'nahin', 'nahi ji', 'nahin ji', 'no thanks',
    'yes please', 'sure please',
    'sounds good', 'uh-huh', 'mm-hmm', 'uh huh', 'mm hmm',
    'ha', 'haan', 'han', 'hanji', 'ji', 'achha', 'accha', 'acha', 'theek hai', 'thik hai',
    'thik', 'theek', 'haan ji', 'ji haan', 'haan haan', 'bilkul', 'sahi',
    'हो', 'हां', 'हाँ', 'जी', 'अच्छा', 'ठीक', 'ठीक है',
    'હા', 'સારું', 'હા જી', 'હા સારું', 'બરાબર', 'બરું', 'बरं',
    'ஆமாம்', 'சரி', 'అవును', 'సరే', 'ಹೌದು', 'ಸರಿ', 'അതെ', 'ശരി',
    'ਹਾਂ', 'ਠੀਕ', 'ਠੀਕ ਹੈ', 'હଁ', 'ହଁ', 'ଠିକ୍', 'হ্যাঁ', 'ঠিক', 'ঠিক আছে', '嗯', '好',
].map((phrase) => normalizeSpeech(phrase).split(/\s+/u))
    .sort((first, second) => second.length - first.length);

const EXPLICIT_YES_NO_ANSWERS = new Set([
    'yes', 'yeah', 'yep', 'yup', 'sure', 'certainly', 'definitely',
    'yes please', 'yeah please', 'sure please',
    'haan', 'han', 'hanji', 'haan ji', 'ji haan', 'haan haan', 'bilkul',
    'हां', 'हाँ', 'जी हां', 'जी हाँ', 'बिल्कुल',
    'no', 'nope', 'nah', 'nahi', 'nahin', 'nahi ji', 'nahin ji', 'no thanks',
    'bilkul nahi', 'नहीं', 'नहीं जी', 'बिल्कुल नहीं',
].map(normalizeSpeech));

export function normalizeSpeech(text) {
    return text.normalize('NFKC')
        .toLocaleLowerCase()
        .replace(/[^\p{L}\p{N}\s]/gu, ' ')
        .replace(/\s+/gu, ' ')
        .trim();
}

const LATIN_FILLER = /^(?:a+h*|u+h+|u+m+h*|h+m+|m{2,}|m+h+m*|e+r+m*|e+h+|o+h+|a+a+|aa+h*|hh+|ha+h+)$/u;
const DEVANAGARI_FILLER = /^(?:अ+ं*|आ+|उ+म्*म*|हम्*म*|हं+|ऊ+|एं+|ऐं+)$/u;
const DEVANAGARI_PUNCTUATION = /[.,!?।"']/gu;

export function cleanCandidateTranscript(text, noiseTerms = []) {
    const source = typeof text === 'string' ? text : '';
    const normalized = normalizeSpeech(source);
    if (!normalized) return '';

    const normalizedNoiseTerms = noiseTerms
        .map((term) => normalizeSpeech(String(term ?? '')))
        .filter(Boolean);
    if (normalizedNoiseTerms.includes(normalized)) return '';

    const words = source.split(/\s+/u).filter(Boolean);
    const remaining = words.filter((rawWord) => {
        const devanagariWord = rawWord.replace(DEVANAGARI_PUNCTUATION, '');
        if (DEVANAGARI_FILLER.test(devanagariWord)) return false;
        return !LATIN_FILLER.test(normalizeSpeech(rawWord));
    });
    const cleaned = remaining.join(' ');
    if (!cleaned || normalizedNoiseTerms.includes(normalizeSpeech(cleaned))) return '';
    return cleaned;
}

export function isExplicitYesNoAnswer(text) {
    return EXPLICIT_YES_NO_ANSWERS.has(normalizeSpeech(text));
}

export function asksYesNoQuestion(text) {
    const questionText = text.split(/[?؟]/u, 1)[0].split(/[.!。]\s*/u).at(-1).trim();
    if (/^(?:what|when|where|why|how|which|who)\b/iu.test(questionText)) return false;
    return /\b(?:do|did|have|has|is|are|was|were|can|could|would|will|should)\s+(?:you|your|it|that|this|they|he|she)\b/iu.test(questionText)
        || /^(?:(?:toh|aur|so|and)\s+)*(?:kya\s+(?:aap|aapne|aapko|ye|yah|is)|क्या\s*(?:आप|आपने|आपको|यह|ये|इस)|है\s*क्या)/iu.test(questionText);
}

export function isBackchannelOnly(text) {
    const words = normalizeSpeech(text).split(/\s+/u).filter(Boolean);
    if (words.length === 0) return false;

    for (let index = 0; index < words.length;) {
        const match = BACKCHANNEL_PHRASES.find((phrase) => phrase.every((word, offset) => words[index + offset] === word));
        if (!match) return false;
        index += match.length;
    }
    return true;
}

export function matchesAiSpeech(transcript, aiText) {
    const normalizedTranscript = normalizeSpeech(transcript);
    const normalizedAiText = normalizeSpeech(aiText);
    if (!normalizedTranscript || !normalizedAiText) return false;
    if (normalizedAiText.includes(normalizedTranscript)) return true;

    const words = normalizedTranscript.split(' ');
    if (words.length < 3) return false;
    const aiWords = new Set(normalizedAiText.split(' '));
    const overlap = words.filter((word) => aiWords.has(word)).length;
    return overlap / words.length >= 0.8;
}

export function asksQuestion(text) {
    return /[?؟]/u.test(text)
        || /\b(what|where|when|why|how|which|who|do you|did you|can you|could you|would you|are you|is your|have you|tell me|kya|kaise|kab|kyun|kahan)\b/iu.test(text);
}
