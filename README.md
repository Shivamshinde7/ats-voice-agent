# ATS Voice Agent

Separate Node.js service for the Laravel AI recruitment calling module.

## Architecture and status

- `VOICE_PROVIDER=browser` selects the local browser microphone/WebSocket provider. It does not need Exotel settings.
- `ConversationService`, `CallSessionService`, and the `SarvamSTTService`, `SarvamLLMService`, and `SarvamTTSService` adapters are shared across provider handlers.
- The browser provider streams mono 16-bit PCM from the microphone to Sarvam Saaras realtime STT, sends final transcripts through the recruitment conversation to Sarvam Chat Completions, and returns Bulbul TTS WAV audio to the browser.
- Browser microphone capture requests the browser's built-in noise suppression and echo cancellation. A shared, low-cost PCM processor applies high-pass filtering before STT for browser and Exotel streams; optional local energy gating is off by default, while Sarvam's realtime VAD handles speech boundaries and turn finalization.
- Browser test calls create one Laravel `ai_calls` record and update that same call through signed internal requests. The Laravel endpoint checks the active table schema before writing and reports any missing or incompatible columns. No migration or database alteration is performed.
- Each call uses the requisition assigned to the candidate in `candidates.requisition_id`. Candidate and requisition context is loaded by Laravel, association-checked, and sent to the Node recruiter; the browser test requires only candidate and initiating-user IDs.
- The dedicated recruitment agent confirms identity and permission, then tracks four screening stages in Node: opportunity, candidate background, exactly three basic requisition-skill questions, and compensation/interview availability. It skips profile facts already present, records short or uncertain answers once, and closes without extra questions. The 6-minute maximum is a safety cap, not a minimum; calls end as soon as the screening is complete. After the closing audio finishes, the provider is terminated and the screening summary, answers, progress, and transcript are saved through the existing `ai_calls` evaluation fields.
- `ExotelProvider` and the existing documented AgentStream handler are retained, but `ENABLE_EXOTEL_AGENTSTREAM` defaults to `false`. Exotel mode is explicitly pending account-specific setup and verification.
- The final outcome is recruiter guidance (`proceed`, `recruiter_review`, `not_interested`, or `incomplete`), not a hiring decision. It does not update the candidate's ATS pipeline status.

## Exotel remains pending

- Do not set `VOICE_PROVIDER=exotel` yet. The provider will fail closed unless `ENABLE_EXOTEL_AGENTSTREAM=true`.
- Before enabling it, verify account region, approved caller ID, flow/callback configuration, public WSS/TLS reachability, status callbacks, and hangup behavior against the Exotel account and official AgentStream protocol.
- Call context is held in memory while Node is running. Restarting the process during a queued/active call can prevent the stream from resolving to its context.
- The screening questions are configured in Laravel's `config/ai_calling.php`; no recording link is fabricated.

## Setup

1. Use Node.js 20 or newer.
2. Copy `.env.example` to `.env` or configure the same values in the Laravel root `.env`. Keep credentials private. For browser mode the key settings are:

   ```dotenv
   VOICE_PROVIDER=browser
   LOCAL_TEST_PORT=3200
   AI_CALLING_LOCAL_TEST_API_URL=http://127.0.0.1:8000/api/ai-calling/local-test/calls
   AI_VOICE_AGENT_SHARED_SECRET=the-same-AI_VOICE_AGENT_SHARED_SECRET
   SARVAM_API_KEY=your-existing-sarvam-key
   SARVAM_STT_MODEL=saaras:v4
   SARVAM_TTS_MODEL=bulbul:v4-flash
   SARVAM_TTS_SPEAKER=ishita_enhi_customer
   SARVAM_SAMPLE_RATE=16000
   BARGE_IN_ENABLED=false
   ACK_ENABLED=false
   SARVAM_STT_SILENCE_DURATION_MS=700
   BARGE_IN_SENSITIVITY=0.3
   BARGE_IN_MIN_SPEECH_MS=250
   BARGE_IN_SILENCE_TIMEOUT_MS=700
   POST_TTS_DELAY_MS=0
   END_OF_SPEECH_MS=400
   AUDIO_PROCESSING_ENABLED=true
   AUDIO_NOISE_SUPPRESSION_ENABLED=true
   AUDIO_VAD_ENABLED=false
   AUDIO_ECHO_CANCELLATION_ENABLED=true
   AUDIO_VAD_THRESHOLD_DB=-42
   SARVAM_LLM_MODEL=sarvam-105b-conversations
   ```

