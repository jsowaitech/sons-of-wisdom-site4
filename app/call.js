// app/call.js
// Son of Wisdom — Call Mode
// ✅ PHONE-CALL PACE + ADAPTIVE VAD + TURN QUEUE (no duplicates) + SAFE PLAYBACK QUEUE
// ✅ DEBOUNCED BARGE-IN (no echo-trigger alternating skips)
// ✅ AUTO GREETING after ring
// ✅ iOS Safari canvas hardening (DPR clamp)

// -------------------- DEBUG --------------------
const DEBUG = true;
const log = (...a) => DEBUG && console.log("[SOW]", ...a);
const warn = (...a) => DEBUG && console.warn("[SOW]", ...a);

// -------------------- ENDPOINTS --------------------
const CALL_COACH_ENDPOINT = "/.netlify/functions/call-coach";
const TRANSCRIBE_ENDPOINT = "/.netlify/functions/openai-transcribe";
// Optional greeting function (if you have it). If not found, we fallback to call-coach greeting payload.
const GREETING_ENDPOINT = "/.netlify/functions/call-greeting";

// -------------------- TRANSCRIBE MODEL --------------------
const TRANSCRIBE_MODEL = "gpt-4o-mini-transcribe";

// -------------------- URL PARAMS --------------------
const urlParams = new URLSearchParams(window.location.search);
const conversationId = urlParams.get("c") || null;

// -------------------- DOM --------------------
const callBtn = document.getElementById("call-btn");
const statusText = document.getElementById("status-text");
const micBtn = document.getElementById("mic-btn");
const speakerBtn = document.getElementById("speaker-btn");
const modeBtn = document.getElementById("mode-btn");

const transcriptList = document.getElementById("transcriptList");
const transcriptInterim = document.getElementById("transcriptInterim");
const clearBtn = document.getElementById("ts-clear");
const autoscrollBtn = document.getElementById("ts-autoscroll");

const voiceRing = document.getElementById("voiceRing");

// -------------------- PLATFORM --------------------
const IS_IOS =
  /iPad|iPhone|iPod/i.test(navigator.userAgent || "") ||
  (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);

// Clamp DPR to avoid iOS canvas / memory blow-ups
const DPR = Math.min(window.devicePixelRatio || 1, IS_IOS ? 2 : 3);

// -------------------- STATE --------------------
let isCalling = false;
let micMuted = false;
let speakerMuted = false;

let autoScroll = true;
let lastFinalLine = "";

// Merge buffer (frontend turn merge)
let mergedTranscriptBuffer = "";
let mergeTimer = null;

// MediaRecorder / mic
let globalStream = null;
let mediaRecorder = null;
let isRecording = false;
let recordChunks = [];

// VAD
let vadAC = null;
let vadSource = null;
let vadAnalyser = null;
let vadData = null;
let vadLoopRunning = false;
let vadState = "idle";
let lastVoiceTime = 0;
let speechStartTime = 0;

// Adaptive noise floor
let noiseFloor = 0.01;
let noiseSamples = 0;
let lastNoiseUpdate = 0;

// Phone-call pace (slower cutoffs)
const VAD_SILENCE_MS = 1400;
const VAD_MERGE_WINDOW_MS = 1700;
const VAD_MIN_SPEECH_MS = 360;
const VAD_IDLE_TIMEOUT_MS = 25000;

// Adaptive threshold tuning
const NOISE_FLOOR_UPDATE_MS = 250;
const THRESHOLD_MULTIPLIER = 2.1;
const THRESHOLD_MIN = 0.017;
const THRESHOLD_MAX = 0.095;

// -------------------- BARGE-IN HARDENING --------------------
// Fix alternating playback by preventing echo-trigger barge-in
let isPlayingAI = false;
let aiPlaybackStartedAt = 0;
let bargeCandidateSince = 0;

const BARGE_IGNORE_START_MS = 450;     // ignore first 450ms of AI playback
const BARGE_DEBOUNCE_MS = 320;         // must be sustained for 320ms
const BARGE_MULTIPLIER = 3.2;          // barge threshold = baseThreshold * 3.2
const BARGE_MIN_ABS = 0.032;           // absolute minimum
const BARGE_AI_GUARD = 1.85;           // require micEnergy > aiLevel*1.85 + offset
const BARGE_AI_OFFSET = 0.02;

