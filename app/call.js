// app/call.js
// Son of Wisdom — Call mode
// - Continuous VAD recording → Supabase (optional) → Netlify coach function → AI audio reply
// - Web Speech API captions + optional Hume realtime (safely stubbed)
// - Dynamic AI greeting audio via Netlify function + ElevenLabs
// - Conversation thread awareness + auto-title from first transcript
//
// ✅ PATCH (iPhone Safari TTS reliability):
//    - Single persistent audio element (ttsPlayer)
//    - unlockAudioSystem() runs on Start Call tap (gesture bound)
//    - All playback routes through shared player
//    - AudioContext resume + "silent unlock" for iOS
//    - Adds play retry + forced re-resume before each AI playback
//
// ✅ PATCH (Remove n8n):
//    - Calls /.netlify/functions/call-coach for voice + chat responses
//    - Expects JSON: { text, audio_base64, mime }
//    - Converts base64 to Blob URL and plays via shared player

/* ---------- CONFIG ---------- */
const DEBUG = true;

/* Optional: Hume realtime SDK (safe stub if not loaded) */
const HumeRealtime = (window.HumeRealtime ?? {
  init() {},
  startTurn() {},
  handleRecorderChunk() {},
  stopTurn() {},
});
HumeRealtime.init?.({ enable: false });

/* ---------- Supabase (OPTIONAL) ---------- */
/**
 * In local dev you can inject:
 *   window.SUPABASE_SERVICE_ROLE_KEY = "....";
 * For production we recommend proxying through a secure backend instead of
 * exposing a service role key to the browser.
 */
const SUPABASE_URL = "https://plrobtlpedniyvkpwdmp.supabase.co";
const SUPABASE_SERVICE_ROLE_KEY = window.SUPABASE_SERVICE_ROLE_KEY || "";
const HAS_SUPABASE =
  Boolean(SUPABASE_URL) && Boolean(SUPABASE_SERVICE_ROLE_KEY);

// Storage
const SUPABASE_BUCKET = "audiossow";
const RECORDINGS_FOLDER = "recordings";

// REST (history/summary/threads)
const SUPABASE_REST = `${SUPABASE_URL}/rest/v1`;
const HISTORY_TABLE = "call_sessions";
const HISTORY_USER_COL = "user_id_uuid";
const HISTORY_SELECT = "input_transcript,ai_text,timestamp";
const HISTORY_TIME_COL = "timestamp";

const SUMMARY_TABLE = "history_summaries";
const SUMMARY_MAX_CHARS = 380;

const CONVERSATIONS_TABLE = "conversations";

/* ---------- Coach workflow endpoint (Netlify) ---------- */
const WORKFLOW_ENDPOINT = "/.netlify/functions/call-coach";

/* ---------- Netlify / ElevenLabs greeting ---------- */
const GREETING_ENDPOINT = "/.netlify/functions/call-greeting";

/* ---------- I/O settings ---------- */
const ENABLE_MEDIARECORDER_64KBPS = true;
const TIMESLICE_MS = 100;
const ENABLE_STREAMED_PLAYBACK = false; // not supported by call-coach.js (JSON)
const ENABLE_SYSTEM_NO_RESPONSE = true;

/* ---------- USER / DEVICE ---------- */
const USER_ID_KEY = "sow_user_id";
const DEVICE_ID_KEY = "sow_device_id";
const SENTINEL_UUID = "00000000-0000-0000-0000-000000000000";

const isUuid = (v) =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    v || ""
  );

