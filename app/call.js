// app/call.js
// Son of Wisdom — Call mode
// UPDATED: idle-detection + system_event calls + transcript iframe handshake
// - If user doesn't respond after AI finishes:
//   1) Blake sends a nudge (system_event: no_response_nudge)
//   2) Then Blake sends an ending line (system_event: no_response_end) and call ends
//
// Assumes your netlify/functions/call-coach.js supports:
//  - system_event: "no_response_nudge" | "no_response_end"
//  - returns JSON with assistant_text + audio_base64 (+ mime)

import { supabase } from "./supabase.js";

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

// REST (history/summary)
const SUPABASE_REST = `${SUPABASE_URL}/rest/v1`;
const HISTORY_TABLE = "call_sessions";
const HISTORY_USER_COL = "user_id_uuid";
const HISTORY_SELECT = "input_transcript,ai_text,timestamp";
const HISTORY_TIME_COL = "timestamp";

const SUMMARY_TABLE = "history_summaries";
const SUMMARY_MAX_CHARS = 380;

/* ---------- n8n webhooks / Netlify endpoints ---------- */
/** Text chat logic still uses n8n for now. */
const N8N_WEBHOOK_URL =
  "https://jsonofwisdom.app.n8n.cloud/webhook/4877ebea-544b-42b4-96d6-df41c58d48b0";

/* Optional: AI-transcript webhook (leave empty to disable) */
const N8N_TRANSCRIBE_URL = "";

/** Local hard-coded replacement for n8n voice workflow */
const CALL_COACH_ENDPOINT = "/.netlify/functions/call-coach";

/* ---------- Netlify / ElevenLabs greeting ---------- */
const GREETING_ENDPOINT = "/.netlify/functions/call-greeting";

/* ---------- I/O settings ---------- */
const ENABLE_MEDIARECORDER_64KBPS = true;
const TIMESLICE_MS = 100;
const ENABLE_STREAMED_PLAYBACK = true;

/* ---------- USER / DEVICE ---------- */
const USER_ID_KEY = "sow_user_id";
const DEVICE_ID_KEY = "sow_device_id";
const SENTINEL_UUID = "00000000-0000-0000-0000-000000000000";

/** the current call session id (used for transcript mode) */
let currentCallId = null;

const isUuid = (v) =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    v || ""
  );

/* ---------- Conversation thread (from ?c=...) ---------- */
const urlParams = new URLSearchParams(window.location.search);
const conversationId = urlParams.get("c") || null;
let conversationTitleLocked = false; // once we set title successfully, we stop trying

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

/* ---------- DOM ---------- */
const callBtn = document.getElementById("call-btn");
const statusText = document.getElementById("status-text");
const callTimerEl = document.getElementById("call-timer");
const voiceRing = document.getElementById("voiceRing");
const micBtn = document.getElementById("mic-btn");
const speakerBtn = document.getElementById("speaker-btn");
const modeBtn = document.getElementById("mode-btn");
const threadLink =
  document.getElementById("thread-link") ||
  document.getElementById("btn-thread");

// Transcript (call view)
const transcriptList = document.getElementById("transcript-list");
const transcriptInterim = document.getElementById("transcript-interim");

/* 🔵 Live transcript panel iframe (right-hand side) */
const transcriptFrame =
  document.querySelector(".call-side-transcript iframe") || null;

// Chat (created lazily, but Switch-to-Chat now navigates to home.html)
let chatPanel = document.getElementById("chat-panel");
let chatLog;
let chatForm;
let chatInput;

/* ---------- State ---------- */
let isCalling = false;
let isRecording = false;
let isPlayingAI = false;
let inChatView = false; // no longer toggled by mode button, but kept for compatibility

let callStartedAt = null;
let callTimerInterval = null;

let globalStream = null;
let mediaRecorder = null;
let recordChunks = [];

/* Native ASR for user live captions */
const HAS_NATIVE_ASR =
  "SpeechRecognition" in window || "webkitSpeechRecognition" in window;
let speechRecognizer = null;

if (!HAS_NATIVE_ASR) {
  // Helpful warning on platforms without Web Speech (most mobile browsers)
  console.warn(
    "[SOW] Native speech recognition not available; call-mode live transcript will not work on this device."
  );
}

/* Audio routing */
let playbackAC = null;
const managedAudios = new Set();
let preferredOutputDeviceId = null;
let micMuted = false;
let speakerMuted = false;

/* Greeting prefetch state */
let greetingReadyPromise = null;
let greetingPayload = null; // { text/assistant_text, audio_base64, mime }
let greetingAudioUrl = null;

/* ---------- NEW: Idle detection (no response) ---------- */
const NO_RESPONSE = {
  // after AI finishes speaking, wait this long for user to speak
  FIRST_NUDGE_MS: 20_000, // 20 seconds
  // after the nudge is spoken, wait this long for user to speak
  END_CALL_MS: 20_000, // 20 seconds
  // minimum time after AI speech before any idle logic can run
  ARM_DELAY_MS: 600,
};

let idleArmed = false;
let idleStep = 0; // 0=none, 1=nudged
let idleTimer1 = null;
let idleTimer2 = null;
let lastUserActivityAt = Date.now(); // updated on speech/interim/final and when capture starts
let lastAIFinishedAt = 0; // set when AI audio finishes (or is interrupted)
let idleInFlight = false;

