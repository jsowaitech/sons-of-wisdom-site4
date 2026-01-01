// app/call.js
// Son of Wisdom — Call mode
// ✅ Uses real Netlify functions you have:
//    - /.netlify/functions/openai-transcribe  (audio -> transcript)
//    - /.netlify/functions/call-coach         (transcript -> AI text + TTS audio)
// ✅ iOS Safari audio hardened:
//    - unlockAudioSystem() runs ONLY on Start Call tap
//    - single shared <audio> player for all playback
// ✅ Uses transcript DOM from call.html:
//    #transcriptList + #transcriptInterim
// ✅ No n8n
// ✅ Fixes Start Call crash by guarding missing DOM
// ✅ FIX: OpenAI transcribe requires multipart field "file" + "model"

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

/* Transcript DOM (from call.html) */
const transcriptList = document.getElementById("transcriptList");
const transcriptInterim = document.getElementById("transcriptInterim");

/* Transcript Controls */
const clearBtn = document.getElementById("ts-clear");
const autoscrollBtn = document.getElementById("ts-autoscroll");

/* ---------- STATE ---------- */
let isCalling = false;
let isRecording = false;
let isPlayingAI = false;

let globalStream = null;
let mediaRecorder = null;
let recordChunks = [];

let micMuted = false;
let speakerMuted = false;

let autoScroll = true;
let lastFinalLine = "";

/* ---------- iOS Safari detection ---------- */
const IS_IOS =
  /iPad|iPhone|iPod/i.test(navigator.userAgent || "") ||
  (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);

/* ---------- Shared audio system ---------- */
let ttsPlayer = null;
let audioUnlocked = false;
let playbackAC = null;

function ensureSharedAudio() {
  if (ttsPlayer) return ttsPlayer;
  ttsPlayer = new Audio();
  ttsPlayer.preload = "auto";
  ttsPlayer.playsInline = true;
  ttsPlayer.crossOrigin = "anonymous";
  return ttsPlayer;
}

