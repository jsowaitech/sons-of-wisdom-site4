// app/call.js
// Son of Wisdom — Call mode
// Voice call + inline transcript + Deepgram streaming (always-on for mobile) + on-screen Debug HUD
//
// NOTES:
// - Desktop: uses Web Speech API if available (live captions).
// - Mobile (Android/iOS): Deepgram WS streaming is ALWAYS-ON for the whole call (live captions).
// - The spoken user audio is still recorded via MediaRecorder and sent to call-coach.
// - Debug HUD appears on the UI (no console needed) and shows DG status/errors.
//
// Requires:
// - Netlify function: /.netlify/functions/deepgram-token  (returns {access_token})
// - Netlify function: /.netlify/functions/call-coach
// - Netlify function: /.netlify/functions/call-greeting

import { supabase } from "./supabase.js";

/* ---------- CONFIG ---------- */
const DEBUG = true;
const DEBUG_HUD = true;

/* Optional: Hume realtime SDK (safe stub if not loaded) */
const HumeRealtime = window.HumeRealtime ?? {
  init() {},
  startTurn() {},
  handleRecorderChunk() {},
  stopTurn() {},
};
HumeRealtime.init?.({ enable: false });

/* ---------- Supabase (OPTIONAL) ---------- */
const SUPABASE_URL = "https://plrobtlpedniyvkpwdmp.supabase.co";
const SUPABASE_SERVICE_ROLE_KEY = window.SUPABASE_SERVICE_ROLE_KEY || "";
const HAS_SUPABASE = Boolean(SUPABASE_URL) && Boolean(SUPABASE_SERVICE_ROLE_KEY);

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
const N8N_WEBHOOK_URL =
  "https://jsonofwisdom.app.n8n.cloud/webhook/4877ebea-544b-42b4-96d6-df41c58d48b0";

const N8N_TRANSCRIBE_URL = "";

const CALL_COACH_ENDPOINT = "/.netlify/functions/call-coach";
const GREETING_ENDPOINT = "/.netlify/functions/call-greeting";
const DEEPGRAM_TOKEN_ENDPOINT = "/.netlify/functions/deepgram-token";

/* ---------- I/O settings ---------- */
const ENABLE_MEDIARECORDER_64KBPS = true;
const TIMESLICE_MS = 100;

const IS_MOBILE = /Mobi|Android|iPhone|iPad/i.test(navigator.userAgent || "");
const ENABLE_STREAMED_PLAYBACK = !IS_MOBILE;

/**
 * ✅ Deepgram runs on mobile browsers.
 * (Always-on for whole call; not per VAD segment)
 */
const USE_DEEPGRAM_ON_MOBILE = IS_MOBILE;

/* ---------- USER / DEVICE ---------- */
const USER_ID_KEY = "sow_user_id";
const DEVICE_ID_KEY = "sow_device_id";
const SENTINEL_UUID = "00000000-0000-0000-0000-000000000000";

/** the current call session id */
let currentCallId = null;

const isUuid = (v) =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    v || ""
  );

/* ---------- Conversation thread (from ?c=...) ---------- */
const urlParams = new URLSearchParams(window.location.search);
const conversationId = urlParams.get("c") || null;
let conversationTitleLocked = false;

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
  document.getElementById("thread-link") || document.getElementById("btn-thread");

// ✅ Inline transcript panel (ONLY these)
const transcriptListEl = document.getElementById("transcriptList");
const transcriptInterimEl = document.getElementById("transcriptInterim");
const tsClearBtn = document.getElementById("ts-clear");
const tsAutoScrollBtn = document.getElementById("ts-autoscroll");

// Chat (created lazily)
let chatPanel = document.getElementById("chat-panel");
let chatLog;
let chatForm;
let chatInput;

/* ---------- State ---------- */
let isCalling = false;
let isRecording = false;
let isPlayingAI = false;

let callStartedAt = null;
let callTimerInterval = null;

let globalStream = null; // ✅ reused for whole call on mobile
let mediaRecorder = null;
let recordChunks = [];

/* Native ASR for desktop live captions */
let speechRecognizer = null;

/* Audio routing */
let playbackAC = null;
const managedAudios = new Set();
let preferredOutputDeviceId = null;
let micMuted = false;
let speakerMuted = false;

/* Greeting prefetch */
let greetingReadyPromise = null;
let greetingPayload = null;
let greetingAudioUrl = null;