/* ---------- Helpers ---------- */
const log = (...a) => DEBUG && console.log("[SOW]", ...a);
const warn = (...a) => DEBUG && console.warn("[SOW]", ...a);
const trimText = (s, n = 360) => (s || "").trim().slice(0, n);

// Call duration timer helpers
function resetCallTimer() {
  // Full reset: used on page load and before a *new* call
  callStartedAt = null;
  if (callTimerInterval) {
    clearInterval(callTimerInterval);
    callTimerInterval = null;
  }
  if (callTimerEl) {
    callTimerEl.textContent = "00:00";
  }
}

function stopCallTimer() {
  // Stop ticking but keep whatever time is currently shown
  if (callTimerInterval) {
    clearInterval(callTimerInterval);
    callTimerInterval = null;
  }
}

function updateCallTimer() {
  if (!callTimerEl || !callStartedAt) return;
  const elapsedSec = Math.floor((Date.now() - callStartedAt) / 1000);
  const mins = Math.floor(elapsedSec / 60);
  const secs = elapsedSec % 60;
  const mm = String(mins).padStart(2, "0");
  const ss = String(secs).padStart(2, "0");
  callTimerEl.textContent = `${mm}:${ss}`;
}

function startCallTimer() {
  // New call: reset to 00:00 and start counting
  resetCallTimer();
  callStartedAt = Date.now();
  updateCallTimer();
  callTimerInterval = setInterval(updateCallTimer, 1000);
}

/* 🔵 Transcript iframe bridge with handshake + queue */
let transcriptPanelReady = false;
const transcriptEventQueue = [];

function flushTranscriptEventQueue() {
  if (!transcriptFrame || !transcriptFrame.contentWindow) return;
  while (transcriptEventQueue.length) {
    const payload = transcriptEventQueue.shift();
    try {
      transcriptFrame.contentWindow.postMessage(
        { source: "sow-call", ...payload },
        "*"
      );
    } catch (e) {
      warn("postToTranscriptPanel flush error", e);
      break;
    }
  }
}

// Listen for "ready" handshake from transcript.html?embed=1
window.addEventListener("message", (event) => {
  const data = event.data || {};
  if (data.source === "sow-transcript" && data.type === "ready") {
    transcriptPanelReady = true;
    flushTranscriptEventQueue();
  }
});

/* 🔵 Bridge helper: send events to the live transcript iframe */
function postToTranscriptPanel(payload) {
  // If iframe not ready yet, queue the event
  if (
    !transcriptFrame ||
    !transcriptFrame.contentWindow ||
    !transcriptPanelReady
  ) {
    transcriptEventQueue.push(payload);
    return;
  }
  try {
    transcriptFrame.contentWindow.postMessage(
      { source: "sow-call", ...payload },
      "*" // use * so it also works on file:// during local dev
    );
  } catch (e) {
    warn("postToTranscriptPanel error", e);
  }
}

/* Helper to send assistant text as a final turn */
function sendAssistantTextToTranscript(text) {
  const s = (text || "").trim();
  if (!s) return;
  postToTranscriptPanel({
    type: "final",
    text: s,
    speaker: "assistant",
  });
}

/* Helper to send assistant interim text (optional) */
function sendAssistantInterimToTranscript(text) {
  const s = (text || "").trim();
  if (!s) return;
  postToTranscriptPanel({
    type: "interim",
    text: s,
    speaker: "assistant",
  });
}

/* Derive a short conversation title from first user utterance */
function deriveTitleFromText(raw) {
  let t = (raw || "").replace(/\s+/g, " ").trim();
  if (!t) return null;

  const max = 80;
  if (t.length > max) {
    let cut = t.lastIndexOf(" ", max);
    if (cut < 30) cut = max;
    t = t.slice(0, cut);
  }

  // strip leading non-alnum, trailing punctuation
  t = t.replace(/^[^A-Za-z0-9]+/, "").replace(/[\s\-–—_,.:;!?]+$/, "");
  if (!t) return null;

  return t.charAt(0).toUpperCase() + t.slice(1);
}

async function maybeUpdateConversationTitleFromTranscript(text) {
  if (!conversationId || conversationTitleLocked) return;
  const title = deriveTitleFromText(text);
  if (!title || title.length < 4) return;

  try {
    const { error } = await supabase
      .from("conversations")
      .update({ title })
      .eq("id", conversationId)
      .or("title.is.null,title.eq.New Conversation");

    if (error) {
      warn("Conversation title update error:", error);
      return;
    }
    conversationTitleLocked = true;
    log("[SOW] Conversation title set from call transcript:", title);
  } catch (e) {
    warn("Conversation title update failed:", e);
  }
}

/* ---------- NEW: Idle detection helpers ---------- */
function noteUserActivity() {
  lastUserActivityAt = Date.now();
  // if user does anything meaningful, disarm idle logic for this cycle
  cancelIdleTimers();
  idleArmed = false;
  idleStep = 0;
}

function cancelIdleTimers() {
  if (idleTimer1) clearTimeout(idleTimer1);
  if (idleTimer2) clearTimeout(idleTimer2);
  idleTimer1 = idleTimer2 = null;
}

function armIdleAfterAI() {
  cancelIdleTimers();
  idleArmed = true;
  idleStep = 0;
  // schedule first nudge
  idleTimer1 = setTimeout(
    () => maybeRunNoResponseNudge(),
    NO_RESPONSE.FIRST_NUDGE_MS
  );
}

function disarmIdle(reason = "") {
  cancelIdleTimers();
  idleArmed = false;
  idleStep = 0;
  idleInFlight = false;
  if (reason) log("[SOW] idle disarmed:", reason);
}

