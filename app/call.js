// app/call.js
// Son of Wisdom — Call mode (Free Talk + VAD + Barge-in + Merge + Premium Rings)
//
// ✅ Endpoints:
//    - /.netlify/functions/openai-transcribe  (audio -> transcript)
//    - /.netlify/functions/call-coach         (transcript -> AI text + TTS audio)
//
// ✅ Real VAD Silence Detection (browser-based):
//    - Starts recording when user speaks
//    - Stops automatically after silence
//    - No fixed min/max turn cutoffs
//
// ✅ Turn Merging:
//    - If user pauses briefly and continues, merges into one transcript
//
// ✅ Barge-in:
//    - If AI is speaking and user starts talking, AI audio stops immediately
//
// ✅ ring.mp3 integrated:
//    - plays once when call connects
//
// ✅ Premium rings:
//    - User ring reacts to mic volume
//    - AI ring reacts to AI audio volume
//
// ✅ iOS Safari hardened:
//    - unlockAudioSystem runs ONLY on Start Call tap
//    - single shared audio player
//
// ✅ Uses transcript DOM from call.html:
//    #transcriptList + #transcriptInterim
//
// ✅ No n8n

const DEBUG = true;
const log = (...a) => DEBUG && console.log("[SOW]", ...a);
const warn = (...a) => DEBUG && console.warn("[SOW]", ...a);

/* ---------- ENDPOINTS ---------- */
const CALL_COACH_ENDPOINT = "/.netlify/functions/call-coach";
const TRANSCRIBE_ENDPOINT = "/.netlify/functions/openai-transcribe";

/* ---------- URL PARAMS ---------- */
const urlParams = new URLSearchParams(window.location.search);
const conversationId = urlParams.get("c") || null;

/* ---------- DOM ---------- */
const callBtn = document.getElementById("call-btn");
const statusText = document.getElementById("status-text");
const micBtn = document.getElementById("mic-btn");
const speakerBtn = document.getElementById("speaker-btn");
const modeBtn = document.getElementById("mode-btn");

/* Transcript DOM */
const transcriptList = document.getElementById("transcriptList");
const transcriptInterim = document.getElementById("transcriptInterim");

/* Transcript Controls */
const clearBtn = document.getElementById("ts-clear");
const autoscrollBtn = document.getElementById("ts-autoscroll");

/* Canvas rings (optional) */
const voiceRing = document.getElementById("voiceRing");

/* ---------- STATE ---------- */
let isCalling = false;
let isRecording = false;
let isPlayingAI = false;

let micMuted = false;
let speakerMuted = false;

let autoScroll = true;
let lastFinalLine = "";

/* merge buffer */
let mergedTranscriptBuffer = "";
let mergeTimer = null;

/* audio recording */
let globalStream = null;
let mediaRecorder = null;
let recordChunks = [];

/* VAD */
let vadAC = null;
let vadSource = null;
let vadAnalyser = null;
let vadData = null;
let vadLoopRunning = false;
let lastVoiceTime = 0;
let currentSpeechStartedAt = 0;
let speechDetected = false;
let vadState = "idle";

/* VAD tuning */
const VAD_THRESHOLD = 0.035;          // energy threshold (adjust if needed)
const VAD_SILENCE_MS = 900;           // silence duration that ends turn
const VAD_MERGE_WINDOW_MS = 1100;     // if user resumes speech within this, merge
const VAD_MIN_SPEECH_MS = 220;        // ignore tiny noises
const VAD_IDLE_TIMEOUT_MS = 25000;    // if no speech for this long, stay idle but alive

/* ---------- iOS detection ---------- */
const IS_IOS =
  /iPad|iPhone|iPod/i.test(navigator.userAgent || "") ||
  (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);

/* ---------- Shared AI audio player ---------- */
let ttsPlayer = null;
let playbackAC = null;
let playbackAnalyser = null;
let playbackData = null;
let audioUnlocked = false;

/* ---------- Call SFX ---------- */
let ringAudio = null;
let ringPlayed = false;

