const startForm = document.querySelector('#start-form');
const startButton = document.querySelector('#start-button');
const micButton = document.querySelector('#mic-button');
const wavFile = document.querySelector('#wav-file');
const sendWavButton = document.querySelector('#send-wav');
const endButton = document.querySelector('#end-button');
const statusLabel = document.querySelector('#status');
const callIdLabel = document.querySelector('#call-id');
const errorLabel = document.querySelector('#error');
const messages = document.querySelector('#messages');
const partial = document.querySelector('#partial');
const statusIndicator = document.querySelector('#status-indicator');
const assessmentResult = document.querySelector('#assessment-result');
const assessmentBadge = document.querySelector('#assessment-badge');
const assessmentCopy = document.querySelector('#assessment-copy');

let socket = null;
let callStarted = false;
let targetSampleRate = 8000;
let audioProcessing = { noise_suppression: true, echo_cancellation: true };
let mediaStream = null;
let audioContext = null;
let microphoneSource = null;
let processor = null;
let microphoneTrack = null;
let audioFramesSent = 0;
let lastVoiceDetectedAt = 0;
let microphoneWatchdog = null;
let serverPlaybackPending = false;
let currentAudio = null;
let currentAudioUrl = null;
let currentAudioResponseId = null;
let pendingAudioResponseId = null;
let playbackResponseId = null;

const query = new URLSearchParams(location.search);
const browserMode = query.get('browser_mode') === 'interview' ? 'interview' : 'screening';
const candidateId = Number(query.get('candidate_id'));
const initiatedBy = Number(query.get('initiated_by'));
const interviewSessionId = Number(query.get('interview_session_id'));
const contextExpires = query.get('context_expires');
const contextSignature = query.get('context_signature');
const hasPinnedCandidate = Number.isSafeInteger(candidateId) && candidateId > 0
    && Number.isSafeInteger(initiatedBy) && initiatedBy > 0;
if (hasPinnedCandidate) {
    const candidateInput = startForm.elements.namedItem('candidate_id');
    const initiatedByInput = startForm.elements.namedItem('initiated_by');
    candidateInput.value = String(candidateId);
    initiatedByInput.value = String(initiatedBy);
    candidateInput.readOnly = true;
    initiatedByInput.readOnly = true;
    document.querySelector('#start-help').textContent = browserMode === 'interview'
        ? 'Candidate and interview details are securely linked from the ATS. No phone call is placed.'
        : 'These IDs were filled from the ATS page. The candidate requisition is loaded automatically.';
}
if (browserMode === 'interview') {
    document.title = 'AI interview | Impact Infotech';
    document.querySelector('.eyebrow').textContent = 'AI Interview';
    document.querySelector('h1').textContent = 'A better conversation starts here.';
    document.querySelector('.intro-copy').textContent = 'Start the session, allow microphone access, and speak naturally. The interview transcript will be saved to the ATS.';
    document.querySelector('#setup-title').textContent = 'Start interview';
    document.querySelector('.panel-description').textContent = 'The candidate profile and assigned role guide the conversation.';
    document.querySelector('#start-button span').textContent = 'Start interview session';
    document.querySelector('#conversation-title').textContent = 'Interview conversation';
    document.querySelector('#stage-tracker').hidden = true;
    assessmentResult.hidden = true;
    document.querySelector('.assessment-result').hidden = true;
    document.querySelector('.status-pill').textContent = 'Transcript saved to ATS';
}

new MutationObserver(() => {
    const text = statusLabel.textContent.toLowerCase();
    statusIndicator.dataset.state = /connected|active|listening|speaking|ready/.test(text)
        ? 'active'
        : (/error|unavailable|disconnected|could not/.test(text) ? 'warning' : 'idle');
}).observe(statusLabel, { childList: true, characterData: true, subtree: true });

startForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    clearError();
    startButton.disabled = true;
    statusLabel.textContent = browserMode === 'interview'
        ? 'Connecting to the microphone interview service...'
        : 'Connecting to the microphone screening service...';

    try {
        const values = Object.fromEntries(new FormData(startForm));
        const response = await fetch('/api/test-calls', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                candidate_id: Number(values.candidate_id),
                initiated_by: Number(values.initiated_by),
                browser_mode: browserMode,
                ...(browserMode === 'interview' ? { interview_session_id: interviewSessionId } : {}),
                ...(contextExpires && contextSignature
                    ? {
                        browser_context_expires: contextExpires,
                        browser_context_signature: contextSignature,
                    }
                    : {}),
            }),
        });
        const result = await response.json();
        if (!response.ok) {
            throw new Error(result.error || `Local server returned HTTP ${response.status}.`);
        }

        targetSampleRate = result.sample_rate;
        callIdLabel.textContent = `${browserMode === 'interview' ? 'Interview' : 'Screening'} session ${result.call_id} (record ${result.ai_call_id})`;
        connectCall(result.call_id);
    } catch (error) {
        showError(error.message);
        statusLabel.textContent = 'Could not start call';
        startButton.disabled = false;
    }
});

function connectCall(callId) {
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    socket = new WebSocket(`${protocol}//${location.host}/ws/${callId}`);
    socket.binaryType = 'arraybuffer';
    statusLabel.textContent = 'Connecting to Sarvam realtime STT...';

    socket.addEventListener('open', () => {
        socket.send(JSON.stringify({ type: 'start' }));
    });
    socket.addEventListener('message', (event) => {
        if (typeof event.data !== 'string') {
            playWav(event.data, pendingAudioResponseId);
            return;
        }
        handleServerEvent(JSON.parse(event.data));
    });
    socket.addEventListener('error', () => {
        showError('WebSocket connection failed. Check the local server and Laravel API.');
    });
    socket.addEventListener('close', () => {
        stopMicrophone();
        setCallControls(false);
        startButton.disabled = false;
        if (callStarted) {
            statusLabel.textContent = 'Call disconnected';
            callStarted = false;
        }
    });
}

function handleServerEvent(message) {
    switch (message.type) {
        case 'ready':
            callStarted = true;
            audioProcessing = message.audio_processing || audioProcessing;
            statusLabel.textContent = 'Connected. Start the microphone when you are ready.';
            setCallControls(true);
            if (browserMode !== 'interview') updateScreeningProgress(message.screening_progress);
            break;
        case 'screening_progress':
            if (browserMode !== 'interview') updateScreeningProgress(message.progress);
            break;
        case 'transcript_partial':
            partial.textContent = message.text ? `Listening: ${message.text}` : '';
            break;
        case 'transcript_final':
            partial.textContent = '';
            addMessage('Candidate', message.text, 'candidate');
            break;
        case 'transcript_unheard':
            statusLabel.textContent = 'Could not hear that clearly. Asking for a repeat.';
            break;
        case 'ai_response':
            addMessage('Isha', message.text, 'ai');
            break;
        case 'audio_start':
            pendingAudioResponseId = message.response_id;
            playbackResponseId = message.response_id;
            break;
        case 'speech_start':
            statusLabel.textContent = mediaStream
                ? `Microphone active (${targetSampleRate} Hz) - listening`
                : 'Candidate speaking...';
            break;
        case 'barge_in':
            if (currentAudioResponseId === message.response_id
                || pendingAudioResponseId === message.response_id
                || playbackResponseId === message.response_id) {
                stopCurrentAudio(false);
                serverPlaybackPending = false;
                pendingAudioResponseId = null;
                playbackResponseId = null;
            }
            statusLabel.textContent = mediaStream
                ? `Microphone active (${targetSampleRate} Hz) - listening`
                : 'Candidate speaking...';
            break;
        case 'speech_end':
            statusLabel.textContent = 'Processing candidate response...';
            break;
        case 'audio_end':
            statusLabel.textContent = currentAudio
                ? 'Recruiter speaking...'
                : (mediaStream
                    ? `Microphone active (${targetSampleRate} Hz) - listening`
                    : 'Response ready - start the microphone when you are ready');
            break;
        case 'audio_source_complete':
            statusLabel.textContent = 'WAV sent - waiting for transcript';
            break;
        case 'ending':
            statusLabel.textContent = browserMode === 'interview'
                ? 'Finishing interview and saving transcript...'
                : 'Finishing session and saving notes...';
            setCallControls(false);
            stopMicrophone();
            break;
        case 'conversation_complete':
            statusLabel.textContent = browserMode === 'interview'
                ? 'Interview complete. Saving transcript.'
                : 'Screening complete. Saving session details.';
            setCallControls(false);
            stopMicrophone();
            break;
        case 'error':
            showError(message.message || 'An error occurred during the test call.');
            statusLabel.textContent = 'Call error';
            break;
        case 'call_finished':
            statusLabel.textContent = `Session ${message.status} (${message.duration_seconds}s)`;
            callStarted = false;
            setCallControls(false);
            stopMicrophone();
            stopCurrentAudio();
            if (browserMode !== 'interview') showAssessment(message.evaluation);
            if (browserMode !== 'interview' && message.evaluation?.summary) {
                addMessage('Screening summary', message.evaluation.summary, 'ai');
            }
            break;
        default:
            break;
    }
}