// -------------------- ABORTS --------------------
let transcribeAbort = null;
let coachAbort = null;

// -------------------- TURN QUEUE / LOCK --------------------
// Prevent multiple coach requests / duplicated AI replies
let turnQueue = [];
let turnProcessing = false;

// -------------------- AUDIO PLAYBACK (SAFE QUEUE) --------------------
let ttsPlayer = null;
let playbackAC = null;
let playbackAnalyser = null;
let playbackData = null;
let audioUnlocked = false;

let playbackQueue = Promise.resolve(); // serialize playback (fixes overlap)
let cancelPlaybackNow = null;

// -------------------- RING SFX --------------------
let ringAudio = null;
let ringPlayed = false;

// -------------------- HELPERS --------------------
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
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

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

// -------------------- UI BUTTONS --------------------
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

// -------------------- AUDIO SYSTEM --------------------
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
    if (playbackAC.state === "suspended") await playbackAC.resume().catch(() => {});

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
    } else {
      audioUnlocked = true;
    }
  } catch (e) {
    warn("unlockAudioSystem failed", e);
  }
}

// -------------------- RING SFX --------------------
function ensureRingSfx() {
  if (ringAudio) return ringAudio;
  ringAudio = new Audio("ring.mp3");
  ringAudio.preload = "auto";
  ringAudio.playsInline = true;
  ringAudio.loop = false;
  ringAudio.volume = 0.65;
  return ringAudio;
}

async function playRingOnceOnConnect() {
  if (ringPlayed) return;
  ringPlayed = true;
  try {
    const r = ensureRingSfx();
    r.pause();
    r.currentTime = 0;
    await r.play().catch(() => {});
    log("🔔 ring played");
  } catch {}
}
function stopRing() {
  try {
    if (!ringAudio) return;
    ringAudio.pause();
    ringAudio.currentTime = 0;
  } catch {}
}

// -------------------- MIC / RECORDER --------------------
async function ensureMicStream() {
  if (globalStream) return globalStream;

  globalStream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  });

  try {
    globalStream.getAudioTracks().forEach((t) => (t.enabled = !micMuted));
  } catch {}

  return globalStream;
}

function pickSupportedMime() {
  const candidates = ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus", "audio/mp4"];
  for (const m of candidates) {
    if (window.MediaRecorder && MediaRecorder.isTypeSupported?.(m)) return m;
  }
  return "audio/webm";
}

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

  // timeslice helps iOS reliability a bit
  mediaRecorder.start(IS_IOS ? 250 : undefined);
}

async function stopRecordingTurn() {
  if (!isRecording || !mediaRecorder) return;
  try {
    if (mediaRecorder.state !== "inactive") mediaRecorder.stop();
  } catch {}
  while (isRecording) await sleep(25);
  mediaRecorder = null;
}