/* ---------- Helpers ---------- */
function setStatus(t) {
  if (!statusText) return;
  statusText.textContent = t || "";
}

function setInterim(t) {
  if (!transcriptInterim) return;
  transcriptInterim.textContent = t || "";
}

function addFinalLine(t) {
  if (!transcriptList) return;
  const s = (t || "").trim();
  if (!s || s === lastFinalLine) return;
  lastFinalLine = s;

  const div = document.createElement("div");
  div.className = "transcript-line";
  div.textContent = s;
  transcriptList.appendChild(div);

  if (autoScroll) transcriptList.scrollTop = transcriptList.scrollHeight;
}

function clearTranscript() {
  if (transcriptList) transcriptList.innerHTML = "";
  setInterim("");
  lastFinalLine = "";
  mergedTranscriptBuffer = "";
}

/* ---------- Buttons ---------- */
clearBtn?.addEventListener("click", clearTranscript);

autoscrollBtn?.addEventListener("click", () => {
  autoScroll = !autoScroll;
  autoscrollBtn.setAttribute("aria-pressed", String(autoScroll));
  autoscrollBtn.textContent = autoScroll ? "On" : "Off";
});

modeBtn?.addEventListener("click", () => {
  const url = new URL("home.html", window.location.origin);
  if (conversationId) url.searchParams.set("c", conversationId);
  window.location.href = url.toString();
});

micBtn?.addEventListener("click", () => {
  micMuted = !micMuted;

  if (globalStream) {
    globalStream.getAudioTracks().forEach((t) => (t.enabled = !micMuted));
  }

  const lbl = document.getElementById("mic-label");
  if (lbl) lbl.textContent = micMuted ? "Unmute" : "Mute";

  setStatus(micMuted ? "Mic muted." : "Mic unmuted.");
});

speakerBtn?.addEventListener("click", () => {
  speakerMuted = !speakerMuted;

  if (ttsPlayer) {
    ttsPlayer.muted = speakerMuted;
    ttsPlayer.volume = speakerMuted ? 0 : 1;
  }

  const lbl = document.getElementById("speaker-label");
  if (lbl) lbl.textContent = speakerMuted ? "Speaker Off" : "Speaker";

  setStatus(speakerMuted ? "Speaker muted." : "Speaker on.");
});

/* ---------- IDs ---------- */
function getDeviceId() {
  const key = "sow_device_id";
  let id = localStorage.getItem(key);
  if (!id) {
    id = crypto?.randomUUID?.() || `dev_${Math.random().toString(16).slice(2)}`;
    localStorage.setItem(key, id);
  }
  return id;
}
const deviceId = getDeviceId();
const callId = crypto?.randomUUID?.() || `call_${Date.now()}`;

/* ---------- Audio system ---------- */
function ensureSharedAudio() {
  if (ttsPlayer) return ttsPlayer;

  ttsPlayer = new Audio();
  ttsPlayer.preload = "auto";
  ttsPlayer.playsInline = true;
  ttsPlayer.crossOrigin = "anonymous";
  ttsPlayer.muted = speakerMuted;
  ttsPlayer.volume = speakerMuted ? 0 : 1;

  return ttsPlayer;
}

async function unlockAudioSystem() {
  try {
    ensureSharedAudio();

    playbackAC ||= new (window.AudioContext || window.webkitAudioContext)();
    if (playbackAC.state === "suspended") {
      await playbackAC.resume().catch(() => {});
    }

    // Setup playback analyser for AI ring
    if (!playbackAnalyser) {
      const src = playbackAC.createMediaElementSource(ttsPlayer);
      playbackAnalyser = playbackAC.createAnalyser();
      playbackAnalyser.fftSize = 1024;
      playbackData = new Uint8Array(playbackAnalyser.fftSize);
      src.connect(playbackAnalyser);
      playbackAnalyser.connect(playbackAC.destination);
    }

    if (IS_IOS && !audioUnlocked) {
      const a = ensureSharedAudio();
      a.src =
        "data:audio/mp3;base64,//uQxAAAAAAAAAAAAAAAAAAAAAAAWGluZwAAAA8AAAACAAACcQCA" +
        "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
      a.volume = 0;
      await a.play().catch(() => {});
      a.pause();
      a.currentTime = 0;
      audioUnlocked = true;
      log("✅ iOS audio unlocked");
    } else {
      audioUnlocked = true;
    }
  } catch (e) {
    warn("unlockAudioSystem failed", e);
  }
}