micButton.addEventListener('click', async () => {
    clearError();
    if (mediaStream) {
        stopMicrophone();
        statusLabel.textContent = 'Microphone paused';
        return;
    }

    try {
        await startMicrophone();
    } catch (error) {
        stopMicrophone();
        showError(`Microphone could not start: ${error.message}`);
        statusLabel.textContent = 'Microphone unavailable';
    }
});

async function startMicrophone() {
    if (!callStarted || !socket || socket.readyState !== WebSocket.OPEN) {
        throw new Error('Start a test call first.');
    }

    const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
            channelCount: 1,
            echoCancellation: audioProcessing.echo_cancellation,
            noiseSuppression: audioProcessing.noise_suppression,
            autoGainControl: { ideal: true },
        },
    });
    mediaStream = stream;
    microphoneTrack = stream.getAudioTracks()[0] || null;
    if (!microphoneTrack) {
        throw new Error('No audio track was provided by the selected microphone.');
    }
    microphoneTrack.addEventListener('ended', handleMicrophoneEnded, { once: true });
    microphoneTrack.addEventListener('mute', handleMicrophoneMuted);
    microphoneTrack.addEventListener('unmute', handleMicrophoneUnmuted);

    audioContext = new AudioContext({ latencyHint: 'interactive' });
    await audioContext.resume();
    if (audioContext.state !== 'running') {
        throw new Error('The browser audio context is suspended. Check browser audio permissions and try again.');
    }
    microphoneSource = audioContext.createMediaStreamSource(stream);
    processor = audioContext.createScriptProcessor(2048, 1, 1);
    processor.onaudioprocess = (event) => {
        event.outputBuffer.getChannelData(0).fill(0);
        if (!callStarted || socket?.readyState !== WebSocket.OPEN) return;
        if (microphoneTrack?.readyState !== 'live' || microphoneTrack.muted) return;
        const input = event.inputBuffer.getChannelData(0);
        let energy = 0;
        for (const sample of input) energy += sample * sample;
        if (Math.sqrt(energy / input.length) >= 0.01) {
            lastVoiceDetectedAt = Date.now();
            if (statusLabel.textContent.startsWith('Microphone connected - no voice detected')) {
                statusLabel.textContent = `Microphone active (${targetSampleRate} Hz) - audio detected`;
            }
        }
        const samples = downsample(input, audioContext.sampleRate, targetSampleRate);
        if (samples.length) {
            socket.send(samples.buffer);
            audioFramesSent += 1;
            if (audioFramesSent === 1) {
                statusLabel.textContent = `Microphone active (${targetSampleRate} Hz) - listening`;
            }
        }
    };
    microphoneSource.connect(processor);
    processor.connect(audioContext.destination);
    micButton.querySelector('span').textContent = 'Stop microphone';
    micButton.disabled = false;
    micButton.setAttribute('aria-pressed', 'true');
    statusLabel.textContent = `Microphone active (${targetSampleRate} Hz) - speak when ready`;
    audioFramesSent = 0;
    lastVoiceDetectedAt = Date.now();
    microphoneWatchdog = setInterval(updateMicrophoneStatus, 3000);
    audioContext.addEventListener('statechange', handleAudioContextStateChange);
}

function downsample(input, inputRate, outputRate) {
    if (inputRate === outputRate) return toPcm16(input);
    const ratio = inputRate / outputRate;
    const outputLength = Math.floor(input.length / ratio);
    const output = new Int16Array(outputLength);

    for (let outputIndex = 0; outputIndex < outputLength; outputIndex += 1) {
        const start = Math.floor(outputIndex * ratio);
        const end = Math.min(Math.floor((outputIndex + 1) * ratio), input.length);
        let total = 0;
        for (let inputIndex = start; inputIndex < end; inputIndex += 1) total += input[inputIndex];
        const sample = total / Math.max(1, end - start);
        output[outputIndex] = Math.max(-32768, Math.min(32767, Math.round(sample * (sample < 0 ? 32768 : 32767))));
    }

    return output;
}