// -------------------- VAD --------------------
async function setupVAD() {
  if (vadAC) return;

  vadAC = new (window.AudioContext || window.webkitAudioContext)();
  if (vadAC.state === "suspended") await vadAC.resume().catch(() => {});
  const stream = await ensureMicStream();

  vadSource = vadAC.createMediaStreamSource(stream);
  vadAnalyser = vadAC.createAnalyser();
  vadAnalyser.fftSize = 1024;
  vadData = new Uint8Array(vadAnalyser.fftSize);
  vadSource.connect(vadAnalyser);

  noiseFloor = 0.01;
  noiseSamples = 0;
  lastNoiseUpdate = performance.now();

  log("✅ VAD ready (adaptive, phone-call pace)");
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

function getAILevel() {
  if (!playbackAnalyser || !playbackData) return 0;
  playbackAnalyser.getByteTimeDomainData(playbackData);
  return rmsFromTimeDomain(playbackData);
}

function computeAdaptiveThreshold() {
  let thr = noiseFloor * THRESHOLD_MULTIPLIER;
  if (!Number.isFinite(thr)) thr = 0.03;
  return Math.max(THRESHOLD_MIN, Math.min(THRESHOLD_MAX, thr));
}

function maybeUpdateNoiseFloor(energy, now) {
  if (now - lastNoiseUpdate < NOISE_FLOOR_UPDATE_MS) return;
  lastNoiseUpdate = now;

  const capped = Math.min(energy, noiseFloor * 3 + 0.01);
  if (noiseSamples < 1) {
    noiseFloor = capped;
    noiseSamples = 1;
    return;
  }
  const alpha = 0.10;
  noiseFloor = noiseFloor * (1 - alpha) + capped * alpha;
  noiseSamples += 1;
  noiseFloor = Math.max(0.004, Math.min(0.05, noiseFloor));
}

// -------------------- BARGE-IN (SAFE) --------------------
function shouldTriggerBargeIn({ micEnergy, baseThreshold, now }) {
  if (!isPlayingAI) return false;
  if (micMuted) return false;

  if (now - aiPlaybackStartedAt < BARGE_IGNORE_START_MS) return false;

  const aiLevel = getAILevel(); // how loud Blake is right now
  const bargeThr = Math.max(baseThreshold * BARGE_MULTIPLIER, BARGE_MIN_ABS);
  const aiGuardThr = aiLevel * BARGE_AI_GUARD + BARGE_AI_OFFSET;

  const effectiveThr = Math.max(bargeThr, aiGuardThr);

  if (micEnergy <= effectiveThr) {
    bargeCandidateSince = 0;
    return false;
  }

  if (!bargeCandidateSince) bargeCandidateSince = now;
  return now - bargeCandidateSince >= BARGE_DEBOUNCE_MS;
}

function cancelAnyPlayback() {
  try {
    if (typeof cancelPlaybackNow === "function") cancelPlaybackNow("cancel");
  } catch {}
  cancelPlaybackNow = null;
}

function stopAIPlaybackForBargeIn() {
  if (!ttsPlayer || !isPlayingAI) return;

  cancelAnyPlayback();
  try {
    ttsPlayer.pause();
    ttsPlayer.currentTime = 0;
    ttsPlayer.src = ""; // important: stop current load cleanly
  } catch {}

  isPlayingAI = false;
  bargeCandidateSince = 0;
  setStatus("Listening…");
  log("🛑 Barge-in: AI stopped");
}

// -------------------- TRANSCRIBE --------------------
async function transcribeTurn() {
  if (!recordChunks.length) return "";

  setStatus("Transcribing…");
  try { transcribeAbort?.abort(); } catch {}
  transcribeAbort = new AbortController();

  try {
    const blob = new Blob(recordChunks, { type: "audio/webm" });

    const fd = new FormData();
    fd.append("file", blob, "user.webm");
    fd.append("model", TRANSCRIBE_MODEL);
    fd.append("response_format", "json");

    const resp = await fetch(TRANSCRIBE_ENDPOINT, {
      method: "POST",
      body: fd,
      signal: transcribeAbort.signal,
    });

    if (!resp.ok) {
      const t = await resp.text().catch(() => "");
      throw new Error(`Transcribe HTTP ${resp.status}: ${t || resp.statusText}`);
    }

    const data = await resp.json().catch(() => ({}));
    return (data?.text || "").toString().trim();
  } catch (e) {
    if (e?.name === "AbortError") return "";
    warn("transcribeTurn error", e);
    return "";
  } finally {
    transcribeAbort = null;
  }
}

// -------------------- TURN MERGE + QUEUE --------------------
function queueMergedSend(transcript) {
  if (!transcript) return;

  mergedTranscriptBuffer = mergedTranscriptBuffer
    ? `${mergedTranscriptBuffer} ${transcript}`.trim()
    : transcript.trim();

  setInterim("Paused…");

  if (mergeTimer) clearTimeout(mergeTimer);

  mergeTimer = setTimeout(() => {
    mergeTimer = null;

    const final = mergedTranscriptBuffer.trim();
    mergedTranscriptBuffer = "";
    setInterim("");

    if (!final || !isCalling) return;

    enqueueTurn(final);
  }, VAD_MERGE_WINDOW_MS);
}

function enqueueTurn(text) {
  // push to queue and process sequentially
  turnQueue.push(text);
  processTurnQueue().catch(() => {});
}

async function processTurnQueue() {
  if (turnProcessing) return;
  turnProcessing = true;

  try {
    while (isCalling && turnQueue.length) {
      const text = (turnQueue.shift() || "").trim();
      if (!text) continue;

      addFinalLine("You: " + text);

      // only one coach request at a time
      await sendTranscriptToCoachAndPlay(text);
    }
  } finally {
    turnProcessing = false;
  }
}

// -------------------- COACH + PLAY --------------------
async function sendTranscriptToCoachAndPlay(text) {
  if (!text || !isCalling) return false;

  setStatus("Thinking…");
  try { coachAbort?.abort(); } catch {}
  coachAbort = new AbortController();

  try {
    const resp = await fetch(CALL_COACH_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: coachAbort.signal,
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
    if (!isCalling) return false;

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

    stopRing();

    // SERIALIZE playback so no overlap / no skipping
    await enqueuePlayback(b64, mime);

    if (isCalling) setStatus("Listening…");
    return true;
  } catch (e) {
    if (e?.name === "AbortError") return false;
    warn("coach/play error", e);
    if (isCalling) setStatus("Network error.");
    return false;
  } finally {
    coachAbort = null;
  }
}

// -------------------- PLAYBACK QUEUE (fix blob ERR + alternating) --------------------
function enqueuePlayback(b64, mime) {
  playbackQueue = playbackQueue.then(() => playBase64Safe(b64, mime)).catch(() => {});
  return playbackQueue;
}

function playBase64Safe(b64, mime = "audio/mpeg", limitMs = 45000) {
  return new Promise((resolve) => {
    const a = ensureSharedAudio();
    let done = false;

    // Build blob URL
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const blob = new Blob([bytes], { type: mime });
    const url = URL.createObjectURL(blob);

    // Start AI speaking window
    isPlayingAI = true;
    aiPlaybackStartedAt = performance.now();
    bargeCandidateSince = 0;

    setStatus("AI replying…");

    const cleanup = async () => {
      // Important: clear src before revoking to prevent ERR_FILE_NOT_FOUND
      try { a.pause(); } catch {}
      try { a.src = ""; } catch {}
      try { a.load?.(); } catch {}
      // small delay lets browser detach the resource cleanly
      await sleep(60);
      try { URL.revokeObjectURL(url); } catch {}

      a.onended = a.onerror = a.onabort = null;
      cancelPlaybackNow = null;

      isPlayingAI = false;
      bargeCandidateSince = 0;
    };

    const settle = async (ok) => {
      if (done) return;
      done = true;
      await cleanup();
      resolve(ok);
    };

    cancelPlaybackNow = async () => {
      await settle(true);
    };

    // Configure audio
    a.muted = speakerMuted;
    a.volume = speakerMuted ? 0 : 1;

    a.onerror = () => settle(false);
    a.onabort = () => settle(false);

    const timer = setTimeout(() => settle(false), limitMs);

    a.onended = () => {
      clearTimeout(timer);
      settle(true);
    };

    try {
      a.pause();
      a.currentTime = 0;
    } catch {}

    a.src = url;

    a.play()
      .then(() => {
        // playing
      })
      .catch(() => {
        clearTimeout(timer);
        settle(false);
      });
  });
}

// -------------------- RINGS (iOS-safe) --------------------
let ringCtx = null;
let ringRAF = null;

function setupRingCanvas() {
  if (!voiceRing) return;
  ringCtx = voiceRing.getContext("2d", { alpha: true });
  resizeRing();
  window.addEventListener("resize", resizeRing);
}

function resizeRing() {
  if (!voiceRing) return;
  const rect = voiceRing.getBoundingClientRect();
  voiceRing.width = Math.floor(rect.width * DPR);
  voiceRing.height = Math.floor(rect.height * DPR);
}

function drawRings() {
  if (!ringCtx || !voiceRing) return;

  const w = voiceRing.width;
  const h = voiceRing.height;
  const cx = w / 2;
  const cy = h / 2;

  ringCtx.clearRect(0, 0, w, h);

  const t = performance.now() / 1000;

  const micLevel = getMicEnergy();
  const aiLevel = getAILevel();

  const micAmp = Math.min(1, micLevel / 0.12);
  const aiAmp = Math.min(1, aiLevel / 0.12);

  const baseR = Math.min(w, h) * 0.32;

  // Reduce ring complexity on iOS
  const userPulse = baseR + micAmp * (baseR * (IS_IOS ? 0.12 : 0.18)) + Math.sin(t * 3.1) * (IS_IOS ? 1.2 : 2);
  const aiPulse = baseR + (baseR * 0.12) + aiAmp * (baseR * (IS_IOS ? 0.14 : 0.22)) + Math.sin(t * 2.0) * (IS_IOS ? 1.1 : 2);

  drawGlowRing(cx, cy, userPulse, micAmp, true);
  drawGlowRing(cx, cy, aiPulse, aiAmp, false);

  ringRAF = requestAnimationFrame(drawRings);
}

function drawGlowRing(cx, cy, r, amp, isUser) {
  const ctx = ringCtx;
  const glow = (IS_IOS ? 8 : 12) + amp * (IS_IOS ? 14 : 22);
  const line = (IS_IOS ? 5 : 6) + amp * (IS_IOS ? 4 : 6);

  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);

  ctx.strokeStyle = isUser
    ? `rgba(120,170,255,${0.35 + amp * 0.65})`
    : `rgba(255,200,120,${0.35 + amp * 0.65})`;

  ctx.lineWidth = line;
  ctx.shadowBlur = glow;
  ctx.shadowColor = isUser
    ? `rgba(120,170,255,${0.55 + amp * 0.45})`
    : `rgba(255,200,120,${0.55 + amp * 0.45})`;

  ctx.stroke();
  ctx.restore();
}

// -------------------- AUTO GREETING --------------------
async function runGreeting() {
  if (!isCalling) return;

  // Prevent greeting stacking
  if (turnQueue.length || turnProcessing) return;

  setStatus("Connecting…");

  // Try call-greeting first; if missing, fallback to call-coach with greeting flag
  try {
    const resp = await fetch(GREETING_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        conversationId: conversationId || null,
        call_id: callId,
        device_id: deviceId,
      }),
    });

    if (resp.ok) {
      const data = await resp.json().catch(() => ({}));
      const replyText = (data?.assistant_text || data?.text || "").trim();
      if (replyText) addFinalLine("AI: " + replyText);

      const b64 = data?.audio_base64;
      const mime = data?.mime || "audio/mpeg";
      if (b64 && !speakerMuted) {
        await enqueuePlayback(b64, mime);
      }
      return;
    }
  } catch {
    // ignore and fallback
  }

  // Fallback: call-coach greeting
  try {
    const resp2 = await fetch(CALL_COACH_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        source: "voice",
        greeting: true,
        conversationId: conversationId || null,
        call_id: callId,
        device_id: deviceId,
        transcript: "",
      }),
    });

    if (!resp2.ok) return;

    const data2 = await resp2.json().catch(() => ({}));
    const replyText2 = (data2?.assistant_text || data2?.text || "").trim();
    if (replyText2) addFinalLine("AI: " + replyText2);

    const b64_2 = data2?.audio_base64;
    const mime_2 = data2?.mime || "audio/mpeg";
    if (b64_2 && !speakerMuted) {
      await enqueuePlayback(b64_2, mime_2);
    }
  } catch {}
}