/* ---------- ring.mp3 SFX ---------- */
function ensureRingSfx() {
  if (ringAudio) return ringAudio;
  ringAudio = new Audio("ring.mp3"); // put ring.mp3 in /app/ or root same level as call.html
  ringAudio.preload = "auto";
  ringAudio.playsInline = true;
  ringAudio.loop = true;
  ringAudio.volume = 0.65;
  return ringAudio;
}

async function playRingOnceOnConnect() {
  if (ringPlayed) return;
  ringPlayed = true;

  try {
    const r = ensureRingSfx();
    r.currentTime = 0;
    r.muted = false;
    await r.play().catch(() => {});
    log("🔔 ring started");
  } catch {}
}

function stopRing() {
  try {
    if (!ringAudio) return;
    ringAudio.pause();
    ringAudio.currentTime = 0;
    log("🔕 ring stopped");
  } catch {}
}

/* ---------- VAD setup ---------- */
async function ensureMicStream() {
  if (globalStream) return globalStream;

  globalStream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  });

  return globalStream;
}

function pickSupportedMime() {
  const candidates = [
    "audio/webm;codecs=opus",
    "audio/webm",
    "audio/ogg;codecs=opus",
    "audio/mp4",
  ];
  for (const m of candidates) {
    if (window.MediaRecorder && MediaRecorder.isTypeSupported?.(m)) return m;
  }
  return "audio/webm";
}

async function setupVAD() {
  if (vadAC) return;

  vadAC = new (window.AudioContext || window.webkitAudioContext)();
  if (vadAC.state === "suspended") {
    await vadAC.resume().catch(() => {});
  }

  const stream = await ensureMicStream();

  vadSource = vadAC.createMediaStreamSource(stream);
  vadAnalyser = vadAC.createAnalyser();
  vadAnalyser.fftSize = 1024;
  vadData = new Uint8Array(vadAnalyser.fftSize);

  vadSource.connect(vadAnalyser);

  log("✅ VAD ready");
}

function rmsFromTimeDomain(bytes) {
  let sum = 0;
  for (let i = 0; i < bytes.length; i++) {
    const v = (bytes[i] - 128) / 128;
    sum += v * v;
  }
  return Math.sqrt(sum / bytes.length);
}

function getMicEnergy() {
  if (!vadAnalyser || !vadData) return 0;
  vadAnalyser.getByteTimeDomainData(vadData);
  return rmsFromTimeDomain(vadData);
}

/* ---------- BARGE-IN ---------- */
function stopAIPlaybackForBargeIn() {
  if (!ttsPlayer) return;
  try {
    if (!isPlayingAI) return;
    ttsPlayer.pause();
    ttsPlayer.currentTime = 0;
    isPlayingAI = false;
    setStatus("Listening…");
    log("🛑 Barge-in: AI stopped");
  } catch {}
}

/* ---------- RECORD TURN CONTROL ---------- */
async function startRecordingTurn() {
  if (isRecording) return;

  const stream = await ensureMicStream();
  const mimeType = pickSupportedMime();

  recordChunks = [];
  mediaRecorder = new MediaRecorder(stream, { mimeType });
  isRecording = true;

  mediaRecorder.ondataavailable = (e) => {
    if (e.data?.size > 0) recordChunks.push(e.data);
  };

  mediaRecorder.onstop = () => {
    isRecording = false;
  };

  mediaRecorder.start();
}