/* ---------- Idle detection ---------- */
const NO_RESPONSE = {
  FIRST_NUDGE_MS: 20_000,
  END_CALL_MS: 20_000,
  ARM_DELAY_MS: 600,
};

let idleArmed = false;
let idleStep = 0;
let idleTimer1 = null;
let idleTimer2 = null;
let lastUserActivityAt = Date.now();
let lastAIFinishedAt = 0;
let idleInFlight = false;

/* ---------- INLINE TRANSCRIPT: UI + helpers ---------- */
let autoScrollOn = true;
let lastFinalLine = "";

const log = (...a) => DEBUG && console.log("[SOW]", ...a);
const warn = (...a) => DEBUG && console.warn("[SOW]", ...a);
const trimText = (s, n = 360) => (s || "").trim().slice(0, n);

/* ---------- Debug HUD (UI overlay) ---------- */
function renderDebugHud() {
  if (!DEBUG_HUD) return;
  let el = document.getElementById("sow-debug-hud");
  if (!el) {
    el = document.createElement("div");
    el.id = "sow-debug-hud";
    el.style.cssText = `
      position: fixed; z-index: 999999;
      left: 10px; right: 10px; bottom: 10px;
      padding: 10px 12px;
      background: rgba(0,0,0,.78);
      color: #fff;
      font: 12px/1.35 system-ui, -apple-system, Segoe UI, Roboto, Arial;
      border-radius: 10px;
      white-space: pre-wrap;
      word-break: break-word;
      max-height: 35vh;
      overflow: auto;
    `;
    document.body.appendChild(el);
  }

  const lines = [
    `Mobile: ${IS_MOBILE}`,
    `DG enabled: ${DG.enable}`,
    `DG status: ${window.__SOW_DG_STATUS || "(not started)"}`,
    `WS state: ${window.__SOW_DG_WS_STATE ?? ""}`,
    `Token OK: ${window.__SOW_DG_TOKEN_OK ?? ""}`,
    `Last msg: ${window.__SOW_DG_LASTMSG || ""}`,
    `Last err: ${window.__SOW_DG_ERR || ""}`,
  ].filter(Boolean);

  el.textContent = lines.join("\n");
}

function dgHudStatus(s) {
  window.__SOW_DG_STATUS = String(s || "");
  renderDebugHud();
}
function dgHudErr(e) {
  window.__SOW_DG_ERR = String(e || "");
  renderDebugHud();
}
function dgHudMsg(m) {
  window.__SOW_DG_LASTMSG = String(m || "");
  renderDebugHud();
}
function dgHudWsState(v) {
  window.__SOW_DG_WS_STATE = v;
  renderDebugHud();
}
function dgHudToken(ok) {
  window.__SOW_DG_TOKEN_OK = ok ? "yes" : "no";
  renderDebugHud();
}

function nowHHMM() {
  try {
    return new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  } catch {
    return "";
  }
}

function scrollTranscriptToBottom() {
  if (!autoScrollOn) return;
  if (!transcriptListEl) return;

  const scroller =
    transcriptListEl.closest(".ts-list") ||
    transcriptListEl.closest(".call-side-transcript") ||
    transcriptListEl;

  try {
    scroller.scrollTop = scroller.scrollHeight;
  } catch {}
}

function setAutoScroll(on) {
  autoScrollOn = !!on;
  if (tsAutoScrollBtn) {
    tsAutoScrollBtn.setAttribute("aria-pressed", String(autoScrollOn));
    tsAutoScrollBtn.textContent = autoScrollOn ? "On" : "Off";
  }
  if (autoScrollOn) scrollTranscriptToBottom();
}

function ensureTranscriptElementsExist() {
  if (!transcriptListEl || !transcriptInterimEl) {
    warn("Transcript elements not found. Check call.html ids: transcriptList/transcriptInterim.");
  }
}