function shouldConsiderIdle() {
  if (!isCalling) return false;
  // NOTE: we intentionally allow idle checks while recording, because
  // "idle" means we're listening but the user isn't speaking.
  if (isPlayingAI) return false;
  if (!idleArmed) return false;
  // don't fire immediately; give UI a moment
  if (Date.now() - lastAIFinishedAt < NO_RESPONSE.ARM_DELAY_MS) return false;
  // if user has done something recently, don't idle
  if (Date.now() - lastUserActivityAt < 400) return false;
  return true;
}

async function callCoachSystemEvent(eventType) {
  // eventType: "no_response_nudge" | "no_response_end"
  const user_id = getUserIdForWebhook();
  const device = getOrCreateDeviceId();

  // ensure call_id exists
  if (!currentCallId) {
    try {
      currentCallId =
        localStorage.getItem("last_call_id") || crypto.randomUUID();
      localStorage.setItem("last_call_id", currentCallId);
    } catch {
      currentCallId =
        currentCallId ||
        `call_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    }
  }

  const resp = await fetch(CALL_COACH_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      source: "voice",
      user_id,
      device_id: device,
      call_id: currentCallId,
      conversationId: conversationId || null,
      system_event: eventType,
    }),
  });

  if (!resp.ok) {
    const t = await resp.text().catch(() => "");
    throw new Error(
      `call-coach system_event ${resp.status}: ${t || resp.statusText}`
    );
  }

  const data = await resp.json().catch(() => ({}));
  const text = (data.assistant_text || data.text || "").toString().trim();
  const b64 = data.audio_base64 || "";
  const mime = data.mime || "audio/mpeg";

  if (!b64) throw new Error("system_event missing audio_base64");
  return { text, b64, mime };
}

function base64ToBlobUrl(b64, mime = "audio/mpeg") {
  const raw = (b64 || "").includes(",") ? b64.split(",").pop() : b64;
  const bytes = Uint8Array.from(atob(raw), (c) => c.charCodeAt(0));
  const blob = new Blob([bytes], { type: mime || "audio/mpeg" });
  return URL.createObjectURL(blob);
}

async function playJsonTTS({ text, b64, mime }, { ringColor = "#d4a373" } = {}) {
  const url = base64ToBlobUrl(b64, mime);
  try {
    // mirror text immediately
    if (text) sendAssistantTextToTranscript(text);
    await safePlayOnce(url, { limitMs: 60_000, color: ringColor });
  } finally {
    try {
      URL.revokeObjectURL(url);
    } catch (e) {
      // ignore
    }
  }
}

async function maybeRunNoResponseNudge() {
  if (!shouldConsiderIdle()) return;
  if (idleInFlight) return;
  if (idleStep !== 0) return;

  idleInFlight = true;

  try {
    statusText.textContent = "Still there…";
    const payload = await callCoachSystemEvent("no_response_nudge");
    if (!isCalling) return;

    // while nudge plays, prevent recording loop from starting
    isPlayingAI = true;
    await playJsonTTS(payload, { ringColor: "#d4a373" });
  } catch (e) {
    warn("no_response_nudge failed", e);
  } finally {
    isPlayingAI = false;
    idleInFlight = false;
    if (!isCalling) return;

    // If user started speaking during/after, bail
    if (Date.now() - lastUserActivityAt < 500) {
      disarmIdle("user activity after nudge");
      return;
    }

    // schedule end call
    idleStep = 1;
    idleTimer2 = setTimeout(
      () => maybeRunNoResponseEnd(),
      NO_RESPONSE.END_CALL_MS
    );
  }
}

async function maybeRunNoResponseEnd() {
  if (!shouldConsiderIdle()) return;
  if (idleInFlight) return;
  if (idleStep !== 1) return;

  idleInFlight = true;

  try {
    statusText.textContent = "Ending call…";
    const payload = await callCoachSystemEvent("no_response_end");
    if (!isCalling) return;

    isPlayingAI = true;
    await playJsonTTS(payload, { ringColor: "#d4a373" });
  } catch (e) {
    warn("no_response_end failed", e);
  } finally {
    isPlayingAI = false;
    idleInFlight = false;
    if (!isCalling) return;
    // end the call regardless (even if the end line failed)
    endCall();
  }
}

/* ---------- History / Summary (Supabase via REST, optional) ---------- */
async function fetchLastPairsFromSupabase(user_id, { pairs = 8 } = {}) {
  if (!HAS_SUPABASE) {
    return { text: "", pairs: [] };
  }
  try {
    const uuid = pickUuidForHistory(user_id);
    const url = new URL(`${SUPABASE_REST}/${encodeURIComponent(HISTORY_TABLE)}`);
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
    const url = new URL(`${SUPABASE_REST}/${encodeURIComponent(SUMMARY_TABLE)}`);
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

function buildRollingSummary(
  prevSummary,
  pairs,
  newest,
  maxChars = SUMMARY_MAX_CHARS
) {
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
      if (/(goal|need|want|plan|decide|next|todo|fix|issue)/i.test(t))
        score += 2;
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

/* ---------- UI: Chat (still wired for n8n, but Switch-to-Chat now navigates) ---------- */
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
      appendMsg("me", txt);
      noteUserActivity(); // counts as response activity
      await sendChatToN8N(txt);
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
    // also clear the right-hand panel
    postToTranscriptPanel({ type: "clear" });
  },
  setInterim(t) {
    const text = t || "";
    transcriptInterim.textContent = text;
    if (!text) return;
    postToTranscriptPanel({
      type: "interim",
      text,
      speaker: "user",
    });
    noteUserActivity(); // interim counts as activity
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
    postToTranscriptPanel({
      type: "final",
      text: s,
      speaker: "user",
    });
    noteUserActivity(); // final counts as activity
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
    src = playbackAC.createMediaElementSource(mediaEl);
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

    // ring from analyser
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
  } catch (e) {
    // ignore
  }
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
    modeBtn.setAttribute("aria-pressed", "false");
    modeBtn.title = "Open this conversation in chat view";
  }
}

/* ---------- Navigation back to chat thread ---------- */
function navigateToChatThread() {
  const params = new URLSearchParams(window.location.search);
  const c = params.get("c");
  const url = new URL("home.html", window.location.origin);
  if (c) url.searchParams.set("c", c);
  window.location.href = url.toString();
}

/* ---------- Controls ---------- */
callBtn?.addEventListener("click", () => {
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

// Switch-to-Chat button now navigates back to home.html?c=...
modeBtn?.addEventListener("click", (e) => {
  e.preventDefault();
  navigateToChatThread();
});

// Optional thread link in the footer
threadLink?.addEventListener("click", (e) => {
  e.preventDefault();
  navigateToChatThread();
});

document.addEventListener("keydown", (e) => {
  if (e.key?.toLowerCase?.() === "c") {
    e.preventDefault();
    navigateToChatThread();
  }
});

/* ---------- Greeting (ALWAYS transcribable) ---------- */
async function fetchGreetingJSON() {
  const user_id = getUserIdForWebhook();
  const device = getOrCreateDeviceId();

  const resp = await fetch(GREETING_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ user_id, device_id: device }),
  });

  if (!resp.ok) {
    const t = await resp.text().catch(() => "");
    throw new Error(`Greeting HTTP ${resp.status}: ${t || resp.statusText}`);
  }

  const data = await resp.json().catch(() => ({}));
  const text = (data.assistant_text || data.text || "").toString().trim();
  const audio_base64 = data.audio_base64 || "";
  const mime = data.mime || "audio/mpeg";

  if (!text) throw new Error("Greeting missing text");
  if (!audio_base64) throw new Error("Greeting missing audio_base64");

  return { text, audio_base64, mime };
}

async function prepareGreetingForNextCall() {
  greetingReadyPromise = (async () => {
    try {
      const payload = await fetchGreetingJSON();
      greetingPayload = payload;

      if (greetingAudioUrl) {
        try {
          URL.revokeObjectURL(greetingAudioUrl);
        } catch (e) {
          // ignore
        }
      }
      greetingAudioUrl = base64ToBlobUrl(payload.audio_base64, payload.mime);
      log("[SOW] Greeting prefetched (JSON).");
      return true;
    } catch (e) {
      warn("Greeting prefetch failed", e);
      greetingPayload = null;
      if (greetingAudioUrl) {
        try {
          URL.revokeObjectURL(greetingAudioUrl);
        } catch (err) {
          // ignore
        }
      }
      greetingAudioUrl = null;
      return false;
    }
  })();
}

async function ensureGreetingReadyWithRetry() {
  // If nothing queued, fetch now.
  if (!greetingReadyPromise) prepareGreetingForNextCall();

  let ok = await greetingReadyPromise;
  greetingReadyPromise = null; // consumed

  if (ok && greetingPayload && greetingAudioUrl) return true;

  // Retry once (network hiccup / cold start)
  await new Promise((r) => setTimeout(r, 450));
  prepareGreetingForNextCall();
  ok = await greetingReadyPromise;
  greetingReadyPromise = null;

  return Boolean(ok && greetingPayload && greetingAudioUrl);
}

/* ---------- Call flow ---------- */
async function startCall() {
  if (isCalling) return;
  isCalling = true;

  disarmIdle("startCall");
  noteUserActivity();

  // create a call_id for this session and store it
  try {
    currentCallId = crypto.randomUUID();
  } catch {
    currentCallId = `call_${Date.now()}_${Math.random().toString(36).slice(
      2
    )}`;
  }
  try {
    localStorage.setItem("last_call_id", currentCallId);
  } catch (e) {
    // ignore storage errors
  }

  callBtn.classList.add("call-active");
  transcriptUI.clearAll();
  showCallView();
  startCallTimer();

  try {
    statusText.textContent = "Ringing…";
    await safePlayOnce("ring.mp3", { limitMs: 15000 });
    if (!isCalling) return;

    // Ensure greeting is ready (or fetch if not)
    const greetingOk = await ensureGreetingReadyWithRetry();
    if (!isCalling) return;

    if (!greetingOk) {
      statusText.textContent =
        "Greeting failed. Please tap Call again in a moment.";
      endCall();
      return;
    }

    // Transcribe greeting BEFORE playback
    statusText.textContent = "AI greeting you…";
    if (greetingPayload?.text) {
      sendAssistantTextToTranscript(greetingPayload.text);
    }

    // Play greeting audio from Blob URL
    if (greetingAudioUrl) {
      await safePlayOnce(greetingAudioUrl, { limitMs: 60000 });
      try {
        URL.revokeObjectURL(greetingAudioUrl);
      } catch (e) {
        // ignore
      }
      greetingAudioUrl = null;
    }

    if (!isCalling) return;

    // Prepare next greeting in the background
    greetingPayload = null;
    prepareGreetingForNextCall();

    // If this browser doesn't support native speech recognition,
    // we can't safely run the live call loop. Fail gracefully.
    if (!HAS_NATIVE_ASR) {
      statusText.textContent =
        "This browser doesn’t fully support live call mode. Please use desktop Chrome or type in chat.";
      endCall();
      return;
    }

    statusText.textContent = "Listening…";
    await startRecordingLoop();
  } catch (e) {
    warn("startCall error", e);
    statusText.textContent = "Audio blocked or greeting failed. Tap again.";
    resetCallTimer();
    isCalling = false;
    callBtn.classList.remove("call-active");
  }
}

function endCall() {
  isCalling = false;
  isRecording = false;
  isPlayingAI = false;

  disarmIdle("endCall");

  callBtn.classList.remove("call-active");
  statusText.textContent = "Call ended.";
  stopCallTimer();
  stopMicVAD();
  stopRing();
  stopBargeInMonitor();

  try {
    globalStream?.getTracks().forEach((t) => t.stop());
  } catch (e) {
    // ignore
  }
  globalStream = null;
  try {
    if (mediaRecorder && mediaRecorder.state !== "inactive") mediaRecorder.stop();
  } catch (e) {
    // ignore
  }
  closeNativeRecognizer();

  for (const el of Array.from(managedAudios)) {
    try {
      el.pause();
      const src = el.src;
      el.src = "";
      if (src?.startsWith("blob:")) URL.revokeObjectURL(src);
    } catch (e) {
      // ignore
    }
    managedAudios.delete(el);
  }

  // cleanup greeting url if any
  if (greetingAudioUrl) {
    try {
      URL.revokeObjectURL(greetingAudioUrl);
    } catch (e) {
      // ignore
    }
    greetingAudioUrl = null;
  }
}

/* Small one-shot clips (ring/greeting/others) */
function safePlayOnce(src, { limitMs = 15000, color = "#d4a373" } = {}) {
  return new Promise((res) => {
    const a = new Audio(src);
    a.preload = "auto";
    registerAudioElement(a);
    animateRingFromElement(a, color);
    let done = false;

    const settle = (ok) => {
      if (done) return;
      done = true;
      a.onended = a.onerror = a.onabort = a.oncanplaythrough = null;
      stopRing();
      res(ok);
    };

    a.oncanplaythrough = () => {
      try {
        a.play().catch(() => settle(false));
      } catch (e) {
        settle(false);
      }
    };
    a.onerror = () => settle(false);
    a.onabort = () => settle(false);

    const t = setTimeout(() => settle(false), limitMs);
    a.onended = () => {
      clearTimeout(t);
      settle(true);
    };
  });
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

  log("ASR available?", !!ASR, ASR);
  if (!ASR) {
    warn("Web Speech API not available; falling back to no live captions.");
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
        log("ASR final:", txt);
        transcriptUI.addFinalLine(txt);
        finalSegments.push(txt);
        interimBuffer = "";
      } else {
        interim += (interim ? " " : "") + txt;
      }
    }
    transcriptUI.setInterim(interim);
    interimBuffer = interim;
    if (interim) noteUserActivity(); // user speaking
  };

  r.onerror = (e) => {
    warn("ASR error:", e);
    if (e.error === "not-allowed" || e.error === "service-not-allowed") {
      closeNativeRecognizer();
    }
  };

  r.onend = () => {
    log("ASR onend; isCalling=", isCalling, "isRecording=", isRecording);
    if (isCalling && isRecording) {
      try {
        r.start();
        log("ASR restarted");
      } catch (err) {
        warn("ASR restart failed:", err);
      }
    }
  };

  try {
    r.start();
    log("ASR start() called");
  } catch (err) {
    warn("ASR start() threw immediately:", err);
  }

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
  } catch (e) {
    warn("closeNativeRecognizer error:", e);
  }
}

async function captureOneTurn() {
  if (!isCalling || isRecording || isPlayingAI) return false;

  // We intentionally do NOT disarm idle here; this is the period
  // where we want to detect "no response" if the user stays silent.

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
    updateMicTracks(); // respects micMuted state

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

    // Make it very obvious it's their turn now
    statusText.textContent = "Listening…";

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

  const data = new Uint8Array(bargeAnalyser.fftSize);
  let hold = 0;
  let armed = false;
  let sinceArm = 0;

  const loop = () => {
    if (!bargeAnalyser) return;
    bargeAnalyser.getByteTimeDomainData(data);
    let sum = 0;
    for (let i = 0; i < data.length; i++) {
      const v = data[i] - 128;
      sum += v * v;
    }
    const rms = Math.sqrt(sum / data.length);

    if (!armed) {
      sinceArm += 16;
      if (sinceArm >= BARGE.cooldownMs) armed = true;
    } else {
      if (rms > BARGE.rmsThresh) {
        hold += 16;
        if (hold >= BARGE.holdMs) {
          try {
            onInterrupt?.();
          } catch (e) {
            // ignore
          }
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
  } catch (e) {
    // ignore
  }
  if (bargeCtx && bargeCtx.state !== "closed") {
    try {
      bargeCtx.close();
    } catch (e) {
      // ignore
    }
  }
  bargeCtx = bargeSrc = bargeAnalyser = null;
}

/* Unified AI playback that supports barge-in and optional live transcription */
async function playAIWithBargeIn(
  playableUrl,
  { aiBlob = null, aiBubbleEl = null } = {}
) {
  return new Promise(async (resolve) => {
    statusText.textContent = "AI replying…";
    isPlayingAI = true;

    // during AI playback, don't run idle timers
    disarmIdle("AI playback start");

    const a = new Audio(playableUrl);
    registerAudioElement(a);
    animateRingFromElement(a, "#d4a373");

    // live transcription webhook if configured (assistant interim/final)
    if (!aiBubbleEl && inChatView)
      aiBubbleEl = appendMsg("ai", "", { typing: true });

    if (aiBlob && N8N_TRANSCRIBE_URL) {
      try {
        liveTranscribeBlob(aiBlob, aiBubbleEl).catch(() => {});
      } catch (e) {
        // ignore
      }
    }

    const okMic = await ensureLiveMicForBargeIn();

    let interrupted = false;
    const cleanup = () => {
      stopRing();
      stopBargeInMonitor();
      isPlayingAI = false;

      // mark AI finished and arm idle timers for no-response flow
      lastAIFinishedAt = Date.now();
      if (isCalling) armIdleAfterAI();

      resolve({ interrupted });
    };

    if (okMic) {
      startBargeInMonitor(() => {
        interrupted = true;
        try {
          a.pause();
        } catch (e) {
          // ignore
        }
        statusText.textContent = "Go ahead…";

        // user is interrupting -> counts as activity
        noteUserActivity();

        cleanup();
      });
    }

    try {
      await a.play();
    } catch (e) {
      // ignore
    }
    a.onended = () => cleanup();
  });
}

/* ---------- Voice path: upload → Supabase (optional) → call-coach ---------- */
const RECENT_USER_KEEP = 12;
let recentUserTurns = [];

async function uploadRecordingAndNotify() {
  if (!isCalling) return false;

  const finalText = finalSegments.join(" ").trim();
  const interimText = (interimBuffer || "").trim();
  const combinedTranscript = finalText || interimText || "";

  if (combinedTranscript) {
    noteUserActivity(); // user actually spoke
    recentUserTurns.push(combinedTranscript);
    if (recentUserTurns.length > RECENT_USER_KEEP) {
      recentUserTurns.splice(0, recentUserTurns.length - RECENT_USER_KEEP);
    }
    // Title the conversation on first meaningful utterance if still untitled
    maybeUpdateConversationTitleFromTranscript(combinedTranscript).catch(
      () => {}
    );
  }

  const user_id = getUserIdForWebhook();
  const device = getOrCreateDeviceId();

  // ensure we always have a call_id and keep it persisted
  if (!currentCallId) {
    try {
      currentCallId =
        localStorage.getItem("last_call_id") || crypto.randomUUID();
      localStorage.setItem("last_call_id", currentCallId);
    } catch {
      currentCallId =
        currentCallId ||
        `call_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    }
  }

  const mimeType = mediaRecorder?.mimeType || "audio/webm";
  const blob = new Blob(recordChunks, { type: mimeType });
  if (!blob.size || !isCalling) {
    statusText.textContent = "No audio captured.";
    return false;
  }

  statusText.textContent = "Thinking…";

  // history/summary
  let historyPairsText = "";
  let historyPairs = [];
  try {
    const hist = await fetchLastPairsFromSupabase(user_id, { pairs: 8 });
    historyPairsText = hist.text || "";
    historyPairs = hist.pairs || [];
  } catch (e) {
    // ignore; we already log inside helper
  }

  const prevSummary = await fetchRollingSummary(user_id, device);
  const rollingSummary = buildRollingSummary(
    prevSummary,
    historyPairs,
    combinedTranscript
  );

  const transcriptForModel = historyPairsText
    ? `Previous conversation (last ${Math.min(
        historyPairs.length,
        8
      )} pairs), oldest→newest:\n${historyPairsText}\n\nUser now says:\n${combinedTranscript}`
    : combinedTranscript;

  // upload user audio to storage (OPTIONAL)
  let uploaded = false;
  if (HAS_SUPABASE) {
    try {
      const ext = mimeType.includes("mp4") ? "m4a" : "webm";
      const filePath = `${RECORDINGS_FOLDER}/${device}/${Date.now()}.${ext}`;
      const uploadUrl = `${SUPABASE_URL}/storage/v1/object/${encodeURIComponent(
        SUPABASE_BUCKET
      )}/${filePath}`;
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
      if (!upRes.ok) {
        warn("Supabase upload failed", upRes.status);
      }
    } catch (e) {
      warn("Supabase upload error", e);
    }
  } else {
    log("Skipping Supabase upload; HAS_SUPABASE is false.");
  }

  // call Netlify call-coach (hard-coded workflow)
  let aiPlayableUrl = null;
  let revokeLater = null;
  let aiBlob = null;
  let aiTextFromJSON = "";

  try {
    const body = {
      user_id,
      device_id: device,
      call_id: currentCallId,

      // pass the current utterance separately so backend can log it cleanly
      user_turn: combinedTranscript,

      transcript: transcriptForModel,
      has_transcript: !!transcriptForModel,
      history_user_last3: recentUserTurns.slice(-3),
      rolling_summary: rollingSummary || undefined,
      executionMode: "production",
      source: "voice",
      audio_uploaded: uploaded,

      // pass conversation/thread if present
      conversationId: conversationId || null,
      conversation_id: conversationId || null,
      c: conversationId || null,
    };

    const resp = await fetch(CALL_COACH_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    const ct = (resp.headers.get("content-type") || "").toLowerCase();

    // progressive stream first (kept for compatibility; call-coach may return audio)
    if (
      ENABLE_STREAMED_PLAYBACK &&
      ct.includes("audio/webm") &&
      resp.body?.getReader
    ) {
      const ok = await playStreamedWebmOpus(resp.clone());
      if (ok) {
        // AI finished speaking; arm idle
        lastAIFinishedAt = Date.now();
        if (isCalling) armIdleAfterAI();

        upsertRollingSummary(user_id, device, rollingSummary).catch(() => {});
        return true;
      }
    }

    if (ct.startsWith("audio/") || ct === "application/octet-stream") {
      aiBlob = await resp.blob();
      aiPlayableUrl = URL.createObjectURL(aiBlob);
      revokeLater = aiPlayableUrl;
    } else if (ct.includes("application/json")) {
      const data = await resp.json();

      // use assistant_text if provided
      aiTextFromJSON = (
        data?.assistant_text ??
        data?.text ??
        data?.transcript ??
        data?.message ??
        ""
      )
        .toString()
        .trim();

      const b64 = data?.audio_base64;
      const url =
        data?.result_audio_url ||
        data?.audioUrl ||
        data?.url ||
        data?.fileUrl;

      if (b64 && !url) {
        const raw = b64.includes(",") ? b64.split(",").pop() : b64;
        const bytes = Uint8Array.from(atob(raw), (c) => c.charCodeAt(0));
        aiBlob = new Blob([bytes], {
          type: data?.mime || "audio/mpeg",
        });
        aiPlayableUrl = URL.createObjectURL(aiBlob);
        revokeLater = aiPlayableUrl;
      } else if (url) {
        aiPlayableUrl = url;
      }
    } else {
      aiBlob = await resp.blob();
      if (aiBlob.size) {
        aiPlayableUrl = URL.createObjectURL(aiBlob);
        revokeLater = aiPlayableUrl;
      }
    }
  } catch (e) {
    warn("call-coach failed", e);
    statusText.textContent = "AI processing failed.";
    return false;
  }

  if (!isCalling) return false;
  if (!aiPlayableUrl) {
    statusText.textContent = "AI processing failed (no audio).";
    return false;
  }

  // Mirror assistant text into transcript panel immediately
  if (aiTextFromJSON) {
    sendAssistantTextToTranscript(aiTextFromJSON);
  }

  // If JSON gave us text and chat is open, type it
  let aiBubble = null;
  if (inChatView) {
    aiBubble = appendMsg("ai", "", { typing: true });
    if (aiTextFromJSON) await typewriter(aiBubble, aiTextFromJSON, 18);
  }

  const { interrupted } = await playAIWithBargeIn(aiPlayableUrl, {
    aiBlob: !aiTextFromJSON ? aiBlob : null,
    aiBubbleEl: aiBubble,
  });

  if (revokeLater) {
    try {
      URL.revokeObjectURL(revokeLater);
    } catch (e) {
      // ignore
    }
  }

  upsertRollingSummary(user_id, device, rollingSummary).catch(() => {});
  return !interrupted || true;
}

/* ---------- Live-transcribe the AI Blob through optional webhook ---------- */
async function liveTranscribeBlob(blob, aiBubbleEl) {
  if (!N8N_TRANSCRIBE_URL) return;

  const trySSE = async () => {
    const resp = await fetch(N8N_TRANSCRIBE_URL, {
      method: "POST",
      headers: { Accept: "text/event-stream" },
      body: await blobToFormData(blob, "file", "ai.mp3"),
    });
    const ct = (resp.headers.get("content-type") || "").toLowerCase();
    if (!ct.includes("text/event-stream")) return false;
    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let full = "";
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      const chunk = decoder.decode(value, { stream: true });
      for (const line of chunk.split(/\r?\n/)) {
        if (!line.startsWith("data:")) continue;
        const json = line.slice(5).trim();
        if (!json) continue;
        try {
          const evt = JSON.parse(json);
          if (evt.delta) {
            full += evt.delta;
            if (aiBubbleEl) aiBubbleEl.textContent = full;
            sendAssistantInterimToTranscript(full);
          }
          if (evt.text && evt.done) {
            if (aiBubbleEl) aiBubbleEl.textContent = evt.text;
            sendAssistantTextToTranscript(evt.text);
            return true;
          }
        } catch (e) {
          // ignore
        }
      }
    }
    if (full) {
      sendAssistantTextToTranscript(full);
    }
    return !!full;
  };

  const sseOk = await trySSE().catch(() => false);
  if (sseOk) return;

  try {
    const resp = await fetch(N8N_TRANSCRIBE_URL, {
      method: "POST",
      body: await blobToFormData(blob, "file", "ai.mp3"),
    });
    const data = await resp.json().catch(() => null);
    const text = data?.text || data?.transcript || "";
    if (text && aiBubbleEl) {
      await typewriter(aiBubbleEl, text, 18);
    }
    if (text) sendAssistantTextToTranscript(text);
  } catch (e) {
    // ignore
  }
}