3. Configure `AI_CALLING_COMPANY_NAME` in the Laravel environment. Set `AI_CALLING_LOCAL_TEST_API_URL` to the reachable Laravel endpoint; for a different local port or host, update it accordingly. The shared signing secret must match the Laravel `AI_VOICE_AGENT_SHARED_SECRET`.
   LLM requests use a fresh per-attempt timeout (`LLM_TIMEOUT_MS`, default 25000) and one retry (`LLM_RETRIES`). Silence check-ins are spaced by `SILENCE_PROMPT_SECONDS` (default 8) and end only after three unanswered prompts. `MAX_CALL_DURATION_SECONDS` defaults to 360 (6 minutes). WebSocket pings, idle timeout, STT keepalive, and HTTP keepalive are configurable with `WEBSOCKET_PING_INTERVAL_MS`, `WEBSOCKET_IDLE_TIMEOUT_MS`, `STT_KEEP_ALIVE_INTERVAL_MS`, and `HTTP_KEEP_ALIVE_TIMEOUT_MS`.
4. Install and start from this folder:

   ```sh
   npm install
   npm test
   npm run test:local
   ```

Open `http://127.0.0.1:3200` directly, or use **AI calls → Browser voice test** in the authenticated ATS. The local browser page accepts existing candidate and initiating-user IDs; Laravel resolves the candidate's assigned requisition and rejects unassigned or inconsistent records. Browser microphone permission is requested only after pressing its microphone control. You can place a mobile phone near the laptop microphone and talk through the phone speaker, or upload a mono/stereo 16-bit PCM WAV file up to 5 MB.

## Laravel ATS call flow

Configure these values in Laravel's `.env` for browser testing:

```dotenv
AI_CALLING_COMPANY_NAME=Impact Infotech
AI_VOICE_AGENT_SHARED_SECRET=the-same-secret-as-the-Node-service
AI_CALLING_LOCAL_TEST_API_URL=http://127.0.0.1:8000/api/ai-calling/local-test/calls
SARVAM_API_KEY=your-existing-sarvam-key
SARVAM_LLM_MODEL=sarvam-105b-conversations
SARVAM_TTS_SPEAKER=ishita_enhi_customer
```

The female English/Hindi code-mixed voice is the documented Bulbul v4 persona `ishita_enhi_customer`. Update an existing `.env` value of `SARVAM_TTS_SPEAKER` if it still names the previous male voice; restart the Node service after changing it.

`ishita_enhi_customer` remains the configured voice. Sarvam also lists `shalini_enhi_customer` and `simran_enhi_customer` as v4 code-mixed customer personas; compare them using the same consented sample and call conditions before changing the default. The project does not perform acoustic voice selection automatically.

The STT silence timeout defaults to 700 ms so normal pauses are less likely to split one answer into separate turns; the minimum utterance remains 250 ms. The post-final transcript buffer defaults to 400 ms (`END_OF_SPEECH_MS`) to capture the complete answer. Saaras uses `fast` partials for responsive barge-in, auto language detection, and code-mix final transcripts; requisition skills are sent as v4 keyterms when available. Exotel TTS uses Sarvam's HTTP streaming endpoint with raw 8 kHz `linear16`; `SARVAM_TTS_PACE` defaults to 1.0. Separate acknowledgement audio is disabled and `POST_TTS_DELAY_MS` defaults to 0; the next relevant sentence is generated directly. The JSON LLM output remains buffered and validated before it is spoken. Exotel logs LLM, first-audio, playback, and total response timings.