async function stopRecordingTurn() {
  if (!isRecording || !mediaRecorder) return;

  try {
    if (mediaRecorder.state !== "inactive") mediaRecorder.stop();
  } catch {}

  // wait stop
  while (isRecording) {
    await new Promise((r) => setTimeout(r, 30));
  }
}

/* ---------- Transcribe audio -> text ---------- */
async function transcribeTurn() {
  if (!recordChunks.length) return "";

  setStatus("Transcribing…");

  try {
    const mime = mediaRecorder?.mimeType || "audio/webm";
    const blob = new Blob(recordChunks, { type: mime });

    const fd = new FormData();
    fd.append("audio", blob, "user.webm");
    fd.append("mime", mime);

    const resp = await fetch(TRANSCRIBE_ENDPOINT, {
      method: "POST",
      body: fd,
    });

    if (!resp.ok) {
      const t = await resp.text().catch(() => "");
      throw new Error(`Transcribe HTTP ${resp.status}: ${t || resp.statusText}`);
    }

    const data = await resp.json().catch(() => ({}));
    const text = (data?.text || data?.transcript || data?.utterance || "").toString().trim();
    return text;
  } catch (e) {
    warn("transcribeTurn error", e);
    return "";
  }
}

/* ---------- Merge logic ---------- */
function queueMergedSend(transcript) {
  if (!transcript) return;

  // Add to buffer
  mergedTranscriptBuffer = mergedTranscriptBuffer
    ? `${mergedTranscriptBuffer} ${transcript}`.trim()
    : transcript.trim();

  setInterim("Paused… (merging)");

  if (mergeTimer) clearTimeout(mergeTimer);

  mergeTimer = setTimeout(async () => {
    const final = mergedTranscriptBuffer.trim();
    mergedTranscriptBuffer = "";
    setInterim("");

    if (!final) return;

    addFinalLine("You: " + final);
    await sendTranscriptToCoachAndPlay(final);
  }, VAD_MERGE_WINDOW_MS);
}

/* ---------- Send transcript -> AI -> play ---------- */
async function sendTranscriptToCoachAndPlay(transcript) {
  const text = (transcript || "").trim();
  if (!text) return false;

  setStatus("Thinking…");

  try {
    const resp = await fetch(CALL_COACH_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        source: "voice",
        conversationId: conversationId || null,
        call_id: callId,
        device_id: deviceId,
        transcript: text,
      }),
    });

    if (!resp.ok) {
      const t = await resp.text().catch(() => "");
      throw new Error(`Coach HTTP ${resp.status}: ${t || resp.statusText}`);
    }

    const data = await resp.json().catch(() => ({}));
    const replyText = (data?.assistant_text || data?.text || "").trim();
    if (replyText) addFinalLine("AI: " + replyText);

    const b64 = data?.audio_base64;
    const mime = data?.mime || "audio/mpeg";

    if (!b64) {
      setStatus("No audio reply returned.");
      return false;
    }

    if (speakerMuted) {
      setStatus("Listening…");
      return true;
    }

    // Play AI
    isPlayingAI = true;
    setStatus("AI replying…");

    const ok = await playViaSharedPlayerFromBase64(b64, mime);

    isPlayingAI = false;
    setStatus("Listening…");

    return ok;
  } catch (e) {
    warn("sendTranscriptToCoachAndPlay error", e);
    isPlayingAI = false;
    setStatus("Network error.");
    return false;
  }
}