async function blobToFormData(blob, field = "file", filename = "audio.mp3") {
  const fd = new FormData();
  fd.append(field, blob, filename);
  return fd;
}

/* ---------- Chat path (text → n8n) ---------- */
async function sendChatToN8N(userText) {
  const user_id = getUserIdForWebhook();
  const device = getOrCreateDeviceId();

  recentUserTurns.push(userText);
  if (recentUserTurns.length > RECENT_USER_KEEP) {
    recentUserTurns.splice(0, recentUserTurns.length - RECENT_USER_KEEP);
  }

  // Also allow chat text from call page to title an untitled conversation
  maybeUpdateConversationTitleFromTranscript(userText).catch(() => {});

  let historyPairsText = "";
  let historyPairs = [];
  try {
    const hist = await fetchLastPairsFromSupabase(user_id, { pairs: 8 });
    historyPairsText = hist.text || "";
    historyPairs = hist.pairs || [];
  } catch (e) {
    // ignore
  }

  const prevSummary = await fetchRollingSummary(user_id, device);
  const rollingSummary = buildRollingSummary(
    prevSummary,
    historyPairs,
    userText
  );

  const transcriptForModel = historyPairsText
    ? `Previous conversation (last ${Math.min(
        historyPairs.length,
        8
      )} pairs), oldest→newest:\n${historyPairsText}\n\nUser now says:\n${userText}`
    : userText;

  try {
    const resp = await fetch(N8N_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        user_id,
        transcript: transcriptForModel,
        has_transcript: !!transcriptForModel,
        history_user_last3: recentUserTurns.slice(-3),
        rolling_summary: rollingSummary || undefined,
        executionMode: "production",
        source: "chat",
      }),
    });

    const ct = (resp.headers.get("content-type") || "").toLowerCase();
    let aiText = "";
    let playableUrl = null;
    let revoke = null;
    let b = null;

    if (ct.includes("application/json")) {
      const data = await resp.json();
      aiText = data?.text ?? data?.transcript ?? data?.message ?? "";
      const url =
        data?.result_audio_url ||
        data?.audioUrl ||
        data?.url ||
        data?.fileUrl;
      const b64 = data?.audio_base64;
      if (b64 && !url) {
        const raw = b64.includes(",") ? b64.split(",").pop() : b64;
        const bytes = Uint8Array.from(atob(raw), (c) => c.charCodeAt(0));
        b = new Blob([bytes], { type: data?.mime || "audio/mpeg" });
        playableUrl = URL.createObjectURL(b);
        revoke = playableUrl;
      } else if (url) {
        playableUrl = url;
      }
    } else if (ct.startsWith("audio/") || ct === "application/octet-stream") {
      b = await resp.blob();
      if (b.size) {
        playableUrl = URL.createObjectURL(b);
        revoke = playableUrl;
      }
    } else {
      b = await resp.blob();
      if (b.size) {
        playableUrl = URL.createObjectURL(b);
        revoke = playableUrl;
      }
    }

    const aiBubble = appendMsg("ai", "", { typing: true });
    if (aiText) {
      await typewriter(aiBubble, aiText, 18);
      // also mirror assistant text to the live transcript panel
      sendAssistantTextToTranscript(aiText);
    }

    if (playableUrl) {
      await playAIWithBargeIn(playableUrl, {
        aiBlob: !aiText ? b : null,
        aiBubbleEl: aiBubble,
      });
      if (revoke) {
        try {
          URL.revokeObjectURL(revoke);
        } catch (e) {
          // ignore
        }
      }
    }

    upsertRollingSummary(user_id, device, rollingSummary).catch(() => {});
  } catch (e) {
    warn("chat error", e);
    appendMsg("ai", "Sorry, I couldn’t send that just now.");
  }
}