The browser microphone control toggles capture on/off and reports when its track or AudioContext is suspended. Keep the test tab visible while speaking; returning to the tab resumes a suspended context where the browser permits it. Microphone audio continues to reach speech recognition while the recruiter is speaking. A non-echo STT partial interrupts browser playback or Exotel media immediately; likely recruiter-voice echo is checked before interruption so the AI does not cut itself off. If an LLM turn is still in flight, confirmed candidate speech cancels and retries it with the interrupted speech merged into the final transcript. Conversation state is restored so the turn is not applied twice. Final transcripts are buffered, backchannels and likely recruiter-voice echo are filtered, and a candidate turn is sent to the LLM after STT finalization and the configurable end-of-speech interval (`END_OF_SPEECH_MS`, default 400 ms). Separate acknowledgement audio is disabled; the agent directly generates the next relevant response. `POST_TTS_DELAY_MS` defaults to 0 ms. The STT keepalive uses a WebSocket ping frame rather than an application-level JSON message.

Screening and interview turns use the current topic and recent conversation to distinguish a short answer from a listener acknowledgement. A clear yes or no can answer a yes/no question; “okay,” “right,” or another acknowledgement cannot complete an open-ended or specific-detail topic, even if the LLM misclassifies it. In that case the AI responds naturally and leaves room for the candidate to continue instead of advancing or repeating a rigid script. In interviews, incomplete, unrelated, or conflicting answers receive a focused follow-up. Partial STT updates are shown while the candidate speaks but do not invoke the LLM.

Audio cleanup is controlled by `AUDIO_PROCESSING_ENABLED`, `AUDIO_NOISE_SUPPRESSION_ENABLED`, `AUDIO_VAD_ENABLED`, `AUDIO_ECHO_CANCELLATION_ENABLED`, and `AUDIO_VAD_THRESHOLD_DB`. Local energy VAD is off by default because it can gate quiet candidate voices; Sarvam's realtime VAD remains enabled and handles turn boundaries. Enable the local gate only after tuning `AUDIO_VAD_THRESHOLD_DB` for the microphone or telephony level. Browser echo cancellation/noise suppression depends on browser and device support. On Node, the "noise suppression" option is only an 80 Hz high-pass filter, not broadband denoising. Exotel streams use that filter and Sarvam's server-side VAD; actual telephony echo cancellation remains dependent on the Exotel/carrier audio path.

## AI Interview microphone sessions

AI Interviews use the existing browser microphone UI, local-test WebSocket, and Sarvam STT/TTS pipeline. They do not place a phone call or require a candidate phone number. Interview conversation handling and prompts remain separate from screening.

The interviewer starts with a natural role introduction. If a completed AI screening exists for the same candidate and requisition, it creates a brief recap from that transcript; otherwise, it introduces the role and asks about relevant experience. Requisition level maps to Basic (L1), Intermediate (L2), or Advanced (L3). It asks all ten prepared questions unless the candidate asks to stop; it does not announce a question count. Prepared questions stay in Node memory only; the interview database stores the transcript and call/session lifecycle metadata. No per-question answers or assessment are saved.

Use the configured `AI_CALLING_BROWSER_TEST_URL` and local-test API URL, `AI_VOICE_AGENT_SHARED_SECRET`, and Sarvam credentials. Start the existing voice agent with `npm start`; do not start a separate interview server. Choose **AI Interview** on the candidate page, confirm candidate consent, and allow microphone access in the browser. The transcript appears in AI Interview history.