function addTranscriptTurn(speaker, text) {
  const s = (text || "").trim();
  if (!s || !transcriptListEl) return;

  const turn = document.createElement("div");
  turn.className = `turn ${speaker === "assistant" ? "assistant" : "user"}`;

  const meta = document.createElement("div");
  meta.className = "meta";

  const role = document.createElement("span");
  role.className = "role";
  role.textContent = speaker === "assistant" ? "BLAKE" : "YOU";

  const time = document.createElement("span");
  time.className = "time";
  time.textContent = nowHHMM();

  meta.appendChild(role);
  meta.appendChild(time);

  const bubble = document.createElement("div");
  bubble.className = "bubble";

  const body = document.createElement("div");
  body.className = "text";
  body.textContent = s;

  bubble.appendChild(body);
  turn.appendChild(meta);
  turn.appendChild(bubble);

  transcriptListEl.appendChild(turn);
  scrollTranscriptToBottom();
}

function setTranscriptInterim(_speaker, text) {
  if (!transcriptInterimEl) return;
  const t = (text || "").trim();
  transcriptInterimEl.textContent = t ? t : "";
  if (t) scrollTranscriptToBottom();
}

/* ---------- Idle detection helpers ---------- */
function noteUserActivity() {
  lastUserActivityAt = Date.now();
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
  idleTimer1 = setTimeout(() => maybeRunNoResponseNudge(), NO_RESPONSE.FIRST_NUDGE_MS);
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
  if (isPlayingAI) return false;
  if (!idleArmed) return false;
  if (Date.now() - lastAIFinishedAt < NO_RESPONSE.ARM_DELAY_MS) return false;
  if (Date.now() - lastUserActivityAt < 400) return false;
  return true;
}

