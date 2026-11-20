import assert from 'node:assert/strict';
import test from 'node:test';
import {
    asksQuestion,
    asksYesNoQuestion,
    cleanCandidateTranscript,
    isBackchannelOnly,
    isExplicitYesNoAnswer,
    matchesAiSpeech,
} from '../src/utils/conversation-turn.js';

test('removes filler and configured noise while preserving meaningful candidate speech', () => {
    for (const transcript of ['uhh', 'a', 'Um, hmm', 'aa', 'उम्म', 'Impact Infotech']) {
        assert.equal(cleanCandidateTranscript(transcript, ['Impact Infotech']), '');
    }
    assert.equal(cleanCandidateTranscript('uhh I have five years of experience'), 'I have five years of experience');
    assert.equal(cleanCandidateTranscript('I worked at Impact Infotech for two years', ['Impact Infotech']), 'I worked at Impact Infotech for two years');
    assert.equal(cleanCandidateTranscript('haan ji'), 'haan ji');
    assert.equal(cleanCandidateTranscript('okay'), 'okay');
});

test('recognizes English and supported-language backchannels', () => {
    for (const transcript of [
        'okay', 'yes, great', 'it is so', 'that’s right', 'sounds good',
        'haan ji', 'theek hai', 'हाँ', 'ঠিক আছে', 'சரி',
    ]) {
        assert.equal(isBackchannelOnly(transcript), true, transcript);
    }

    assert.equal(isBackchannelOnly('yes, I have five years of experience'), false);
});

test('matches echoed recruiter speech and detects spoken questions', () => {
    const speech = 'Can you tell me about your recent work experience?';
    assert.equal(matchesAiSpeech('tell me about your recent work experience', speech), true);
    assert.equal(matchesAiSpeech('I have five years experience', speech), false);
    assert.equal(asksQuestion(speech), true);
    assert.equal(asksQuestion('I will explain the next steps.'), false);
});

test('distinguishes explicit yes/no answers from acknowledgements', () => {
    for (const transcript of ['yes', 'yeah', 'haan ji', 'हाँ', 'no', 'nahi', 'नहीं']) {
        assert.equal(isExplicitYesNoAnswer(transcript), true, transcript);
    }

    for (const transcript of ['okay', 'right', 'it is so', 'haan, I used Kubernetes']) {
        assert.equal(isExplicitYesNoAnswer(transcript), false, transcript);
    }
});

test('identifies yes/no questions in English and Hindi', () => {
    assert.equal(asksYesNoQuestion('Are you available to start next month?'), true);
    assert.equal(asksYesNoQuestion('Have you used Kubernetes in production?'), true);
    assert.equal(asksYesNoQuestion('क्या आपने Kubernetes पर काम किया है?'), true);
    assert.equal(asksYesNoQuestion('What was your role in the migration?'), false);
});