Run `npm test` from this directory for the voice-agent tests, or `node --test test/interview-agent.test.js test/local-test.test.js test/providers.test.js` for focused interview, browser, and telephony tests. To test interruption handling manually, start a browser call, let the recruiter begin speaking, and speak over it; playback should stop, and the final utterance should be handled once without restarting the screening/interview. Browser interview sessions require the existing `ai_calls.ai_interview_session_id` link and the AI interview session table.

Sarvam realtime STT uses `BARGE_IN_SENSITIVITY` as its VAD threshold (0-1), `BARGE_IN_MIN_SPEECH_MS` (100-2000 ms), and `BARGE_IN_SILENCE_TIMEOUT_MS` (200-3000 ms). VAD speech-start alone does not interrupt playback: non-echo partial speech or a finalized candidate transcript confirms barge-in. Only finalized transcripts are sent to the LLM.

Run the app and queue worker from the Laravel project root, and the Node browser service from this directory:

```sh
php artisan serve --host=127.0.0.1 --port=8000
php artisan queue:work
npm test
npm run test:local
```

In the ATS, select an assigned candidate and open **Voice screening**. Candidate and initiating-user context are supplied from the signed-in ATS page; start the microphone to begin the session. The standalone local page at `http://127.0.0.1:3200/` can also be used with candidate and initiating-user IDs. The call detail page shows the transcript, stage completion, captured answers, and recruiter recommendation. The browser test exercises Laravel-to-Node context retrieval and persistence but does not place a telephone call. Exotel remains disabled pending account-specific setup; do not enable it until public WSS/TLS and Exotel callbacks have been verified.

To manually test the Sarvam opening with an approved context, set `AI_CALLING_TEST_CONTEXT_JSON` at runtime to a JSON object containing `candidate`, `requisition`, `company_name`, and `screening_questions`, then run `node src/test-llm.js`. Do not commit candidate or requisition records to environment files or source control.

## Local browser WebSocket test

The browser server binds only to `127.0.0.1` and should not be exposed publicly. It does not invoke Exotel, and no provider API key or signing secret is sent to browser JavaScript. Use only approved test records. On start, Laravel inspects the active `ai_calls` schema; if required columns are missing or incompatible, the call is not created and the endpoint reports the schema differences. The feature does not alter ATS candidate statuses.

To prepare Exotel later, configure its credentials and settings in environment variables, verify the account-specific AgentStream setup, and only then set `ENABLE_EXOTEL_AGENTSTREAM=true` and `VOICE_PROVIDER=exotel`. No Exotel API request is made by browser mode.

## Provider documentation used

- [Exotel Connect Voice AI](https://developer.exotel.com/docs/agentstream/connect-voice-ai.md)
- [Exotel AgentStream WebSocket protocol](https://developer.exotel.com/docs/agentstream/websocket-protocol.md)
- [Sarvam real-time Saaras STT](https://docs.sarvam.ai/api/api-guides-tutorials/speech-to-text/realtime-streaming.md)
- [Sarvam Saaras v4 keyterms](https://docs.sarvam.ai/api/api-guides-tutorials/speech-to-text/how-to/keyterms.md)
- [Sarvam Bulbul v4 Flash HTTP streaming TTS](https://docs.sarvam.ai/api-reference/text-to-speech/convert-stream.md)
- [Sarvam Bulbul v4 Flash voice and pace guidance](https://docs.sarvam.ai/api/api-guides-tutorials/text-to-speech/best-practices.md)

## Audio contract

Exotel AgentStream is configured for raw mono signed 16-bit PCM at 8 kHz by default; the start-event format is checked, including mono when a channel count is supplied. STT receives each Exotel `media.payload` as Base64 `audio_input`. Exotel TTS requests raw 8 kHz `linear16` from Sarvam's `/text-to-speech/stream` endpoint and forwards it incrementally in Exotel's documented 3,200-byte-minimum, 320-byte-aligned packets. Barge-in sends Exotel's `clear` event and aborts the active Sarvam stream. The browser/local-test path retains WAV request-response playback. No live Exotel call or acoustic voice comparison is implied by the offline tests.