async function callCoachSystemEvent(eventType) {
  const user_id = getUserIdForWebhook();
  const device = getOrCreateDeviceId();

  if (!currentCallId) {
    try {
      currentCallId = localStorage.getItem("last_call_id") || crypto.randomUUID();
      localStorage.setItem("last_call_id", currentCallId);
    } catch {
      currentCallId = currentCallId || `call_${Date.now()}_${Math.random().toString(36).slice(2)}`;
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
    throw new Error(`call-coach system_event ${resp.status}: ${t || resp.statusText}`);
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
    if (text) addTranscriptTurn("assistant", text);
    await safePlayOnce(url, { limitMs: 60_000, color: ringColor });
  } finally {
    try {
      URL.revokeObjectURL(url);
    } catch {}
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

    isPlayingAI = true;
    await playJsonTTS(payload, { ringColor: "#d4a373" });
  } catch (e) {
    warn("no_response_nudge failed", e);
  } finally {
    isPlayingAI = false;
    idleInFlight = false;
    if (!isCalling) return;

    if (Date.now() - lastUserActivityAt < 500) {
      disarmIdle("user activity after nudge");
      return;
    }

    idleStep = 1;
    idleTimer2 = setTimeout(() => maybeRunNoResponseEnd(), NO_RESPONSE.END_CALL_MS);
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
    endCall();
  }
}

/* ---------- Call duration timer helpers ---------- */
function resetCallTimer() {
  callStartedAt = null;
  if (callTimerInterval) {
    clearInterval(callTimerInterval);
    callTimerInterval = null;
  }
  if (callTimerEl) callTimerEl.textContent = "00:00";
}

function stopCallTimer() {
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
  callTimerEl.textContent = `${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
}

function startCallTimer() {
  resetCallTimer();
  callStartedAt = Date.now();
  updateCallTimer();
  callTimerInterval = setInterval(updateCallTimer, 1000);
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

/* ---------- History / Summary (Supabase via REST, optional) ---------- */
async function fetchLastPairsFromSupabase(user_id, { pairs = 8 } = {}) {
  if (!HAS_SUPABASE) return { text: "", pairs: [] };
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
      noteUserActivity();
      await sendChatToN8N(txt);
    });
    chatForm._wired = true;
  }
}
ensureChatUI();

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

/* transcript helpers */
const transcriptUI = {
  clearAll() {
    if (transcriptInterimEl) transcriptInterimEl.textContent = "";
    if (transcriptListEl) transcriptListEl.innerHTML = "";
    lastFinalLine = "";
    scrollTranscriptToBottom();
  },

  setInterim(t) {
    const text = (t || "").trim();
    if (!text) {
      setTranscriptInterim("user", "");
      return;
    }
    setTranscriptInterim("user", text);
    noteUserActivity();
  },

  addFinalLine(t) {
    const s = (t || "").trim();
    if (!s || s === lastFinalLine) return;
    lastFinalLine = s;

    addTranscriptTurn("user", s);
    setTranscriptInterim("user", "");
    noteUserActivity();
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

function stopRing() {
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
    } catch {
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
    } catch {}
    drawVoiceRing();
  };

  mediaEl.addEventListener("playing", start, { once: true });
  mediaEl.addEventListener("pause", stop, { once: true });
  mediaEl.addEventListener("ended", stop, { once: true });

  if (!mediaEl.paused && !mediaEl.ended) start();
}

/* ---------- VAD (stop MediaRecorder after silence) ---------- */
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
  } catch {}
  if (vadCtx && vadCtx.state !== "closed") {
    try {
      vadCtx.close();
    } catch {}
  }
  vadCtx = vadAnalyser = vadSource = null;
}

/* ---------- Deepgram (always-on for mobile) ---------- */
const DG = {
  enable: USE_DEEPGRAM_ON_MOBILE,
  endpoint: "wss://api.deepgram.com/v1/listen",
  model: "nova-3",
  language: "en-US",
  smart_format: true,
  punctuate: true,
  interim_results: true,
  endpointing: 50,
  sample_rate: 16000,
};

let dgSocket = null;
let dgCtx = null;
let dgSource = null;
let dgProcessor = null;
let dgInputSampleRate = 48000;
let dgInterim = "";

function downsampleTo16k(float32, inSampleRate, outSampleRate = 16000) {
  if (outSampleRate === inSampleRate) return float32;

  const ratio = inSampleRate / outSampleRate;
  const newLen = Math.round(float32.length / ratio);
  const result = new Float32Array(newLen);

  let offsetResult = 0;
  let offsetBuffer = 0;

  while (offsetResult < result.length) {
    const nextOffsetBuffer = Math.round((offsetResult + 1) * ratio);
    let accum = 0;
    let count = 0;
    for (let i = offsetBuffer; i < nextOffsetBuffer && i < float32.length; i++) {
      accum += float32[i];
      count++;
    }
    result[offsetResult] = count ? accum / count : 0;
    offsetResult++;
    offsetBuffer = nextOffsetBuffer;
  }
  return result;
}

function floatTo16BitPCM(float32) {
  const buffer = new ArrayBuffer(float32.length * 2);
  const view = new DataView(buffer);
  let offset = 0;
  for (let i = 0; i < float32.length; i++, offset += 2) {
    let s = Math.max(-1, Math.min(1, float32[i]));
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return buffer;
}

async function fetchDeepgramToken() {
  dgHudStatus("token: fetching");
  const resp = await fetch(`${DEEPGRAM_TOKEN_ENDPOINT}?ttl=120`, { method: "GET" });
  if (!resp.ok) {
    const t = await resp.text().catch(() => "");
    dgHudToken(false);
    throw new Error(`Deepgram token HTTP ${resp.status}: ${t || resp.statusText}`);
  }
  const data = await resp.json().catch(() => ({}));
  if (!data.access_token) {
    dgHudToken(false);
    throw new Error("Deepgram token missing access_token");
  }
  dgHudToken(true);
  dgHudStatus("token: ok");
  return data.access_token;
}

function buildDeepgramWsUrl(token) {
  const u = new URL(DG.endpoint);
  u.searchParams.set("model", DG.model);
  u.searchParams.set("language", DG.language);
  u.searchParams.set("smart_format", String(!!DG.smart_format));
  u.searchParams.set("punctuate", String(!!DG.punctuate));
  u.searchParams.set("interim_results", String(!!DG.interim_results));
  u.searchParams.set("endpointing", String(DG.endpointing));
  u.searchParams.set("encoding", "linear16");
  u.searchParams.set("sample_rate", String(DG.sample_rate));
  u.searchParams.set("channels", "1");
  u.searchParams.set("token", token); // browser WS token
  return u.toString();
}

/**
 * ✅ IMPORTANT FIX:
 * When ending a call, send Deepgram a Finalize message and give it a moment
 * to flush final transcripts before closing the socket.
 */
async function finalizeDeepgramStream({ waitMs = 450 } = {}) {
  const s = dgSocket;
  if (!s || s.readyState !== WebSocket.OPEN) return;

  try {
    dgHudMsg("finalize: sending");
    s.send(JSON.stringify({ type: "Finalize" }));
  } catch (e) {
    // ignore
  }

  // give Deepgram time to send final frames
  await new Promise((r) => setTimeout(r, waitMs));
}

async function stopDeepgramRecognizer({ finalize = false } = {}) {
  // stop audio graph first so we stop sending frames
  try {
    if (dgProcessor) dgProcessor.onaudioprocess = null;
  } catch {}
  try {
    dgProcessor?.disconnect();
  } catch {}
  try {
    dgSource?.disconnect();
  } catch {}
  dgProcessor = dgSource = null;

  if (finalize) {
    try {
      dgHudStatus("finalizing…");
      await finalizeDeepgramStream({ waitMs: 500 });
    } catch {}
  }

  if (dgCtx && dgCtx.state !== "closed") {
    try {
      dgCtx.close();
    } catch {}
  }
  dgCtx = null;

  if (dgSocket) {
    try {
      dgSocket.close();
    } catch {}
  }
  dgSocket = null;
  dgInterim = "";
  dgHudStatus("stopped");
  dgHudWsState("");
}

async function startDeepgramRecognizer(stream) {
  if (!DG.enable) return false;

  // if already running, keep it
  if (dgSocket && dgSocket.readyState === WebSocket.OPEN) {
    dgHudStatus("streaming (already)");
    return true;
  }

  await stopDeepgramRecognizer({ finalize: false });
  dgHudStatus("starting");

  let token = "";
  try {
    token = await fetchDeepgramToken();
  } catch (e) {
    warn("Deepgram token fetch failed:", e);
    dgHudErr(`token: ${String(e?.message || e)}`);
    dgHudStatus("token failed");
    return false;
  }

  const wsUrl = buildDeepgramWsUrl(token);
  dgHudStatus("ws: connecting");

  let socket;
  try {
    socket = new WebSocket(wsUrl);
  } catch (e) {
    warn("Deepgram WebSocket create failed:", e);
    dgHudErr(`ws create: ${String(e?.message || e)}`);
    dgHudStatus("ws create failed");
    return false;
  }

  dgSocket = socket;

  socket.onopen = () => {
    log("[SOW] Deepgram WS open");
    dgHudStatus("ws: open");
    dgHudWsState(socket.readyState);
  };

  socket.onerror = (e) => {
    warn("[SOW] Deepgram WS error", e);
    dgHudErr("ws error");
    dgHudStatus("ws error");
    dgHudWsState(socket.readyState);
  };

  socket.onclose = (evt) => {
    log("[SOW] Deepgram WS closed", evt?.code, evt?.reason || "");
    dgHudStatus(`ws closed: ${evt?.code || ""} ${evt?.reason || ""}`.trim());
    dgHudWsState(socket.readyState);
  };

  socket.onmessage = (evt) => {
    try {
      dgHudWsState(socket.readyState);

      const msg = JSON.parse(evt.data);
      const alt = msg?.channel?.alternatives?.[0];
      const transcript = (alt?.transcript || "").trim();
      const isFinal = !!msg?.is_final;

      if (!transcript) {
        if (isFinal) transcriptUI.setInterim("");
        return;
      }

      dgHudMsg(`${isFinal ? "final" : "interim"}: ${transcript.slice(0, 80)}`);

      if (isFinal) {
        transcriptUI.addFinalLine(transcript);
        dgInterim = "";
      } else {
        dgInterim = transcript;
        transcriptUI.setInterim(dgInterim);
      }
    } catch {
      // ignore non-JSON frames
    }
  };

  dgCtx = new (window.AudioContext || window.webkitAudioContext)();
  if (dgCtx.state === "suspended") dgCtx.resume().catch(() => {});
  dgInputSampleRate = dgCtx.sampleRate || 48000;

  dgSource = dgCtx.createMediaStreamSource(stream);

  // ScriptProcessor works on Safari
  const bufferSize = 4096;
  dgProcessor = dgCtx.createScriptProcessor(bufferSize, 1, 1);
  dgSource.connect(dgProcessor);
  dgProcessor.connect(dgCtx.destination);

  dgProcessor.onaudioprocess = (e) => {
    if (!dgSocket || dgSocket.readyState !== WebSocket.OPEN) return;
    try {
      const input = e.inputBuffer.getChannelData(0);
      const down = downsampleTo16k(input, dgInputSampleRate, DG.sample_rate);
      const pcm16 = floatTo16BitPCM(down);
      dgSocket.send(pcm16);
      noteUserActivity();
    } catch {}
  };

  dgHudStatus("streaming");
  return true;
}

/* ---------- Mic stream: get once per call (mobile reliability) ---------- */
async function ensureMicStream() {
  if (globalStream) return globalStream;

  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    },
  });

  globalStream = stream;
  updateMicTracks();
  return stream;
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
  } catch {}
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
  } catch {
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
    if (!preferredOutputDeviceId) preferredOutputDeviceId = await pickSpeakerOutputDevice();
    if (preferredOutputDeviceId) {
      for (const el of managedAudios) await routeElementToPreferredOutput(el);
      statusText.textContent = "Speaker output active.";
    }
  }
});

modeBtn?.addEventListener("click", (e) => {
  e.preventDefault();
  navigateToChatThread();
});

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

tsClearBtn?.addEventListener("click", () => transcriptUI.clearAll());
tsAutoScrollBtn?.addEventListener("click", () => setAutoScroll(!autoScrollOn));

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
        } catch {}
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
        } catch {}
      }
      greetingAudioUrl = null;
      return false;
    }
  })();
}

async function ensureGreetingReadyWithRetry() {
  if (!greetingReadyPromise) prepareGreetingForNextCall();

  let ok = await greetingReadyPromise;
  greetingReadyPromise = null;

  if (ok && greetingPayload && greetingAudioUrl) return true;

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

  dgHudStatus("call starting");
  dgHudErr("");
  dgHudMsg("");
  dgHudWsState("");
  dgHudToken(false);

  try {
    currentCallId = crypto.randomUUID();
  } catch {
    currentCallId = `call_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  }
  try {
    localStorage.setItem("last_call_id", currentCallId);
  } catch {}

  callBtn.classList.add("call-active");
  transcriptUI.clearAll();
  startCallTimer();

  try {
    statusText.textContent = "Ringing…";
    await safePlayOnce("ring.mp3", { limitMs: 15000 });
    if (!isCalling) return;

    const greetingOk = await ensureGreetingReadyWithRetry();
    if (!isCalling) return;

    if (!greetingOk) {
      statusText.textContent = "Greeting failed. Please tap Call again in a moment.";
      endCall();
      return;
    }

    statusText.textContent = "AI greeting you…";
    if (greetingPayload?.text) addTranscriptTurn("assistant", greetingPayload.text);

    if (greetingAudioUrl) {
      await safePlayOnce(greetingAudioUrl, { limitMs: 60000 });
      try {
        URL.revokeObjectURL(greetingAudioUrl);
      } catch {}
      greetingAudioUrl = null;
    }

    if (!isCalling) return;

    greetingPayload = null;
    prepareGreetingForNextCall();

    // ✅ Get mic stream ONCE for the call, then start Deepgram once (mobile)
    statusText.textContent = "Connecting mic…";
    const stream = await ensureMicStream();

    if (!isCalling) return;

    if (DG.enable) {
      statusText.textContent = "Starting live transcription…";
      await startDeepgramRecognizer(stream);
    }

    // begin VAD capture loop
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

  // ✅ stop Deepgram only here — WITH FINALIZE FLUSH
  stopDeepgramRecognizer({ finalize: true }).catch(() => {});

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

  if (greetingAudioUrl) {
    try {
      URL.revokeObjectURL(greetingAudioUrl);
    } catch {}
    greetingAudioUrl = null;
  }

  dgHudStatus("call ended");
}

/* Small one-shot clips (ring/greeting/etc) */
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
      } catch {
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

    statusText.textContent = played ? "Your turn – I’m listening…" : "Listening again…";
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
  // ✅ If Deepgram is enabled (mobile), do NOT run Web Speech
  if (DG.enable) return;

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
    if (interim) noteUserActivity();
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
      } catch (err) {
        warn("ASR restart failed:", err);
      }
    }
  };

  try {
    r.start();
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
    warn("closeNativeRecognizer error", e);
  }
}