/* ---------- Playback base64 + AI ring sync ---------- */
function playViaSharedPlayerFromBase64(b64, mime = "audio/mpeg", limitMs = 30000) {
  return new Promise((resolve) => {
    const a = ensureSharedAudio();
    let done = false;

    const settle = (ok) => {
      if (done) return;
      done = true;
      a.onended = a.onerror = a.onabort = null;
      resolve(ok);
    };

    try {
      a.pause();
    } catch {}

    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const blob = new Blob([bytes], { type: mime });
    const url = URL.createObjectURL(blob);

    a.src = url;
    a.muted = speakerMuted;
    a.volume = speakerMuted ? 0 : 1;

    a.onerror = () => {
      URL.revokeObjectURL(url);
      settle(false);
    };
    a.onabort = () => {
      URL.revokeObjectURL(url);
      settle(false);
    };

    const t = setTimeout(() => {
      URL.revokeObjectURL(url);
      settle(false);
    }, limitMs);

    a.onended = () => {
      clearTimeout(t);
      URL.revokeObjectURL(url);
      settle(true);
    };

    a.play().catch(() => {
      clearTimeout(t);
      URL.revokeObjectURL(url);
      settle(false);
    });
  });
}

/* ---------- RINGS (premium) ---------- */
let ringCtx = null;
let ringRAF = null;

function setupRingCanvas() {
  if (!voiceRing) return;
  ringCtx = voiceRing.getContext("2d");
  resizeRing();
  window.addEventListener("resize", resizeRing);
}

function resizeRing() {
  if (!voiceRing) return;
  const rect = voiceRing.getBoundingClientRect();
  voiceRing.width = Math.floor(rect.width * devicePixelRatio);
  voiceRing.height = Math.floor(rect.height * devicePixelRatio);
}

function getAILevel() {
  if (!playbackAnalyser || !playbackData) return 0;
  playbackAnalyser.getByteTimeDomainData(playbackData);
  const rms = rmsFromTimeDomain(playbackData);
  return rms;
}

function drawRings() {
  if (!ringCtx || !voiceRing) return;

  const w = voiceRing.width;
  const h = voiceRing.height;
  const cx = w / 2;
  const cy = h / 2;

  ringCtx.clearRect(0, 0, w, h);

  const t = performance.now() / 1000;

  // Levels
  const micLevel = getMicEnergy(); // 0..~0.1
  const aiLevel = getAILevel();    // 0..~0.1

  // Premium shaping
  const micAmp = Math.min(1, micLevel / 0.12);
  const aiAmp = Math.min(1, aiLevel / 0.12);

  // Base radius
  const baseR = Math.min(w, h) * 0.32;

  // USER ring
  const userPulse = baseR + micAmp * (baseR * 0.18) + Math.sin(t * 3.2) * 2;
  drawGlowRing(cx, cy, userPulse, micAmp, true);

  // AI ring
  const aiPulse = baseR + (baseR * 0.12) + aiAmp * (baseR * 0.22) + Math.sin(t * 2.1) * 2;
  drawGlowRing(cx, cy, aiPulse, aiAmp, false);

  ringRAF = requestAnimationFrame(drawRings);
}

function drawGlowRing(cx, cy, r, amp, isUser) {
  const ctx = ringCtx;

  const glow = 12 + amp * 22;
  const line = 6 + amp * 6;

  // Gradient
  const g = ctx.createRadialGradient(cx, cy, r - 20, cx, cy, r + 40);
  if (isUser) {
    g.addColorStop(0, `rgba(120, 170, 255, ${0.15 + amp * 0.35})`);
    g.addColorStop(1, `rgba(120, 170, 255, 0)`);
  } else {
    g.addColorStop(0, `rgba(255, 200, 120, ${0.15 + amp * 0.35})`);
    g.addColorStop(1, `rgba(255, 200, 120, 0)`);
  }

  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);

  ctx.strokeStyle = isUser
    ? `rgba(120, 170, 255, ${0.35 + amp * 0.65})`
    : `rgba(255, 200, 120, ${0.35 + amp * 0.65})`;

  ctx.lineWidth = line;
  ctx.shadowBlur = glow;
  ctx.shadowColor = isUser
    ? `rgba(120, 170, 255, ${0.55 + amp * 0.45})`
    : `rgba(255, 200, 120, ${0.55 + amp * 0.45})`;

  ctx.stroke();

  // Soft outer aura
  ctx.shadowBlur = 0;
  ctx.strokeStyle = g;
  ctx.lineWidth = line * 2.2;
  ctx.globalAlpha = 0.9;
  ctx.stroke();

  ctx.restore();
}