function toPcm16(input) {
    const output = new Int16Array(input.length);
    for (let index = 0; index < input.length; index += 1) {
        const sample = input[index];
        output[index] = Math.round(sample * (sample < 0 ? 32768 : 32767));
    }
    return output;
}

function stopMicrophone() {
    clearInterval(microphoneWatchdog);
    microphoneWatchdog = null;
    if (processor) {
        processor.disconnect();
        processor.onaudioprocess = null;
        processor = null;
    }
    microphoneSource?.disconnect();
    microphoneSource = null;
    if (mediaStream) {
        microphoneTrack?.removeEventListener('mute', handleMicrophoneMuted);
        microphoneTrack?.removeEventListener('unmute', handleMicrophoneUnmuted);
        microphoneTrack?.removeEventListener('ended', handleMicrophoneEnded);
        mediaStream.getTracks().forEach((track) => track.stop());
        mediaStream = null;
    }
    microphoneTrack = null;
    if (audioContext) {
        audioContext.removeEventListener('statechange', handleAudioContextStateChange);
        audioContext.close().catch((error) => showError(`Audio context could not close: ${error.message}`));
        audioContext = null;
    }
    if (micButton) {
        micButton.querySelector('span').textContent = 'Start microphone';
        micButton.setAttribute('aria-pressed', 'false');
        micButton.disabled = !callStarted;
    }
}

function handleMicrophoneEnded() {
    stopMicrophone();
    if (callStarted) {
        statusLabel.textContent = 'Microphone disconnected - click Start microphone to reconnect';
        showError('The microphone input ended. Check that the device is connected and its permission is still enabled.');
    }
}

function handleMicrophoneMuted() {
    if (callStarted) statusLabel.textContent = 'Microphone is muted by the device or browser';
}

function handleMicrophoneUnmuted() {
    if (callStarted && audioContext?.state === 'running') {
        statusLabel.textContent = `Microphone active (${targetSampleRate} Hz) - listening`;
    }
}

function handleAudioContextStateChange() {
    if (!audioContext || !callStarted) return;
    if (audioContext.state === 'suspended') {
        statusLabel.textContent = 'Microphone paused by the browser - click the page to resume listening';
    } else if (audioContext.state === 'running' && mediaStream) {
        statusLabel.textContent = `Microphone active (${targetSampleRate} Hz) - listening`;
    }
}

function updateMicrophoneStatus() {
    if (!mediaStream || !callStarted || !audioContext || audioContext.state !== 'running') return;
    if (microphoneTrack?.readyState !== 'live') return;
    if (Date.now() - lastVoiceDetectedAt > 10000) {
        statusLabel.textContent = 'Microphone connected - no voice detected; check the selected input and speak near it';
    }
}

document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && audioContext?.state === 'suspended' && mediaStream) {
        audioContext.resume().catch((error) => {
            showError(`Microphone audio could not resume: ${error.message}`);
        });
    }
});

document.addEventListener('pointerdown', () => {
    if (audioContext?.state === 'suspended' && mediaStream) {
        audioContext.resume().catch((error) => {
            showError(`Microphone audio could not resume: ${error.message}`);
        });
    }
});

wavFile.addEventListener('change', () => {
    sendWavButton.disabled = !callStarted || !wavFile.files?.length;
});

sendWavButton.addEventListener('click', async () => {
    const file = wavFile.files?.[0];
    if (!file || !socket || socket.readyState !== WebSocket.OPEN) return;
    if (!file.name.toLowerCase().endsWith('.wav')) {
        showError('Select a WAV file.');
        return;
    }
    if (file.size > 5 * 1024 * 1024) {
        showError('WAV file must be no larger than 5 MB.');
        return;
    }

    clearError();
    sendWavButton.disabled = true;
    statusLabel.textContent = 'Sending WAV audio to realtime STT...';
    socket.send(await file.arrayBuffer());
});

endButton.addEventListener('click', () => {
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    stopMicrophone();
    stopCurrentAudio();
    socket.send(JSON.stringify({ type: 'end' }));
    setCallControls(false);
    endButton.disabled = true;
    statusLabel.textContent = 'Ending call and saving transcript...';
});