async function captureOneTurn() {
  if (!isCalling || isRecording || isPlayingAI) return false;

  statusText.textContent = "Your turn – I’m listening…";

  finalSegments = [];
  interimBuffer = "";
  transcriptUI.setInterim("Listening…");

  try {
    // ✅ Use the call-wide mic stream
    const stream = await ensureMicStream();

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
    } catch {
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

      // ✅ DO NOT stop Deepgram here (always-on for mobile)
      closeNativeRecognizer();

      HumeRealtime.stopTurn?.();
    };

    startMicVAD(stream, "#d4a373");

    // Start captions engine
    openNativeRecognizer(); // desktop only

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

/* ---------- Upload turn + coach response ---------- */
async function uploadRecordingAndNotify() {
  if (!recordChunks?.length) return false;

  const transcript = finalSegments.join(" ").replace(/\s+/g, " ").trim();

  if (transcript) {
    maybeUpdateConversationTitleFromTranscript(transcript).catch(() => {});
  }

  noteUserActivity();

  const mime = mediaRecorder?.mimeType || "audio/webm";
  const blob = new Blob(recordChunks, { type: mime });
  recordChunks = [];

  let audioUrl = "";
  const user_id = getUserIdForWebhook();
  const device = getOrCreateDeviceId();

  if (HAS_SUPABASE) {
    try {
      const fileName = `${RECORDINGS_FOLDER}/${device}/${Date.now()}.webm`;
      const { data, error } = await supabase.storage
        .from(SUPABASE_BUCKET)
        .upload(fileName, blob, {
          contentType: mime,
          upsert: false,
        });

      if (!error && data?.path) {
        const { data: pub } = supabase.storage
          .from(SUPABASE_BUCKET)
          .getPublicUrl(data.path);
        audioUrl = pub?.publicUrl || "";
      }
    } catch (e) {
      warn("Storage upload failed (continuing without URL)", e);
    }
  }

  const prevSummary = await fetchRollingSummary(user_id, device);
  const { pairs } = await fetchLastPairsFromSupabase(user_id, { pairs: 6 });
  const rolling_summary = buildRollingSummary(prevSummary, pairs, transcript);

  const payload = {
    source: "voice",
    user_id,
    device_id: device,
    call_id: currentCallId,
    conversationId: conversationId || null,
    transcript: transcript || "",
    user_turn: transcript || "",
    rolling_summary: rolling_summary || "",
    audio_url: audioUrl || "",
  };

  statusText.textContent = "Thinking…";

  let data = null;
  try {
    const resp = await fetch(CALL_COACH_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    if (!resp.ok) {
      const t = await resp.text().catch(() => "");
      throw new Error(`call-coach HTTP ${resp.status}: ${t || resp.statusText}`);
    }

    data = await resp.json().catch(() => ({}));
  } catch (e) {
    warn("call-coach request failed", e);
    statusText.textContent = "Network error. Listening again…";
    return false;
  }

  if (rolling_summary) upsertRollingSummary(user_id, device, rolling_summary).catch(() => {});

  const assistant_text = (data.assistant_text || data.text || "").toString().trim();
  if (assistant_text) addTranscriptTurn("assistant", assistant_text);

  const audio_base64 = data.audio_base64 || "";
  const outMime = data.mime || "audio/mpeg";

  if (!audio_base64) {
    statusText.textContent = "No audio returned. Listening…";
    lastAIFinishedAt = Date.now();
    armIdleAfterAI();
    return false;
  }

  const url = base64ToBlobUrl(audio_base64, outMime);

  isPlayingAI = true;
  statusText.textContent = "AI speaking…";

  try {
    await playWithBargeIn(url, { limitMs: 120000 });
  } catch (e) {
    warn("AI playback failed", e);
  } finally {
    isPlayingAI = false;
    lastAIFinishedAt = Date.now();
    armIdleAfterAI();

    try {
      URL.revokeObjectURL(url);
    } catch {}
  }

  return true;
}

/* ---------- Playback with barge-in (stop AI if user speaks) ---------- */
let bargeStream = null;
let bargeCtx = null;
let bargeSource = null;
let bargeAnalyser = null;
let bargeRAF = null;
let bargeTriggered = false;

const BARGE = {
  THRESH: 10,
  HOLD_MS: 240,
};

function startBargeInMonitor() {
  stopBargeInMonitor();

  if (!navigator.mediaDevices?.getUserMedia) return;

  navigator.mediaDevices
    .getUserMedia({ audio: true })
    .then((s) => {
      bargeStream = s;
      bargeCtx = new (window.AudioContext || window.webkitAudioContext)();
      if (bargeCtx.state === "suspended") bargeCtx.resume().catch(() => {});
      bargeSource = bargeCtx.createMediaStreamSource(s);
      bargeAnalyser = bargeCtx.createAnalyser();
      bargeAnalyser.fftSize = 2048;
      bargeAnalyser.smoothingTimeConstant = 0.7;
      bargeSource.connect(bargeAnalyser);

      const data = new Uint8Array(bargeAnalyser.fftSize);
      let above = 0;

      const loop = () => {
        if (!bargeAnalyser) return;
        bargeAnalyser.getByteTimeDomainData(data);
        let sum = 0;
        for (let i = 0; i < data.length; i++) sum += Math.abs(data[i] - 128);
        const level = sum / data.length;

        if (level > BARGE.THRESH) above += 16;
        else above = Math.max(0, above - 24);

        if (above > BARGE.HOLD_MS) {
          bargeTriggered = true;
        }

        bargeRAF = requestAnimationFrame(loop);
      };

      bargeRAF = requestAnimationFrame(loop);
    })
    .catch(() => {});
}

function stopBargeInMonitor() {
  if (bargeRAF) cancelAnimationFrame(bargeRAF);
  bargeRAF = null;

  try {
    bargeSource?.disconnect();
    bargeAnalyser?.disconnect();
  } catch {}

  if (bargeCtx && bargeCtx.state !== "closed") {
    try {
      bargeCtx.close();
    } catch {}
  }

  try {
    bargeStream?.getTracks().forEach((t) => t.stop());
  } catch {}

  bargeStream = bargeCtx = bargeSource = bargeAnalyser = null;
  bargeTriggered = false;
}

async function playWithBargeIn(src, { limitMs = 60000 } = {}) {
  bargeTriggered = false;
  startBargeInMonitor();

  return new Promise((resolve) => {
    const a = new Audio(src);
    a.preload = "auto";
    registerAudioElement(a);
    animateRingFromElement(a, "#d4a373");

    let done = false;

    const settle = (ok) => {
      if (done) return;
      done = true;
      try {
        a.pause();
      } catch {}
      stopRing();
      stopBargeInMonitor();
      resolve(ok);
    };

    a.oncanplaythrough = () => {
      try {
        a.play().catch(() => settle(false));
      } catch {
        settle(false);
      }
    };

    a.onerror = () => settle(false);
    a.onabort = () => settle(false);
    a.onended = () => settle(true);

    const t = setTimeout(() => settle(false), limitMs);

    const poll = () => {
      if (done) return;
      if (bargeTriggered) {
        clearTimeout(t);
        settle(true);
        return;
      }
      requestAnimationFrame(poll);
    };
    requestAnimationFrame(poll);
  });
}

/* ---------- Chat -> n8n ---------- */
async function sendChatToN8N(message) {
  const user_id = getUserIdForWebhook();
  const device_id = getOrCreateDeviceId();

  const typingBubble = appendMsg("ai", "…", { typing: true });

  try {
    const resp = await fetch(N8N_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        user_id,
        device_id,
        conversationId: conversationId || null,
        message,
      }),
    });

    if (!resp.ok) {
      const t = await resp.text().catch(() => "");
      throw new Error(`n8n HTTP ${resp.status}: ${t || resp.statusText}`);
    }

    const data = await resp.json().catch(() => ({}));
    const reply =
      (data.reply || data.text || data.output || "").toString().trim() ||
      "…";

    if (typingBubble) {
      typingBubble.parentElement?.classList.remove("typing");
      await typewriter(typingBubble, reply, 12);
    } else {
      appendMsg("ai", reply);
    }

    addTranscriptTurn("assistant", reply);
  } catch (e) {
    warn("sendChatToN8N failed", e);
    if (typingBubble) {
      typingBubble.parentElement?.classList.remove("typing");
      typingBubble.textContent = "Network error.";
    }
  }
}

/* ---------- Boot ---------- */
(function boot() {
  ensureTranscriptElementsExist();
  setAutoScroll(true);

  if (threadLink && conversationId) {
    threadLink.style.display = "";
  }

  prepareGreetingForNextCall();

  resetCallTimer();
  updateMicUI();
  updateSpeakerUI();
  updateModeBtnUI();

  renderDebugHud();
})();

/* ---------- Optional: expose debug helpers ---------- */
window.__SOW = {
  DG,
  stopDeepgramRecognizer,
  startDeepgramRecognizer,
  dgHudStatus,
  dgHudErr,
  dgHudMsg,
  renderDebugHud,
};