/* ---------- Streamed webm/opus playback ---------- */
async function playStreamedWebmOpus(response) {
  try {
    if (!("MediaSource" in window)) return null;
    const ct = (response.headers.get("content-type") || "").toLowerCase();
    if (!ct.includes("audio/webm")) return null;
    if (!response.body || !response.body.getReader) return null;

    const ms = new MediaSource();
    const url = URL.createObjectURL(ms);
    await new Promise((res) =>
      ms.addEventListener("sourceopen", res, { once: true })
    );
    const sb = ms.addSourceBuffer('audio/webm; codecs="opus"');
    const reader = response.body.getReader();
    const a = new Audio(url);
    registerAudioElement(a);
    animateRingFromElement(a, "#d4a373");
    let started = false;

    const pump = async () => {
      const { value, done } = await reader.read();
      if (done) {
        if (!sb.updating) ms.endOfStream();
        else
          sb.addEventListener(
            "updateend",
            () => {
              try {
                ms.endOfStream();
              } catch (e) {
                // ignore
              }
            },
            { once: true }
          );
        return;
      }
      await new Promise((r) => {
        const go = () => {
          try {
            sb.appendBuffer(value);
          } catch (e) {
            r();
            return;
          }
        };
        if (!sb.updating) {
          go();
          r();
        } else
          sb.addEventListener(
            "updateend",
            () => {
              go();
              r();
            },
            { once: true }
          );
      });
      return pump();
    };

    sb.addEventListener("updateend", () => {
      if (!started) {
        started = true;
        try {
          a.play();
        } catch (e) {
          // ignore
        }
      }
    });

    pump().catch(() => {
      try {
        ms.endOfStream();
      } catch (e) {
        // ignore
      }
    });

    await new Promise((r) => (a.onended = r));
    URL.revokeObjectURL(url);

    // streamed AI done, arm idle
    lastAIFinishedAt = Date.now();
    if (isCalling) armIdleAfterAI();

    return true;
  } catch (e) {
    return null;
  }
}

/* ---------- Boot ---------- */
updateMicUI();
updateSpeakerUI();
updateModeBtnUI();
showCallView();
resetCallTimer();
prepareGreetingForNextCall();
log("[SOW] call.js ready");
