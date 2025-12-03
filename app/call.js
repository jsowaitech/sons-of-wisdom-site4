// app/call.js
// Son of Wisdom — Call mode
// - Continuous VAD recording → Supabase (optional) + Netlify call-coach → AI audio reply
// - Web Speech API captions + optional Hume realtime (safely stubbed)
// - Dynamic AI greeting audio via Netlify function + ElevenLabs
// - Conversation threads: can title an untitled conversation from first transcript

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

/** NEW: Local hard-coded replacement for n8n voice workflow */
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

/** NEW: the current call session id (used for transcript mode) */
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

/* ---------- Helpers ---------- */
const log = (...a) => DEBUG && console.log("[SOW]", ...a);
const warn = (...a) => DEBUG && console.warn("[SOW]", ...a);
const trimText = (s, n = 360) => (s || "").trim().slice(0, n);

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

/* ---------- Greeting prefetch ---------- */
async function prepareGreetingForNextCall() {
  greetingReadyPromise = (async () => {
    try {
      const user_id = getUserIdForWebhook();
      const device = getOrCreateDeviceId();
      const payload = {
        user_id,
        device_id: device,
      };

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
        } catch (e) {
          // ignore
        }
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

  // NEW: create a call_id for this session and store it
  try {
    currentCallId = crypto.randomUUID();
  } catch {
    currentCallId = `call_${Date.now()}_${Math.random()
      .toString(36)
      .slice(2)}`;
  }
  try {
    localStorage.setItem("last_call_id", currentCallId);
  } catch (e) {
    // ignore storage errors
  }

  callBtn.classList.add("call-active");
  transcriptUI.clearAll();
  showCallView();

  try {
    statusText.textContent = "Ringing…";
    await safePlayOnce("ring.mp3", { limitMs: 15000 });
    if (!isCalling) return;

    // Ensure greeting is ready (or fetch if not)
    if (!greetingReadyPromise) {
      prepareGreetingForNextCall();
    }
    const greetingOk = await greetingReadyPromise;
    greetingReadyPromise = null; // next call will refetch

    if (!isCalling) return;

    statusText.textContent = "AI greeting you…";
    if (greetingOk && greetingAudioUrl) {
      await safePlayOnce(greetingAudioUrl, { limitMs: 60000 });
      try {
        URL.revokeObjectURL(greetingAudioUrl);
      } catch (e) {
        // ignore
      }
      greetingAudioUrl = null;
    } else {
      // Fallback to static greeting if serverless greeting failed
      await safePlayOnce("blake.mp3", { limitMs: 15000 });
    }
    if (!isCalling) return;

    // Prepare next greeting in the background
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
}

/* Small one-shot clips (ring/greeting/others) */
function safePlayOnce(src, { limitMs = 15000, color = "#d4a373" } = {}) {
  return new Promise((res) => {
    const a = new Audio(src);
    a.preload = "auto";
    registerAudioElement(a);
    animateRingFromElement(a, color);
    let done = false;
    const settle = () => {
      if (done) return;
      done = true;
      a.onended = a.onerror = a.onabort = a.oncanplaythrough = null;
      stopRing();
      res(true);
    };
    a.oncanplaythrough = () => {
      try {
        a.play().catch(() => res(false));
      } catch (e) {
        res(false);
      }
    };
    a.onerror = () => res(false);
    a.onabort = () => res(false);
    const t = setTimeout(() => res(false), limitMs);
    a.onended = () => {
      clearTimeout(t);
      settle();
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
let bargeOnInterrupt = null;

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
  bargeOnInterrupt = onInterrupt;

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
  bargeOnInterrupt = null;
}

/* Unified AI playback that supports barge-in and optional live transcription */
async function playAIWithBargeIn(
  playableUrl,
  { aiBlob = null, aiBubbleEl = null } = {}
) {
  return new Promise(async (resolve) => {
    statusText.textContent = "AI replying…";
    isPlayingAI = true;

    const a = new Audio(playableUrl);
    registerAudioElement(a);
    animateRingFromElement(a, "#d4a373");

    // live transcription webhook if configured
    if (!aiBubbleEl && inChatView) aiBubbleEl = appendMsg("ai", "", { typing: true });
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

/* ---------- Voice path: upload → Supabase (optional) → call-coach (transcript only) ---------- */
const RECENT_USER_KEEP = 12;
let recentUserTurns = [];

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
    // Title the conversation on first meaningful utterance if still untitled
    maybeUpdateConversationTitleFromTranscript(combinedTranscript).catch(() => {});
  }

  const user_id = getUserIdForWebhook();
  const device = getOrCreateDeviceId();

  // NEW: ensure we always have a call_id and keep it persisted
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

  // upload to storage (OPTIONAL)
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
      call_id: currentCallId, // NEW: attach call_id so transcript mode can follow
      transcript: transcriptForModel,
      has_transcript: !!transcriptForModel,
      history_user_last3: recentUserTurns.slice(-3),
      rolling_summary: rollingSummary || undefined,
      executionMode: "production",
      source: "voice",
      audio_uploaded: uploaded,
    };

    const resp = await fetch(CALL_COACH_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    const ct = (resp.headers.get("content-type") || "").toLowerCase();

    // progressive stream first (kept for compatibility; call-coach currently returns JSON)
    if (
      ENABLE_STREAMED_PLAYBACK &&
      ct.includes("audio/webm") &&
      resp.body?.getReader
    ) {
      const ok = await playStreamedWebmOpus(resp.clone());
      if (ok) {
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
      aiTextFromJSON =
        data?.text ?? data?.transcript ?? data?.message ?? "";
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
    warn("webhook failed", e);
    statusText.textContent = "AI processing failed.";
    return false;
  }

  if (!isCalling) return false;
  if (!aiPlayableUrl) {
    statusText.textContent = "AI processing failed (no audio).";
    return false;
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
          }
          if (evt.text && evt.done) {
            if (aiBubbleEl) aiBubbleEl.textContent = evt.text;
            return true;
          }
        } catch (e) {
          // ignore
        }
      }
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
  const rollingSummary = buildRollingSummary(prevSummary, historyPairs, userText);
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
prepareGreetingForNextCall();
log("[SOW] call.js ready");