function playWav(buffer, responseId) {
    if (responseId === null || responseId === undefined || responseId !== playbackResponseId) {
        return;
    }
    if (currentAudio) {
        showError('Received recruiter audio before the previous response finished playing.');
        return;
    }
    currentAudioUrl = URL.createObjectURL(new Blob([buffer], { type: 'audio/wav' }));
    currentAudio = new Audio(currentAudioUrl);
    currentAudioResponseId = responseId;
    serverPlaybackPending = true;
    statusLabel.textContent = 'Recruiter speaking...';
    currentAudio.addEventListener('ended', () => {
        stopCurrentAudio();
        acknowledgePlaybackFinished(responseId);
        if (playbackResponseId === responseId) {
            playbackResponseId = null;
            pendingAudioResponseId = null;
        }
        if (callStarted) {
            statusLabel.textContent = mediaStream
                ? `Microphone active (${targetSampleRate} Hz) - listening`
                : 'Response finished - start the microphone to continue';
        }
    }, { once: true });
    currentAudio.play().catch((error) => {
        showError(`Could not play recruiter audio: ${error.message}`);
        stopCurrentAudio(false);
        acknowledgePlaybackFinished(responseId);
        if (playbackResponseId === responseId) {
            playbackResponseId = null;
            pendingAudioResponseId = null;
        }
        if (callStarted) statusLabel.textContent = 'Audio playback failed';
    });
}

function acknowledgePlaybackFinished(responseId = currentAudioResponseId) {
    if (!serverPlaybackPending) return;
    serverPlaybackPending = false;
    if (socket?.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: 'playback_finished', response_id: responseId }));
    }
}

function stopCurrentAudio(acknowledge = true) {
    if (currentAudio) {
        currentAudio.pause();
        currentAudio.currentTime = 0;
        currentAudio = null;
        if (acknowledge) {
            acknowledgePlaybackFinished();
        }
    }
    currentAudioResponseId = null;
    if (currentAudioUrl) {
        URL.revokeObjectURL(currentAudioUrl);
        currentAudioUrl = null;
    }
}

function addMessage(speaker, text, className) {
    document.querySelector('#empty-state')?.remove();
    const element = document.createElement('div');
    element.className = `message ${className}`;
    const speakerLabel = document.createElement('span');
    speakerLabel.className = 'message-speaker';
    speakerLabel.textContent = speaker;
    const messageText = document.createElement('span');
    messageText.textContent = text;
    element.append(speakerLabel, messageText);
    messages.append(element);
    messages.scrollTop = messages.scrollHeight;
}

function setCallControls(enabled) {
    micButton.disabled = !enabled;
    micButton.querySelector('span').textContent = mediaStream ? 'Stop microphone' : 'Start microphone';
    micButton.setAttribute('aria-pressed', String(Boolean(mediaStream)));
    wavFile.disabled = !enabled;
    sendWavButton.disabled = !enabled || !wavFile.files?.length;
    endButton.disabled = !enabled;
}

function updateScreeningProgress(progress) {
    if (!progress || !Array.isArray(progress.stages)) return;
    for (const stage of progress.stages) {
        const element = document.querySelector(`[data-stage="${stage.id}"]`);
        if (!element) continue;
        const state = stage.status === 'completed'
            ? 'completed'
            : (stage.id === progress.current_stage ? 'active' : 'pending');
        element.dataset.state = state;
        const count = element.querySelector('.stage-count');
        count.textContent = state === 'completed'
            ? 'Complete'
            : `${stage.completed} of ${stage.total} covered`;
    }
}

function showAssessment(evaluation) {
    const labels = {
        proceed: 'Consider next conversation',
        recruiter_review: 'Recruiter review',
        not_interested: 'Candidate not interested',
        incomplete: 'Screening incomplete',
    };
    const recommendation = evaluation?.recommendation;
    if (!labels[recommendation]) return;

    assessmentBadge.textContent = labels[recommendation];
    assessmentBadge.dataset.state = recommendation;
    assessmentCopy.textContent = evaluation.recommendation_reason
        || 'Review the saved transcript and screening details before deciding next steps.';
    assessmentResult.hidden = false;
}

function showError(message) {
    errorLabel.textContent = message;
}

function clearError() {
    errorLabel.textContent = '';
}