function getOrCreateDeviceId() {
  let id = localStorage.getItem(DEVICE_ID_KEY);
  if (!id) {
    id =
      crypto.randomUUID?.() ||
      `anon_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    localStorage.setItem(DEVICE_ID_KEY, id);
  }
  return id;
}

function getUserIdForWebhook() {
  return localStorage.getItem(USER_ID_KEY) || getOrCreateDeviceId();
}

// For history/summary — if we don't have a valid UUID, collapse into sentinel.
const USER_UUID_OVERRIDE = null;
const pickUuidForHistory = (user_id) =>
  USER_UUID_OVERRIDE && isUuid(USER_UUID_OVERRIDE)
    ? USER_UUID_OVERRIDE
    : isUuid(user_id)
    ? user_id
    : SENTINEL_UUID;

/* ---------- Conversation / thread metadata ---------- */

// ?c=<conversation_id> from home.html
const urlParams = new URLSearchParams(window.location.search);
const conversationId = urlParams.get("c") || null;

// Local cache of conversation title + flags
let convTitleCached = null;
let convMetaLoaded = false;
let hasAppliedTitleFromCall = false;

function loadLocalConvos() {
  try {
    const raw = localStorage.getItem("convos") || "[]";
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveLocalConvos(convos) {
  try {
    localStorage.setItem("convos", JSON.stringify(convos));
  } catch {
    // ignore
  }
}

function touchLocalConversationFromCall(newTitle) {
  if (!conversationId) return;
  const convos = loadLocalConvos();
  const nowIso = new Date().toISOString();
  const idx = convos.findIndex((c) => c.id === conversationId);
  if (idx >= 0) {
    convos[idx].updated_at = nowIso;
    if (newTitle) convos[idx].title = newTitle;
  } else {
    convos.unshift({
      id: conversationId,
      title: newTitle || "New Conversation",
      updated_at: nowIso,
    });
  }
  saveLocalConvos(convos);
}

async function ensureConversationMetaLoaded() {
  if (!HAS_SUPABASE || !conversationId || convMetaLoaded) return;
  try {
    const url = new URL(
      `${SUPABASE_REST}/${encodeURIComponent(CONVERSATIONS_TABLE)}`
    );
    url.searchParams.set("select", "title");
    url.searchParams.set("id", `eq.${conversationId}`);
    url.searchParams.set("limit", "1");
    const resp = await fetch(url, {
      headers: {
        apikey: SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      },
    });
    if (!resp.ok) {
      convMetaLoaded = true;
      return;
    }
    const rows = await resp.json();
    convTitleCached = rows?.[0]?.title || "New Conversation";
    convMetaLoaded = true;
  } catch (e) {
    console.warn("[CALL] ensureConversationMetaLoaded failed:", e);
    convMetaLoaded = true;
  }
}

/**
 * Update conversations.updated_at, and if the thread is still untitled,
 * use the first voice transcript as its title.
 */
async function updateConversationFromCall(transcript) {
  if (!conversationId || !transcript) return;

  const raw = transcript.replace(/\s+/g, " ").trim();
  if (!raw) return;

  const maxLen = 80;
  let candidate = raw;
  if (candidate.length > maxLen) {
    candidate = candidate.slice(0, maxLen - 1).trimEnd() + "…";
  }

  // Always keep local history fresh, even if Supabase is disabled.
  if (!HAS_SUPABASE || !SUPABASE_SERVICE_ROLE_KEY) {
    touchLocalConversationFromCall(candidate);
    return;
  }

  await ensureConversationMetaLoaded();

  const current = (convTitleCached || "").trim();
  let shouldUpdateTitle = false;

  if (!hasAppliedTitleFromCall) {
    if (
      !current ||
      current.toLowerCase() === "new conversation" ||
      current.toLowerCase().startsWith("untitled")
    ) {
      shouldUpdateTitle = true;
    }
  }

  const nowIso = new Date().toISOString();
  const payload = { updated_at: nowIso };
  if (shouldUpdateTitle) payload.title = candidate;

  try {
    const url = new URL(
      `${SUPABASE_REST}/${encodeURIComponent(CONVERSATIONS_TABLE)}`
    );
    url.searchParams.set("id", `eq.${conversationId}`);
    const resp = await fetch(url.toString(), {
      method: "PATCH",
      headers: {
        apikey: SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        "Content-Type": "application/json",
        Prefer: "return=minimal",
      },
      body: JSON.stringify(payload),
    });

    if (!resp.ok) {
      console.warn(
        "[CALL] conversations update failed:",
        resp.status,
        resp.statusText
      );
    } else {
      if (shouldUpdateTitle) {
        convTitleCached = candidate;
        hasAppliedTitleFromCall = true;
      }
      touchLocalConversationFromCall(shouldUpdateTitle ? candidate : null);
    }
  } catch (e) {
    console.warn("[CALL] conversations update error:", e);
  }
}

/* ---------- DOM ---------- */
const callBtn = document.getElementById("call-btn");
const statusText = document.getElementById("status-text");
const voiceRing = document.getElementById("voiceRing");
const micBtn = document.getElementById("mic-btn");
const speakerBtn = document.getElementById("speaker-btn");
const modeBtn = document.getElementById("mode-btn");
const returnLink = document.getElementById("return-thread-link");

// Transcript (call view)
const transcriptList = document.getElementById("transcript-list");
const transcriptInterim = document.getElementById("transcript-interim");

// Chat (created lazily)
let chatPanel = document.getElementById("chat-panel");
let chatLog;
let chatForm;
let chatInput;

/* Wire "Return to this conversation" link */
if (returnLink) {
  if (conversationId) {
    const url = new URL("home.html", window.location.origin);
    url.searchParams.set("c", conversationId);
    returnLink.href = url.toString();
    returnLink.style.display = "inline-flex";
  } else {
    // No thread attached – hide link
    returnLink.style.display = "none";
  }
}

/* ---------- State ---------- */
let isCalling = false;
let isRecording = false;
let isPlayingAI = false;
let inChatView = false;

let globalStream = null;
let mediaRecorder = null;
let recordChunks = [];

/* Native ASR for user live captions */
const HAS_NATIVE_ASR =
  "SpeechRecognition" in window || "webkitSpeechRecognition" in window;
let speechRecognizer = null;

/* Audio routing */
let playbackAC = null;
const managedAudios = new Set();
let preferredOutputDeviceId = null;
let micMuted = false;
let speakerMuted = false;

/* Greeting prefetch state */
let greetingReadyPromise = null;
let greetingAudioUrl = null;

/* Call identity */
let currentCallId = null;

/* ---------- Helpers ---------- */
const log = (...a) => DEBUG && console.log("[SOW]", ...a);
const warn = (...a) => DEBUG && console.warn("[SOW]", ...a);
const trimText = (s, n = 360) => (s || "").trim().slice(0, n);

/* =========================================================
   ✅ iPhone Safari Audio Fix — Shared Audio + Unlock
   ========================================================= */

const IS_IOS =
  /iPad|iPhone|iPod/i.test(navigator.userAgent || "") ||
  (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);

let ttsPlayer = null;
let audioUnlocked = false;

/** Ensure shared audio element exists */
function ensureSharedAudio() {
  if (ttsPlayer) return ttsPlayer;
  ttsPlayer = new Audio();
  ttsPlayer.preload = "auto";
  ttsPlayer.playsInline = true; // important for iOS Safari
  ttsPlayer.crossOrigin = "anonymous";
  registerAudioElement(ttsPlayer);
  return ttsPlayer;
}

/** Unlock audio system — must be called from a user gesture on iOS */
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
      a.volume = speakerMuted ? 0 : 1;
      audioUnlocked = true;
      log("[SOW] Audio unlocked for iOS Safari.");
    } else {
      audioUnlocked = true;
    }
  } catch (e) {
    warn("unlockAudioSystem failed", e);
  }
}

/** Force resume audio context before playing (iOS can suspend after async) */
async function forceResumeAudio() {
  try {
    playbackAC ||= new (window.AudioContext || window.webkitAudioContext)();
    if (playbackAC.state === "suspended") {
      await playbackAC.resume().catch(() => {});
    }
    // Also attempt element play/pause to re-prime in edge cases
    if (IS_IOS) {
      const a = ensureSharedAudio();
      a.muted = true;
      a.volume = 0;
      a.src =
        "data:audio/mp3;base64,//uQxAAAAAAAAAAAAAAAAAAAAAAAWGluZwAAAA8AAAACAAACcQCA" +
        "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
      await a.play().catch(() => {});
      a.pause();
      a.currentTime = 0;
      a.muted = speakerMuted;
      a.volume = speakerMuted ? 0 : 1;
    }
  } catch (e) {
    // ignore
  }
}

/** Shared playback wrapper with retry */
function playViaSharedPlayer(src, { limitMs = 15000, color = "#d4a373", retries = 1 } = {}) {
  return new Promise(async (resolve) => {
    const a = ensureSharedAudio();
    let done = false;
    let attempts = 0;

    const settle = (ok) => {
      if (done) return;
      done = true;
      a.onended = a.onerror = a.onabort = a.oncanplaythrough = null;
      stopRing();
      resolve(ok);
    };

    const attemptPlay = async () => {
      attempts += 1;
      try {
        await forceResumeAudio();
      } catch {}

      try {
        a.pause();
      } catch {}

      a.preload = "auto";
      a.src = src;
      a.muted = speakerMuted;
      a.volume = speakerMuted ? 0 : 1;

      animateRingFromElement(a, color);

      const tryStart = () => {
        try {
          const p = a.play();
          if (p?.catch) {
            p.catch(async () => {
              if (attempts <= retries) {
                await unlockAudioSystem(); // re-unlock under iOS policy
                return attemptPlay();
              }
              settle(false);
            });
          }
        } catch {
          settle(false);
        }
      };

      a.oncanplaythrough = () => tryStart();
      a.onerror = () => settle(false);
      a.onabort = () => settle(false);

      const t = setTimeout(() => settle(false), limitMs);
      a.onended = () => {
        clearTimeout(t);
        settle(true);
      };

      // if already buffered, can play immediately
      if (a.readyState >= 3) tryStart();
    };

    await attemptPlay();
  });
}

/* Small one-shot clips (ring/greeting/others) */
function safePlayOnce(src, { limitMs = 15000, color = "#d4a373" } = {}) {
  return playViaSharedPlayer(src, { limitMs, color, retries: 1 });
}

/* ---------- History / Summary (Supabase via REST, optional) ---------- */
async function fetchLastPairsFromSupabase(user_id, { pairs = 8 } = {}) {
  if (!HAS_SUPABASE) {
    return { text: "", pairs: [] };
  }
  try {
    const uuid = pickUuidForHistory(user_id);
    const url = new URL(
      `${SUPABASE_REST}/${encodeURIComponent(HISTORY_TABLE)}`
    );
    url.searchParams.set("select", HISTORY_SELECT);
    url.searchParams.set(HISTORY_USER_COL, `eq.${uuid}`);
    url.searchParams.set("order", `${HISTORY_TIME_COL}.desc`);
    url.searchParams.set("limit", String(pairs));
    const resp = await fetch(url, {
      headers: {
        apikey: SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        Prefer: "return=representation",
      },
    });
    if (!resp.ok) return { text: "", pairs: [] };
    const rowsDesc = await resp.json();
    const rows = rowsDesc.slice().reverse();
    const lastPairs = rows.map((r) => ({
      user: trimText(r.input_transcript),
      assistant: trimText(r.ai_text),
    }));
    const textBlock = lastPairs
      .map((p) => {
        const u = p.user ? `User: ${p.user}` : "";
        const a = p.assistant ? `Assistant: ${p.assistant}` : "";
        return [u, a].filter(Boolean).join("\n");
      })
      .join("\n\n");
    return { text: textBlock, pairs: lastPairs };
  } catch (e) {
    warn("fetchLastPairsFromSupabase failed", e);
    return { text: "", pairs: [] };
  }
}

async function fetchRollingSummary(user_id, device) {
  if (!HAS_SUPABASE) return "";
  try {
    const uuid = pickUuidForHistory(user_id);
    const url = new URL(
      `${SUPABASE_REST}/${encodeURIComponent(SUMMARY_TABLE)}`
    );
    url.searchParams.set("user_id_uuid", `eq.${uuid}`);
    url.searchParams.set("device_id", `eq.${device}`);
    url.searchParams.set("select", "summary,last_turn_at");
    url.searchParams.set("limit", "1");
    const resp = await fetch(url, {
      headers: {
        apikey: SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      },
    });
    if (!resp.ok) return "";
    const rows = await resp.json();
    return rows?.[0]?.summary || "";
  } catch (e) {
    warn("fetchRollingSummary failed", e);
    return "";
  }
}

async function upsertRollingSummary(user_id, device, summary) {
  if (!HAS_SUPABASE || !summary) return;
  try {
    const uuid = pickUuidForHistory(user_id);
    const body = [
      {
        user_id_uuid: uuid,
        device_id: device,
        summary,
        last_turn_at: new Date().toISOString(),
      },
    ];
    await fetch(`${SUPABASE_REST}/${encodeURIComponent(SUMMARY_TABLE)}`, {
      method: "POST",
      headers: {
        apikey: SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        "Content-Type": "application/json",
        Prefer: "resolution=merge-duplicates",
      },
      body: JSON.stringify(body),
    });
  } catch (e) {
    warn("upsertRollingSummary failed", e);
  }
}

function buildRollingSummary(prevSummary, pairs, newest, maxChars = SUMMARY_MAX_CHARS) {
  const sentences = [];
  if (prevSummary) sentences.push(prevSummary);
  for (const p of pairs.slice(-6)) {
    if (p.user) sentences.push(`User: ${p.user}`);
    if (p.assistant) sentences.push(`Assistant: ${p.assistant}`);
  }
  if (newest) sentences.push(`User now: ${newest}`);

  const scored = sentences
    .map((s) => {
      const t = s.trim().replace(/\s+/g, " ");
      let score = 0;
      if (/[0-9]/.test(t)) score += 1;
      if (/(goal|need|want|plan|decide|next|todo|fix|issue)/i.test(t)) score += 2;
      if (t.length >= 40 && t.length <= 160) score += 1;
      if (/^User now:/i.test(t)) score += 3;
      return { t, score };
    })
    .sort((a, b) => b.score - a.score);

  const out = [];
  let used = 0;
  for (const { t } of scored) {
    if (!t) continue;
    if (used + t.length + 1 > maxChars) continue;
    if (out.some((x) => x.includes(t) || t.includes(x))) continue;
    out.push(t);
    used += t.length + 1;
    if (used >= maxChars - 24) break;
  }
  const summary = out.join(" ").trim();
  return summary.length ? summary : sentences.join(" ").slice(-maxChars);
}

/* ---------- UI: Chat ---------- */
function ensureChatUI() {
  if (!chatPanel) {
    chatPanel = document.createElement("div");
    chatPanel.id = "chat-panel";
    chatPanel.innerHTML = `
      <div id="chat-log" class="chat-log"></div>
      <form id="chat-form" class="chat-input-row">
        <input id="chat-input" type="text" placeholder="Type a message..." autocomplete="off" />
        <button type="submit">Send</button>
      </form>
    `;
    chatPanel.style.display = "none";
    const anchor =
      document.getElementById("transcript") ||
      document.getElementById("avatar-container") ||
      document.body;
    anchor.insertAdjacentElement("afterend", chatPanel);
  }
  chatLog = chatLog || document.getElementById("chat-log");
  chatForm = chatForm || document.getElementById("chat-form");
  chatInput = chatInput || document.getElementById("chat-input");

  if (chatForm && !chatForm._wired) {
    chatForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      const txt = (chatInput?.value || "").trim();
      if (!txt) return;
      chatInput.value = "";
      showChatView();
      appendMsg("me", txt);
      await sendChatToCoach(txt);
    });
    chatForm._wired = true;
  }
}
ensureChatUI();

function showChatView() {
  inChatView = true;
  if (chatPanel) chatPanel.style.display = "block";
  statusText.textContent = "Chat view on. Call continues in background.";
  updateModeBtnUI();
}

function showCallView() {
  inChatView = false;
  if (chatPanel) chatPanel.style.display = "none";
  statusText.textContent = isCalling
    ? "Call view on."
    : "Tap the blue call button to begin.";
  updateModeBtnUI();
}

function appendMsg(role, text, { id, typing = false } = {}) {
  if (!chatLog) return null;
  const row = document.createElement("div");
  row.className = `msg ${role}${typing ? " typing" : ""}`;
  if (id) row.dataset.id = id;
  const bubble = document.createElement("div");
  bubble.className = "msg-bubble";
  bubble.textContent = text || "";
  row.appendChild(bubble);
  chatLog.appendChild(row);
  chatLog.scrollTop = chatLog.scrollHeight;
  return bubble;
}

async function typewriter(el, full, delay = 24) {
  if (!el) return;
  el.textContent = "";
  for (let i = 0; i < full.length; i++) {
    el.textContent += full[i];
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => setTimeout(r, delay));
  }
}

/* transcript list helpers (call view) */
let lastFinalLine = "";
const transcriptUI = {
  clearAll() {
    transcriptInterim.textContent = "";
    transcriptList.innerHTML = "";
    lastFinalLine = "";
  },
  setInterim(t) {
    transcriptInterim.textContent = t || "";
  },
  addFinalLine(t) {
    const s = (t || "").trim();
    if (!s || s === lastFinalLine) return;
    lastFinalLine = s;
    const div = document.createElement("div");
    div.className = "transcript-line";
    div.textContent = s;
    transcriptList.appendChild(div);
    transcriptList.scrollTop = transcriptList.scrollHeight;
  },
};

/* ---------- Canvas ring ---------- */
(function setupCanvas() {
  if (!voiceRing) return;
  const dpr = window.devicePixelRatio || 1;
  const size = 220;
  voiceRing.width = size * dpr;
  voiceRing.height = size * dpr;
  voiceRing.style.width = `${size}px`;
  voiceRing.style.height = `${size}px`;
  voiceRing.getContext("2d").scale(dpr, dpr);
  drawVoiceRing();
})();

function drawVoiceRing(th = 9, color = "#d4a373") {
  const ctx = voiceRing.getContext("2d");
  const dpr = window.devicePixelRatio || 1;
  const w = voiceRing.width / dpr;
  const h = voiceRing.height / dpr;
  ctx.clearRect(0, 0, w, h);
  ctx.beginPath();
  ctx.arc(w / 2, h / 2, 85, 0, Math.PI * 2);
  ctx.lineWidth = th;
  ctx.strokeStyle = color;
  ctx.shadowBlur = 15;
  ctx.shadowColor = `${color}99`;
  ctx.stroke();
}

let ringCtx = null;
let ringAnalyser = null;
let ringRAF = null;

function stopRing() {
  if (ringRAF) cancelAnimationFrame(ringRAF);
  ringRAF = null;
  try {
    ringAnalyser?.disconnect();
  } catch (e) {
    // ignore
  }
  if (ringCtx && ringCtx.state !== "closed") {
    try {
      ringCtx.close();
    } catch (e) {
      // ignore
    }
  }
  ringCtx = ringAnalyser = null;
  drawVoiceRing();
}

function animateRingFromElement(mediaEl, color = "#d4a373") {
  playbackAC ||= new (window.AudioContext || window.webkitAudioContext)();
  if (playbackAC.state === "suspended") playbackAC.resume().catch(() => {});
  let src = null;
  let analyser = null;
  let gain = null;
  let rafId = null;

  const start = () => {
    stop();
    try {
      src = playbackAC.createMediaElementSource(mediaEl);
    } catch (e) {
      return;
    }
    gain = playbackAC.createGain();
    analyser = playbackAC.createAnalyser();
    analyser.fftSize = 1024;
    analyser.smoothingTimeConstant = 0.7;
    try {
      src.connect(gain);
      gain.connect(analyser);
      analyser.connect(playbackAC.destination);
    } catch (e) {
      return;
    }
    const data = new Uint8Array(analyser.fftSize);
    const loop = () => {
      analyser.getByteTimeDomainData(data);
      let sum = 0;
      for (let i = 0; i < data.length; i++) {
        const v = data[i] - 128;
        sum += v * v;
      }
      const rms = Math.sqrt(sum / data.length);
      const th = 10 + Math.min(rms * 1.0, 34);
      drawVoiceRing(th, color);
      rafId = requestAnimationFrame(loop);
    };
    rafId = requestAnimationFrame(loop);
  };

  const stop = () => {
    if (rafId) cancelAnimationFrame(rafId);
    rafId = null;
    try {
      analyser?.disconnect();
      gain?.disconnect();
      src?.disconnect();
    } catch (e) {
      // ignore
    }
    drawVoiceRing();
  };

  mediaEl.addEventListener("playing", start, { once: true });
  mediaEl.addEventListener("pause", stop, { once: true });
  mediaEl.addEventListener("ended", stop, { once: true });

  if (!mediaEl.paused && !mediaEl.ended) start();
}

/* ---------- VAD (endless recording; stop after silence) ---------- */
const VAD = {
  SILENCE_THRESHOLD: 5,
  SILENCE_TIMEOUT_MS: 3000,
  GRACE_MS: 900,
  MIN_RECORD_MS: 700,
};

let vadCtx = null;
let vadAnalyser = null;
let vadSource = null;
let vadRAF = null;
let silenceMs = 0;

function startMicVAD(stream, color = "#d4a373") {
  vadCtx = new (window.AudioContext || window.webkitAudioContext)();
  if (vadCtx.state === "suspended") vadCtx.resume().catch(() => {});
  vadSource = vadCtx.createMediaStreamSource(stream);
  vadAnalyser = vadCtx.createAnalyser();
  vadAnalyser.fftSize = 2048;
  vadAnalyser.smoothingTimeConstant = 0.75;
  vadSource.connect(vadAnalyser);
  ringCtx = vadCtx;
  ringAnalyser = vadAnalyser;

  const data = new Uint8Array(vadAnalyser.fftSize);
  const startedAt = performance.now();
  let last = performance.now();
  silenceMs = 0;

  const animate = () => {
    vadAnalyser.getByteTimeDomainData(data);
    let sum = 0;
    for (let i = 0; i < data.length; i++) sum += Math.abs(data[i] - 128);
    const level = sum / data.length;
    const now = performance.now();
    const dt = now - last;
    last = now;
    const elapsed = now - startedAt;
    const graceOver = elapsed > VAD.GRACE_MS;
    const minLen = elapsed > VAD.MIN_RECORD_MS;

    let acc = 0;
    for (let i = 0; i < data.length; i++) {
      const v = data[i] - 128;
      acc += v * v;
    }
    const rms = Math.sqrt(acc / data.length);
    const th = 10 + Math.min(rms * 0.9, 32);
    drawVoiceRing(th, color);

    if (graceOver) {
      if (level < VAD.SILENCE_THRESHOLD) {
        silenceMs += dt;
        if (
          silenceMs >= VAD.SILENCE_TIMEOUT_MS &&
          minLen &&
          mediaRecorder?.state === "recording"
        ) {
          mediaRecorder.stop();
        }
      } else {
        silenceMs = 0;
      }
    }

    vadRAF = requestAnimationFrame(animate);
  };

  vadRAF = requestAnimationFrame(animate);
}

function stopMicVAD() {
  if (vadRAF) cancelAnimationFrame(vadRAF);
  vadRAF = null;
  try {
    vadSource?.disconnect();
    vadAnalyser?.disconnect();
  } catch (e) {
    // ignore
  }
  if (vadCtx && vadCtx.state !== "closed") {
    try {
      vadCtx.close();
    } catch (e) {
      // ignore
    }
  }
  vadCtx = vadAnalyser = vadSource = null;
}

/* ---------- Audio I/O helpers ---------- */
function registerAudioElement(a) {
  managedAudios.add(a);
  a.addEventListener("ended", () => managedAudios.delete(a));
  a.muted = speakerMuted;
  a.volume = speakerMuted ? 0 : 1;
  routeElementToPreferredOutput(a).catch(() => {});
}

async function routeElementToPreferredOutput(el) {
  if (!("setSinkId" in HTMLMediaElement.prototype)) return;
  if (!preferredOutputDeviceId) return;
  try {
    await el.setSinkId(preferredOutputDeviceId);
  } catch (e) {}
}

async function pickSpeakerOutputDevice() {
  if (!navigator.mediaDevices?.enumerateDevices) return null;
  try {
    const outs = (await navigator.mediaDevices.enumerateDevices()).filter(
      (d) => d.kind === "audiooutput"
    );
    if (!outs.length) return null;
    const speakerish = outs.find((d) => /speaker/i.test(d.label));
    return speakerish?.deviceId || outs.at(-1).deviceId;
  } catch (e) {
    return null;
  }
}

function updateMicTracks() {
  if (globalStream)
    globalStream.getAudioTracks().forEach((t) => {
      t.enabled = !micMuted;
    });
}

function updateSpeakerUI() {
  speakerBtn?.setAttribute("aria-pressed", String(!speakerMuted));
}

function updateMicUI() {
  micBtn?.setAttribute("aria-pressed", String(micMuted));
}

function updateModeBtnUI() {
  if (modeBtn) {
    modeBtn.setAttribute("aria-pressed", String(inChatView));
    modeBtn.title = inChatView ? "Switch to Call view" : "Switch to Chat view";
  }
}

/* ---------- Controls ---------- */
callBtn?.addEventListener("click", async () => {
  await unlockAudioSystem();
  if (!isCalling) startCall();
  else endCall();
});

micBtn?.addEventListener("click", () => {
  micMuted = !micMuted;
  updateMicTracks();
  updateMicUI();
  statusText.textContent = micMuted ? "Mic muted." : "Mic unmuted.";
});

speakerBtn?.addEventListener("click", async () => {
  const wasMuted = speakerMuted;
  speakerMuted = !speakerMuted;
  for (const el of managedAudios) {
    el.muted = speakerMuted;
    el.volume = speakerMuted ? 0 : 1;
  }
  updateSpeakerUI();
  if (wasMuted && !speakerMuted && "setSinkId" in HTMLMediaElement.prototype) {
    if (!preferredOutputDeviceId)
      preferredOutputDeviceId = await pickSpeakerOutputDevice();
    if (preferredOutputDeviceId) {
      for (const el of managedAudios) await routeElementToPreferredOutput(el);
      statusText.textContent = "Speaker output active.";
    }
  }
});

modeBtn?.addEventListener("click", () => {
  inChatView ? showCallView() : showChatView();
});

document.addEventListener("keydown", (e) => {
  if (e.key?.toLowerCase?.() === "c") {
    inChatView ? showCallView() : showChatView();
  }
});

/* ---------- Greeting prefetch ---------- */
async function prepareGreetingForNextCall() {
  greetingReadyPromise = (async () => {
    try {
      const user_id = getUserIdForWebhook();
      const device = getOrCreateDeviceId();
      const payload = { user_id, device_id: device };

      const resp = await fetch(GREETING_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      if (!resp.ok) throw new Error(`Greeting HTTP ${resp.status}`);
      const blob = await resp.blob();
      if (!blob.size) throw new Error("Empty greeting audio blob");

      if (greetingAudioUrl) {
        try {
          URL.revokeObjectURL(greetingAudioUrl);
        } catch {}
      }

      greetingAudioUrl = URL.createObjectURL(blob);
      log("[SOW] Greeting audio prefetched.");
      return true;
    } catch (e) {
      warn("Greeting prefetch failed", e);
      greetingAudioUrl = null;
      return false;
    }
  })();
}

/* ---------- Call flow ---------- */
async function startCall() {
  if (isCalling) return;
  isCalling = true;
  currentCallId = crypto.randomUUID?.() || `${Date.now()}_${Math.random()}`;

  callBtn.classList.add("call-active");
  transcriptUI.clearAll();
  showCallView();

  try {
    statusText.textContent = "Ringing…";
    await safePlayOnce("ring.mp3", { limitMs: 15000 });
    if (!isCalling) return;

    if (!greetingReadyPromise) prepareGreetingForNextCall();
    const greetingOk = await greetingReadyPromise;
    greetingReadyPromise = null;

    if (!isCalling) return;

    statusText.textContent = "AI greeting you…";
    if (greetingOk && greetingAudioUrl) {
      await safePlayOnce(greetingAudioUrl, { limitMs: 60000 });
      try {
        URL.revokeObjectURL(greetingAudioUrl);
      } catch {}
      greetingAudioUrl = null;
    } else {
      await safePlayOnce("blake.mp3", { limitMs: 15000 });
    }

    if (!isCalling) return;

    prepareGreetingForNextCall();

    await startRecordingLoop();
  } catch (e) {
    warn("startCall error", e);
    statusText.textContent = "Audio blocked or missing. Tap again.";
  }
}

function endCall() {
  isCalling = false;
  isRecording = false;
  isPlayingAI = false;

  callBtn.classList.remove("call-active");
  statusText.textContent = "Call ended.";

  stopMicVAD();
  stopRing();
  stopBargeInMonitor();

  try {
    globalStream?.getTracks().forEach((t) => t.stop());
  } catch {}

  globalStream = null;

  try {
    if (mediaRecorder && mediaRecorder.state !== "inactive") mediaRecorder.stop();
  } catch {}

  closeNativeRecognizer();

  for (const el of Array.from(managedAudios)) {
    try {
      el.pause();
      const src = el.src;
      el.src = "";
      if (src?.startsWith("blob:")) URL.revokeObjectURL(src);
    } catch {}
    managedAudios.delete(el);
  }
}

/* ---------- Continuous capture loop ---------- */
async function startRecordingLoop() {
  while (isCalling) {
    const ok = await captureOneTurn();
    if (!isCalling) break;
    if (!ok) continue;
    const played = await uploadRecordingAndNotify();
    if (!isCalling) break;
    statusText.textContent = played ? "Your turn…" : "Listening again…";
  }
}

/* ---------- One turn capture ---------- */
let interimBuffer = "";
let finalSegments = [];

function commitInterimToFinal() {
  const t = (interimBuffer || "").trim();
  if (t) {
    interimBuffer = "";
    transcriptUI.setInterim("");
    transcriptUI.addFinalLine(t);
    finalSegments.push(t);
  }
}

function openNativeRecognizer() {
  const ASR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!ASR) {
    transcriptUI.setInterim("Listening…");
    return;
  }

  const r = new ASR();
  r.lang = "en-US";
  r.continuous = true;
  r.interimResults = true;
  r.maxAlternatives = 1;

  r.onresult = (e) => {
    let interim = "";
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const res = e.results[i];
      const txt = (res[0]?.transcript || "").trim();
      if (!txt) continue;

      if (res.isFinal) {
        transcriptUI.addFinalLine(txt);
        finalSegments.push(txt);
        interimBuffer = "";
      } else {
        interim += (interim ? " " : "") + txt;
      }
    }
    transcriptUI.setInterim(interim);
    interimBuffer = interim;
  };

  r.onerror = (e) => {
    warn("ASR error:", e);
    if (e.error === "not-allowed" || e.error === "service-not-allowed") {
      closeNativeRecognizer();
    }
  };

  r.onend = () => {
    if (isCalling && isRecording) {
      try {
        r.start();
      } catch {}
    }
  };

  try {
    r.start();
  } catch {}

  speechRecognizer = r;
}

function closeNativeRecognizer() {
  try {
    if (speechRecognizer) {
      const r = speechRecognizer;
      speechRecognizer = null;
      r.onend = null;
      r.stop();
    }
  } catch {}
}

async function captureOneTurn() {
  if (!isCalling || isRecording || isPlayingAI) return false;

  finalSegments = [];
  interimBuffer = "";
  transcriptUI.setInterim("Listening…");

  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });

    if (!isCalling) {
      stream.getTracks().forEach((t) => t.stop());
      return false;
    }

    globalStream = stream;

    let opts = {};
    if (MediaRecorder.isTypeSupported("audio/webm;codecs=opus")) {
      opts.mimeType = "audio/webm;codecs=opus";
      if (ENABLE_MEDIARECORDER_64KBPS) opts.audioBitsPerSecond = 64_000;
    } else if (MediaRecorder.isTypeSupported("audio/webm")) {
      opts.mimeType = "audio/webm";
      if (ENABLE_MEDIARECORDER_64KBPS) opts.audioBitsPerSecond = 64_000;
    }

    try {
      mediaRecorder = new MediaRecorder(stream, opts);
    } catch (e) {
      mediaRecorder = new MediaRecorder(stream);
    }

    recordChunks = [];
    isRecording = true;

    mediaRecorder.ondataavailable = (e) => {
      if (e.data?.size > 0) {
        recordChunks.push(e.data);
        HumeRealtime.handleRecorderChunk?.(e.data);
      }
    };

    mediaRecorder.onstop = () => {
      commitInterimToFinal();
      isRecording = false;
      stopMicVAD();
      stopRing();
      transcriptUI.setInterim("");
      closeNativeRecognizer();
      HumeRealtime.stopTurn?.();
    };

    startMicVAD(stream, "#d4a373");
    openNativeRecognizer();
    HumeRealtime.startTurn?.(stream, vadCtx);

    mediaRecorder.start(TIMESLICE_MS);

    await new Promise((res) => {
      const wait = () => {
        if (!isRecording) return res(true);
        requestAnimationFrame(wait);
      };
      wait();
    });

    return true;
  } catch (e) {
    warn("captureOneTurn error", e);
    statusText.textContent = "Mic permission or codec not supported.";
    endCall();
    return false;
  }
}

/* ---------- BARGE-IN (interrupt during AI playback) ---------- */
const BARGE = {
  enable: true,
  rmsThresh: 8,
  holdMs: 120,
  cooldownMs: 400,
};

let bargeCtx = null;
let bargeSrc = null;
let bargeAnalyser = null;
let bargeRAF = null;
let bargeArmed = false;
let bargeSinceArm = 0;

async function ensureLiveMicForBargeIn() {
  try {
    if (
      globalStream &&
      globalStream.getAudioTracks().some((t) => t.readyState === "live")
    ) {
      globalStream.getAudioTracks().forEach((t) => {
        if (t.enabled === false) t.enabled = true;
      });
      return true;
    }

    const s = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });

    globalStream = s;
    updateMicTracks();
    return true;
  } catch (e) {
    warn("barge-in mic error", e);
    return false;
  }
}

function startBargeInMonitor(onInterrupt) {
  stopBargeInMonitor();
  if (!BARGE.enable || !globalStream) return;

  bargeCtx = new (window.AudioContext || window.webkitAudioContext)();
  if (bargeCtx.state === "suspended") bargeCtx.resume().catch(() => {});
  bargeSrc = bargeCtx.createMediaStreamSource(globalStream);
  bargeAnalyser = bargeCtx.createAnalyser();
  bargeAnalyser.fftSize = 1024;
  bargeAnalyser.smoothingTimeConstant = 0.8;
  bargeSrc.connect(bargeAnalyser);

  bargeArmed = false;
  bargeSinceArm = 0;

  const data = new Uint8Array(bargeAnalyser.fftSize);
  let hold = 0;

  const loop = () => {
    if (!bargeAnalyser) return;
    bargeAnalyser.getByteTimeDomainData(data);

    let sum = 0;
    for (let i = 0; i < data.length; i++) {
      const v = data[i] - 128;
      sum += v * v;
    }
    const rms = Math.sqrt(sum / data.length);

    if (!bargeArmed) {
      bargeSinceArm += 16;
      if (bargeSinceArm >= BARGE.cooldownMs) bargeArmed = true;
    } else {
      if (rms > BARGE.rmsThresh) {
        hold += 16;
        if (hold >= BARGE.holdMs) {
          try {
            onInterrupt?.();
          } catch {}
          stopBargeInMonitor();
          return;
        }
      } else {
        hold = 0;
      }
    }

    bargeRAF = requestAnimationFrame(loop);
  };

  bargeRAF = requestAnimationFrame(loop);
}

function stopBargeInMonitor() {
  if (bargeRAF) cancelAnimationFrame(bargeRAF);
  bargeRAF = null;

  try {
    bargeSrc?.disconnect();
    bargeAnalyser?.disconnect();
  } catch {}

  if (bargeCtx && bargeCtx.state !== "closed") {
    try {
      bargeCtx.close();
    } catch {}
  }

  bargeCtx = bargeSrc = bargeAnalyser = null;
}

/* Unified AI playback that supports barge-in */
async function playAIWithBargeIn(playableUrl, { aiBlob = null, aiBubbleEl = null } = {}) {
  return new Promise(async (resolve) => {
    statusText.textContent = "AI replying…";
    isPlayingAI = true;

    const a = ensureSharedAudio();
    a.preload = "auto";
    a.playsInline = true;
    a.muted = speakerMuted;
    a.volume = speakerMuted ? 0 : 1;
    a.src = playableUrl;

    if (!aiBubbleEl && inChatView) aiBubbleEl = appendMsg("ai", "", { typing: true });

    const okMic = await ensureLiveMicForBargeIn();
    let interrupted = false;

    const cleanup = () => {
      stopRing();
      stopBargeInMonitor();
      isPlayingAI = false;
      resolve({ interrupted });
    };

    animateRingFromElement(a, "#d4a373");

    if (okMic) {
      startBargeInMonitor(() => {
        interrupted = true;
        try {
          a.pause();
        } catch {}
        statusText.textContent = "Go ahead…";
        cleanup();
      });
    }

    try {
      await forceResumeAudio();
      const p = a.play();
      if (p?.catch) p.catch(() => cleanup());
    } catch {
      cleanup();
    }

    a.onended = () => cleanup();
    a.onerror = () => cleanup();
  });
}

/* ---------- Voice path: upload → Supabase (optional) → coach function ---------- */
const RECENT_USER_KEEP = 12;
let recentUserTurns = [];

function base64ToBlobUrl(base64, mime = "audio/mpeg") {
  if (!base64) return { url: null, blob: null };
  const raw = base64.includes(",") ? base64.split(",").pop() : base64;
  const bytes = Uint8Array.from(atob(raw), (c) => c.charCodeAt(0));
  const blob = new Blob([bytes], { type: mime || "audio/mpeg" });
  const url = URL.createObjectURL(blob);
  return { url, blob };
}

async function uploadRecordingAndNotify() {
  if (!isCalling) return false;

  const finalText = finalSegments.join(" ").trim();
  const interimText = (interimBuffer || "").trim();
  const combinedTranscript = finalText || interimText || "";

  if (combinedTranscript) {
    recentUserTurns.push(combinedTranscript);
    if (recentUserTurns.length > RECENT_USER_KEEP) {
      recentUserTurns.splice(0, recentUserTurns.length - RECENT_USER_KEEP);
    }
  }

  const user_id = getUserIdForWebhook();
  const device = getOrCreateDeviceId();
  const call_id = currentCallId || (currentCallId = crypto.randomUUID?.() || `${Date.now()}_${Math.random()}`);
  const mimeType = mediaRecorder?.mimeType || "audio/webm";
  const blob = new Blob(recordChunks, { type: mimeType });

  if (!blob.size || !isCalling) {
    statusText.textContent = "No audio captured.";
    return false;
  }

  statusText.textContent = "Thinking…";

  updateConversationFromCall(combinedTranscript).catch(() => {});

  // history/summary
  let historyPairsText = "";
  let historyPairs = [];
  try {
    const hist = await fetchLastPairsFromSupabase(user_id, { pairs: 8 });
    historyPairsText = hist.text || "";
    historyPairs = hist.pairs || [];
  } catch {}

  const prevSummary = await fetchRollingSummary(user_id, device);
  const rollingSummary = buildRollingSummary(prevSummary, historyPairs, combinedTranscript);

  const transcriptForModel = historyPairsText
    ? `Previous conversation (last ${Math.min(historyPairs.length, 8)} pairs), oldest→newest:\n${historyPairsText}\n\nUser now says:\n${combinedTranscript}`
    : combinedTranscript;

  // upload to storage (OPTIONAL)
  let uploaded = false;
  if (HAS_SUPABASE) {
    try {
      const ext = mimeType.includes("mp4") ? "m4a" : "webm";
      const filePath = `${RECORDINGS_FOLDER}/${device}/${Date.now()}.${ext}`;
      const uploadUrl = `${SUPABASE_URL}/storage/v1/object/${encodeURIComponent(SUPABASE_BUCKET)}/${filePath}`;
      const upRes = await fetch(uploadUrl, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
          "Content-Type": blob.type || "application/octet-stream",
          "x-upsert": "false",
        },
        body: blob,
      });
      uploaded = upRes.ok;
      if (!upRes.ok) warn("Supabase upload failed", upRes.status);
    } catch (e) {
      warn("Supabase upload error", e);
    }
  }

  // ✅ call coach function (JSON response)
  let aiText = "";
  let aiPlayableUrl = null;
  let revokeLater = null;
  let aiBlob = null;

  try {
    const payload = {
      user_id,
      device_id: device,
      call_id,
      source: "voice",
      transcript: transcriptForModel,
      utterance: combinedTranscript,
      rolling_summary: rollingSummary || "",
      audio_uploaded: uploaded,
      conversationId: conversationId || null,
    };

    const resp = await fetch(WORKFLOW_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    if (!resp.ok) {
      const txt = await resp.text().catch(() => "");
      warn("coach endpoint failed", resp.status, txt);
      statusText.textContent = "AI processing failed.";
      return false;
    }

    const data = await resp.json().catch(() => null);
    aiText = data?.text || data?.assistant_text || "";

    if (data?.audio_base64) {
      const { url, blob: b } = base64ToBlobUrl(data.audio_base64, data?.mime || "audio/mpeg");
      aiPlayableUrl = url;
      aiBlob = b;
      revokeLater = url;
    }
  } catch (e) {
    warn("coach fetch failed", e);
    statusText.textContent = "AI processing failed.";
    return false;
  }

  if (!isCalling) return false;
  if (!aiPlayableUrl) {
    statusText.textContent = "AI processing failed (no audio).";
    return false;
  }

  // If chat view is open, show text reply too
  let aiBubble = null;
  if (inChatView) {
    aiBubble = appendMsg("ai", "", { typing: true });
    if (aiText) await typewriter(aiBubble, aiText, 18);
  }

  const { interrupted } = await playAIWithBargeIn(aiPlayableUrl, {
    aiBlob,
    aiBubbleEl: aiBubble,
  });

  if (revokeLater) {
    try {
      URL.revokeObjectURL(revokeLater);
    } catch {}
  }

  upsertRollingSummary(user_id, device, rollingSummary).catch(() => {});
  return !interrupted || true;
}

/* ---------- Chat path (text → coach function) ---------- */
async function sendChatToCoach(userText) {
  const user_id = getUserIdForWebhook();
  const device = getOrCreateDeviceId();
  const call_id = currentCallId || (currentCallId = crypto.randomUUID?.() || `${Date.now()}_${Math.random()}`);

  recentUserTurns.push(userText);
  if (recentUserTurns.length > RECENT_USER_KEEP) {
    recentUserTurns.splice(0, recentUserTurns.length - RECENT_USER_KEEP);
  }

  let historyPairsText = "";
  let historyPairs = [];
  try {
    const hist = await fetchLastPairsFromSupabase(user_id, { pairs: 8 });
    historyPairsText = hist.text || "";
    historyPairs = hist.pairs || [];
  } catch {}

  const prevSummary = await fetchRollingSummary(user_id, device);
  const rollingSummary = buildRollingSummary(prevSummary, historyPairs, userText);

  const transcriptForModel = historyPairsText
    ? `Previous conversation (last ${Math.min(historyPairs.length, 8)} pairs), oldest→newest:\n${historyPairsText}\n\nUser now says:\n${userText}`
    : userText;

  try {
    const payload = {
      user_id,
      device_id: device,
      call_id,
      source: "chat",
      transcript: transcriptForModel,
      utterance: userText,
      rolling_summary: rollingSummary || "",
      conversationId: conversationId || null,
    };

    const resp = await fetch(WORKFLOW_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    if (!resp.ok) {
      const txt = await resp.text().catch(() => "");
      warn("chat coach failed", resp.status, txt);
      appendMsg("ai", "Sorry, I couldn’t send that just now.");
      return;
    }

    const data = await resp.json().catch(() => null);
    const aiText = data?.text || data?.assistant_text || "";
    const aiBubble = appendMsg("ai", "", { typing: true });
    if (aiText) await typewriter(aiBubble, aiText, 18);

    if (data?.audio_base64) {
      const { url, blob } = base64ToBlobUrl(data.audio_base64, data?.mime || "audio/mpeg");
      await playAIWithBargeIn(url, { aiBlob: blob, aiBubbleEl: aiBubble });
      try { URL.revokeObjectURL(url); } catch {}
    }

    upsertRollingSummary(user_id, device, rollingSummary).catch(() => {});
  } catch (e) {
    warn("chat error", e);
    appendMsg("ai", "Sorry, I couldn’t send that just now.");
  }
}

/* ---------- Boot ---------- */
updateMicUI();
updateSpeakerUI();
updateModeBtnUI();
showCallView();
prepareGreetingForNextCall();
ensureSharedAudio();
log("[SOW] call.js ready (Netlify coach + hardened iOS Safari audio)");