async function unlockAudioSystem() {
  try {
    ensureSharedAudio();

    playbackAC ||= new (window.AudioContext || window.webkitAudioContext)();
    if (playbackAC.state === "suspended") {
      await playbackAC.resume().catch(() => {});
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

function playViaSharedPlayerFromBase64(b64, mime = "audio/mpeg", limitMs = 25000) {
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

/* ---------- Safe UI helpers ---------- */
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
}

/* ---------- Clear + AutoScroll buttons ---------- */
clearBtn?.addEventListener("click", clearTranscript);

autoscrollBtn?.addEventListener("click", () => {
  autoScroll = !autoScroll;
  autoscrollBtn.setAttribute("aria-pressed", String(autoScroll));
  autoscrollBtn.textContent = autoScroll ? "On" : "Off";
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

/* ---------- MIME picking ---------- */
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

/* ---------- Controls ---------- */
micBtn?.addEventListener("click", () => {
  micMuted = !micMuted;
  if (globalStream) {
    globalStream.getAudioTracks().forEach((t) => (t.enabled = !micMuted));
  }
  setStatus(micMuted ? "Mic muted." : "Mic unmuted.");
  const lbl = document.getElementById("mic-label");
  if (lbl) lbl.textContent = micMuted ? "Unmute" : "Mute";
});

speakerBtn?.addEventListener("click", () => {
  speakerMuted = !speakerMuted;
  if (ttsPlayer) {
    ttsPlayer.muted = speakerMuted;
    ttsPlayer.volume = speakerMuted ? 0 : 1;
  }
  setStatus(speakerMuted ? "Speaker muted." : "Speaker on.");
  const lbl = document.getElementById("speaker-label");
  if (lbl) lbl.textContent = speakerMuted ? "Speaker Off" : "Speaker";
});

modeBtn?.addEventListener("click", () => {
  const url = new URL("home.html", window.location.origin);
  if (conversationId) url.searchParams.set("c", conversationId);
  window.location.href = url.toString();
});

/* ---------- Call button ---------- */
callBtn?.addEventListener("click", async () => {
  await unlockAudioSystem(); // ✅ user gesture unlock for iOS Safari
  if (!isCalling) startCall();
  else endCall();
});

/* ---------- Call flow ---------- */
async function startCall() {
  isCalling = true;
  clearTranscript();
  setStatus("Listening…");
  await startRecordingLoop();
}

function endCall() {
  isCalling = false;
  isRecording = false;
  isPlayingAI = false;
  setStatus("Call ended.");

  try {
    if (mediaRecorder && mediaRecorder.state !== "inactive") mediaRecorder.stop();
  } catch {}

  try {
    globalStream?.getTracks().forEach((t) => t.stop());
  } catch {}
  globalStream = null;
}

/* ---------- Recording loop ---------- */
async function startRecordingLoop() {
  while (isCalling) {
    if (micMuted) {
      setInterim("Mic is muted…");
      await sleep(400);
      continue;
    }

    const ok = await captureOneTurn();
    if (!ok) continue;

    const transcript = await transcribeTurn();
    if (!transcript) {
      setStatus("Didn’t catch that. Try again…");
      continue;
    }

    addFinalLine("You: " + transcript);

    const played = await sendTranscriptToCoachAndPlay(transcript);
    if (!played) setStatus("Listening…");
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/* ---------- Capture audio turn ---------- */
async function captureOneTurn() {
  if (!isCalling || isRecording || isPlayingAI) return false;

  recordChunks = [];
  setInterim("Listening…");

  try {
    globalStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true },
    });

    const mimeType = pickSupportedMime();
    mediaRecorder = new MediaRecorder(globalStream, { mimeType });
    isRecording = true;

    mediaRecorder.ondataavailable = (e) => {
      if (e.data?.size > 0) recordChunks.push(e.data);
    };

    mediaRecorder.onstop = () => {
      isRecording = false;
      setInterim("");
      try {
        globalStream?.getTracks().forEach((t) => t.stop());
      } catch {}
      globalStream = null;
    };

    mediaRecorder.start();

    // simple fixed window (tweak as needed)
    await sleep(3500);

    try {
      if (mediaRecorder.state !== "inactive") mediaRecorder.stop();
    } catch {}

    // wait stop
    while (isRecording) await sleep(50);

    return recordChunks.length > 0;
  } catch (e) {
    warn("captureOneTurn error", e);
    setStatus("Mic permission denied.");
    endCall();
    return false;
  }
}

/* ---------- Transcribe audio -> text (openai-transcribe) ---------- */
async function transcribeTurn() {
  if (!recordChunks.length) return "";

  setStatus("Transcribing…");

  try {
    const mime = mediaRecorder?.mimeType || "audio/webm";
    const blob = new Blob(recordChunks, { type: mime });

    const fd = new FormData();

    // ✅ FIX: OpenAI expects multipart field name "file"
    fd.append("file", blob, "user.webm");

    // ✅ FIX: OpenAI requires model for transcriptions
    fd.append("model", "whisper-1");

    // optional but safe
    fd.append("response_format", "json");

    const resp = await fetch(TRANSCRIBE_ENDPOINT, {
      method: "POST",
      body: fd,
    });

    if (!resp.ok) {
      const t = await resp.text().catch(() => "");
      throw new Error(`Transcribe HTTP ${resp.status}: ${t || resp.statusText}`);
    }

    const data = await resp.json().catch(() => ({}));

    const text = (data?.text || "").toString().trim();
    return text;
  } catch (e) {
    warn("transcribeTurn error", e);
    return "";
  }
}

/* ---------- Send transcript to coach -> play audio ---------- */
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

    isPlayingAI = true;
    setStatus("AI replying…");

    const ok = await playViaSharedPlayerFromBase64(b64, mime);

    isPlayingAI = false;
    setStatus(ok ? "Listening…" : "Audio blocked. Tap Start Call again.");
    return ok;
  } catch (e) {
    warn("sendTranscriptToCoachAndPlay error", e);
    isPlayingAI = false;
    setStatus("Network error.");
    return false;
  }
}

/* ---------- Boot ---------- */
ensureSharedAudio();
setStatus("Tap the blue call button to begin.");
log("✅ call.js ready (openai-transcribe -> call-coach, Safari safe)");