// -------------------- VAD LOOP --------------------
async function startVADLoop() {
  if (vadLoopRunning) return;
  vadLoopRunning = true;

  vadState = "idle";
  lastVoiceTime = performance.now();
  speechStartTime = 0;

  setStatus("Listening…");
  setInterim("");

  const loop = async () => {
    if (!isCalling) {
      vadLoopRunning = false;
      return;
    }

    const now = performance.now();
    const energy = getMicEnergy();

    // Only update baseline when NOT playing AI (prevents baseline drift from speaker bleed)
    if (vadState === "idle" && !micMuted && !isPlayingAI) {
      maybeUpdateNoiseFloor(energy, now);
    }

    const baseThreshold = computeAdaptiveThreshold();
    const isVoice = !micMuted && energy > baseThreshold;

    // Barge-in check (debounced + AI level guard)
    if (shouldTriggerBargeIn({ micEnergy: energy, baseThreshold, now })) {
      stopAIPlaybackForBargeIn();
    }

    if (vadState === "idle") {
      if (isVoice) {
        vadState = "speaking";
        speechStartTime = now;
        lastVoiceTime = now;

        stopRing();
        await startRecordingTurn();
        if (!isCalling) return;

        setInterim("Speaking…");
      } else {
        if (now - lastVoiceTime > VAD_IDLE_TIMEOUT_MS) lastVoiceTime = now;
      }
    } else if (vadState === "speaking") {
      if (isVoice) {
        lastVoiceTime = now;
        setInterim("Speaking…");
      } else {
        const silenceFor = now - lastVoiceTime;
        const speechLen = now - speechStartTime;

        setInterim("…");

        // Don't end too quickly within the first ~450ms of speaking (natural hesitation)
        const minTurnWindow = 450;
        const canEnd = speechLen > minTurnWindow;

        if (canEnd && silenceFor >= VAD_SILENCE_MS) {
          vadState = "idle";
          setInterim("");

          await stopRecordingTurn();
          if (!isCalling) return;

          if (speechLen < VAD_MIN_SPEECH_MS) {
            recordChunks = [];
            setStatus("Listening…");
          } else {
            const transcript = await transcribeTurn();
            if (!isCalling) return;

            if (!transcript) {
              setStatus("Didn’t catch that. Try again…");
            } else {
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

// -------------------- CALL CONTROLS --------------------
callBtn?.addEventListener("click", async () => {
  await unlockAudioSystem();
  if (!isCalling) startCall();
  else endCall();
});

async function startCall() {
  isCalling = true;

  // Full reset for duplicates
  clearTranscript();
  turnQueue = [];
  turnProcessing = false;
  mergedTranscriptBuffer = "";
  if (mergeTimer) clearTimeout(mergeTimer);
  mergeTimer = null;

  setStatus("Connecting…");

  try { transcribeAbort?.abort(); } catch {}
  try { coachAbort?.abort(); } catch {}
  transcribeAbort = null;
  coachAbort = null;

  cancelAnyPlayback();
  isPlayingAI = false;

  ringPlayed = false;
  await playRingOnceOnConnect();

  try {
    await setupVAD();
    setupRingCanvas();
    if (!ringRAF) drawRings();

    // ✅ Greeting after ring
    await runGreeting();

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

  try { if (mergeTimer) clearTimeout(mergeTimer); } catch {}
  mergeTimer = null;
  mergedTranscriptBuffer = "";

  turnQueue = [];
  turnProcessing = false;

  try { transcribeAbort?.abort(); } catch {}
  try { coachAbort?.abort(); } catch {}
  transcribeAbort = null;
  coachAbort = null;

  stopRing();

  try {
    if (mediaRecorder && mediaRecorder.state !== "inactive") mediaRecorder.stop();
  } catch {}
  mediaRecorder = null;
  isRecording = false;
  recordChunks = [];

  try { globalStream?.getTracks().forEach((t) => t.stop()); } catch {}
  globalStream = null;

  try {
    cancelAnyPlayback();
    if (ttsPlayer) {
      ttsPlayer.pause();
      ttsPlayer.currentTime = 0;
      ttsPlayer.src = "";
    }
  } catch {}

  isPlayingAI = false;
  bargeCandidateSince = 0;

  setStatus("Call ended.");
  setInterim("");
}

// -------------------- BOOT --------------------
ensureSharedAudio();
setStatus("Tap the blue call button to begin.");
log("✅ call.js loaded: PHONE-CALL PACE + ADAPTIVE VAD + TURN QUEUE + SAFE PLAYBACK + DEBOUNCED BARGE-IN + GREETING + iOS SAFE RINGS");