/* ---------- VAD main loop ---------- */
async function startVADLoop() {
  if (vadLoopRunning) return;
  vadLoopRunning = true;

  lastVoiceTime = performance.now();
  speechDetected = false;
  vadState = "idle";
  currentSpeechStartedAt = 0;

  setStatus("Listening…");
  setInterim("");

  const loop = async () => {
    if (!isCalling) {
      vadLoopRunning = false;
      return;
    }

    // If mic muted, stay idle
    if (micMuted) {
      setInterim("Mic is muted…");
      requestAnimationFrame(loop);
      return;
    }

    const energy = getMicEnergy();
    const now = performance.now();

    const isVoice = energy > VAD_THRESHOLD;

    // Barge-in: if AI speaking and user starts talking
    if (isVoice && isPlayingAI) {
      stopAIPlaybackForBargeIn();
    }

    if (vadState === "idle") {
      // waiting for speech start
      if (isVoice) {
        vadState = "speaking";
        currentSpeechStartedAt = now;
        lastVoiceTime = now;
        speechDetected = true;

        stopRing(); // stop ring once user begins speaking
        await startRecordingTurn();

        setStatus("Listening…");
        setInterim("Speaking…");
      } else {
        // idle timeout fallback
        if (now - lastVoiceTime > VAD_IDLE_TIMEOUT_MS) {
          // stay idle but keep loop alive
          lastVoiceTime = now;
        }
      }
    } else if (vadState === "speaking") {
      if (isVoice) {
        lastVoiceTime = now;
        setInterim("Speaking…");
      } else {
        // silence detected
        const silenceFor = now - lastVoiceTime;
        const speechLen = now - currentSpeechStartedAt;

        setInterim("…");

        if (silenceFor >= VAD_SILENCE_MS) {
          // End turn
          vadState = "idle";
          setInterim("");

          if (speechLen < VAD_MIN_SPEECH_MS) {
            // ignore tiny noise
            await stopRecordingTurn();
            recordChunks = [];
            setStatus("Listening…");
          } else {
            await stopRecordingTurn();
            const transcript = await transcribeTurn();

            if (!transcript) {
              setStatus("Didn’t catch that. Try again…");
            } else {
              // MERGE: queue transcript into merge buffer
              queueMergedSend(transcript);
            }
          }

          lastVoiceTime = now;
        }
      }
    }

    requestAnimationFrame(loop);
  };

  loop();
}

/* ---------- Call controls ---------- */
callBtn?.addEventListener("click", async () => {
  await unlockAudioSystem();  // user gesture unlock
  if (!isCalling) startCall();
  else endCall();
});

async function startCall() {
  isCalling = true;
  clearTranscript();
  setStatus("Connecting…");

  ringPlayed = false;
  await playRingOnceOnConnect();

  try {
    await setupVAD();
    setupRingCanvas();
    if (!ringRAF) drawRings();

    setStatus("Listening…");
    await startVADLoop();
  } catch (e) {
    warn("startCall error", e);
    setStatus("Mic permission denied.");
    endCall();
  }
}

function endCall() {
  isCalling = false;

  stopRing();

  try {
    if (mergeTimer) clearTimeout(mergeTimer);
  } catch {}

  try {
    if (mediaRecorder && mediaRecorder.state !== "inactive") mediaRecorder.stop();
  } catch {}

  try {
    globalStream?.getTracks().forEach((t) => t.stop());
  } catch {}
  globalStream = null;

  try {
    if (ttsPlayer) {
      ttsPlayer.pause();
      ttsPlayer.currentTime = 0;
    }
  } catch {}

  setStatus("Call ended.");
  setInterim("");
}

/* ---------- Boot ---------- */
ensureSharedAudio();
setStatus("Tap the blue call button to begin.");
log("✅ call.js loaded: FREE TALK + VAD + MERGE + BARGE-IN + RING + PREMIUM RINGS");
