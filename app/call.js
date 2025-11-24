// app/call.js
// Son of Wisdom — Call mode
// Continuous VAD recording → (optional) Supabase storage + n8n → AI audio reply
// Web Speech API captions + optional Hume realtime (safely stubbed)

/* ---------- CONFIG ---------- */
const DEBUG = true;

/* Optional: Hume realtime SDK (safe stub if not loaded) */
const HumeRealtime = window.HumeRealtime ?? {
  init() {},
  startTurn() {},
  handleRecorderChunk() {},
  stopTurn() {},
};
// disabled by default – turn on inside your Hume dashboard if needed
HumeRealtime.init?.({ enable: false });

/** Supabase
 *  - In dev: inject SERVICE_ROLE via dev-local.js → window.SUPABASE_SERVICE_ROLE_KEY
 *  - In prod: this will be empty string; Supabase features become no-ops
 *    but n8n still works.
 */
const SUPABASE_URL = "https://plrobtlpedniyvkpwdmp.supabase.co";

// ❗ DO NOT hardcode any key here; dev-local.js can set window.SUPABASE_SERVICE_ROLE_KEY locally.
const SUPABASE_SERVICE_ROLE_KEY = window.SUPABASE_SERVICE_ROLE_KEY || "";

const SUPABASE_BUCKET = "audiossow";
const RECORDINGS_FOLDER = "recordings";

/* Supabase REST (history/summary) */
const SUPABASE_REST = `${SUPABASE_URL}/rest/v1`;
const HISTORY_TABLE = "call_sessions";
const HISTORY_USER_COL = "user_id_uuid";
const HISTORY_SELECT = "input_transcript,ai_text,timestamp";
const HISTORY_TIME_COL = "timestamp";

/* Dev override (for manual testing) */
const USER_UUID_OVERRIDE = null;

/* n8n webhooks */
const N8N_WEBHOOK_URL =
  "https://jsonofwisdom.app.n8n.cloud/webhook/4877ebea-544b-42b4-96d6-df41c58d48b0";

/* Optional: AI-transcript webhook (leave empty to disable) */
const N8N_TRANSCRIBE_URL = "";

/* I/O */
const ENABLE_MEDIARECORDER_64KBPS = true;
const TIMESLICE_MS = 100;
const ENABLE_STREAMED_PLAYBACK = true;

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

// Transcript (call view)
const transcriptList = document.getElementById("transcript-list");
const transcriptInterim = document.getElementById("transcript-interim");

// Chat (created lazily)
let chatPanel = document.getElementById("chat-panel");
let chatLog;
let chatForm;
let chatInput;

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

/* ---------- Helpers ---------- */
const log = (...a) => DEBUG && console.log("[SOW]", ...a);
const warn = (...a) => DEBUG && console.warn("[SOW]", ...a);
const trimText = (s, n = 360) => (s || "").trim().slice(0, n);
const hasSupabaseServiceKey = () => !!SUPABASE_SERVICE_ROLE_KEY;

/* ---------- History / Summary (Supabase via REST) ----------
 * NOTE: These are BEST-EFFORT ONLY.
 * If there is no service key (e.g., on production Netlify),
 * they quietly no-op and never block the n8n call.
 */

async function fetchLastPairsFromSupabase(user_id, { pairs = 8 } = {}) {
  if (!hasSupabaseServiceKey()) return { text: "", pairs: [] };

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
    warn("fetchLastPairsFromSupabase error", e);
    return { text: "", pairs: [] };
  }
}

const SUMMARY_TABLE = "history_summaries";
const SUMMARY_MAX_CHARS = 380;

async function fetchRollingSummary(user_id, device) {
  if (!hasSupabaseServiceKey()) return "";

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
    warn("fetchRollingSummary error", e);
    return "";
  }
}

async function upsertRollingSummary(user_id, device, summary) {
  if (!hasSupabaseServiceKey() || !summary) return;

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
    warn("upsertRollingSummary error", e);
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

/* ---------- Supabase: best-effort audio upload ---------- */
/**
 * Uploads the recorded blob to Supabase Storage IF a service key is available.
 * Never throws; always returns an object { filePath, publicUrl } or null.
 */
async function uploadAudioToSupabase({ device, blob, mimeType }) {
  if (!hasSupabaseServiceKey()) {
    log("Supabase upload skipped (no service key present).");
    return null;
  }

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

    if (!upRes.ok) {
      warn("Supabase upload failed:", upRes.status, await upRes.text().catch(() => ""));
      return null;
    }

    const publicUrl = `${SUPABASE_URL}/storage/v1/object/public/${encodeURIComponent(
      SUPABASE_BUCKET
    )}/${filePath}`;

    log("Supabase upload ok:", filePath);
    return { filePath, publicUrl };
  } catch (e) {
    warn("uploadAudioToSupabase error", e);
    return null;
  }
}

/* ---------- UI: Chat ---------- */
function ensureChatUI() {
  if (!chatPanel) {
    chatPanel = document.createElement("div");
    chatPanel.id = "chat-panel";
    chatPanel.innerHTML = `
      <div id="chat-log" class="chat-log"></div>
      <form id="chat-form" class="chat-input-row">
        <input id="chat-input" type="text" placeholder="Type a message..." autocomplete="off"/>
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
      await sendChatToN8N(txt);
    });
    chatForm._wired = true;
  }
}
ensureChatUI();

function showChatView() {
  inChatView = true;
  if (chatPanel) chatPanel.style.display = "block";
  if (statusText) statusText.textContent = "Chat view on. Call continues in background.";
  updateModeBtnUI();
}

function showCallView() {
  inChatView = false;
  if (chatPanel) chatPanel.style.display = "none";
  if (statusText) {
    statusText.textContent = isCalling
      ? "Call view on."
      : "Tap the blue call button to begin.";
  }
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
      warn("animateRingFromElement connect error", e);
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
    modeBtn.setAttribute("aria-pressed", String(inChatView));
    modeBtn.title = inChatView ? "Switch to Call view" : "Switch to Chat view";
  }
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
  if (statusText)
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
      if (statusText) statusText.textContent = "Speaker output active.";
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

/* ---------- Call flow ---------- */
async function startCall() {
  if (isCalling) return;
  isCalling = true;
  callBtn?.classList.add("call-active");
  transcriptUI.clearAll();
  showCallView();

  try {
    if (statusText) statusText.textContent = "Ringing…";
    await safePlayOnce("ring.mp3", { limitMs: 15000 });
    if (!isCalling) return;

    if (statusText) statusText.textContent = "AI is greeting you…";
    await safePlayOnce("blake.mp3", { limitMs: 15000 });
    if (!isCalling) return;

    await startRecordingLoop();
  } catch (e) {
    warn("startCall error", e);
    if (statusText) statusText.textContent = "Audio blocked or missing. Tap again.";
  }
}

function endCall() {
  isCalling = false;
  isRecording = false;
  isPlayingAI = false;
  callBtn?.classList.remove("call-active");
  if (statusText) statusText.textContent = "Call ended.";
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

/* Small one-shot clips (ring/greeting) */
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
    if (statusText) {
      statusText.textContent = played ? "Your turn…" : "Listening again…";
    }
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
    if (statusText)
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
            warn("barge onInterrupt error", e);
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
async function playAIWithBargeIn(playableUrl, { aiBlob = null, aiBubbleEl = null } = {}) {
  return new Promise(async (resolve) => {
    if (statusText) statusText.textContent = "AI replying…";
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
        if (statusText) statusText.textContent = "Go ahead…";
        cleanup();
      });
    }

    try {
      await a.play();
    } catch (e) {
      warn("playAIWithBargeIn play error", e);
    }
    a.onended = () => cleanup();
  });
}

/* ---------- Voice path: upload → n8n → play AI ----------
 * Key design:
 *   - Audio is uploaded to Supabase (dev) BEST-EFFORT.
 *   - n8n only receives transcript + metadata (NO audio file).
 *   - If Supabase fails, n8n is still called.
 */

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
  }

  const user_id = getUserIdForWebhook();
  const device = getOrCreateDeviceId();
  const mimeType = mediaRecorder?.mimeType || "audio/webm";
  const blob = new Blob(recordChunks, { type: mimeType });

  if (!blob.size || !isCalling) {
    if (statusText) statusText.textContent = "No audio captured.";
    return false;
  }

  if (statusText) statusText.textContent = "Thinking…";

  // history/summary (best-effort)
  let historyPairsText = "";
  let historyPairs = [];
  try {
    const hist = await fetchLastPairsFromSupabase(user_id, { pairs: 8 });
    historyPairsText = hist.text || "";
    historyPairs = hist.pairs || [];
  } catch (e) {
    // already logged inside helpers
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

  // Upload audio to Supabase (dev-only, never required for n8n)
  let supaUpload = null;
  try {
    supaUpload = await uploadAudioToSupabase({ device, blob, mimeType });
  } catch (e) {
    // errors already logged, and do NOT block.
  }

  // n8n call — always JSON, NEVER sending audio blob.
  let aiPlayableUrl = null;
  let revokeLater = null;
  let aiBlob = null;
  let aiTextFromJSON = "";

  try {
    const body = {
      user_id,
      transcript: transcriptForModel,
      has_transcript: !!transcriptForModel,
      history_user_last3: recentUserTurns.slice(-3),
      rolling_summary: rollingSummary || undefined,
      executionMode: "production",
      source: "voice",
    };

    if (supaUpload?.publicUrl) {
      body.audio_public_url = supaUpload.publicUrl;
      body.audio_path = supaUpload.filePath;
    }

    const resp = await fetch(N8N_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    const ct = (resp.headers.get("content-type") || "").toLowerCase();

    // progressive stream first (webm/opus)
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
    if (statusText) statusText.textContent = "AI processing failed.";
    return false;
  }

  if (!isCalling) return false;
  if (!aiPlayableUrl) {
    if (statusText) statusText.textContent = "AI processing failed (no audio).";
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
          // ignore malformed SSE chunks
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
    warn("liveTranscribeBlob fallback error", e);
  }
}

async function blobToFormData(blob, field = "file", filename = "audio.mp3") {
  const fd = new FormData();
  fd.append(field, blob, filename);
  return fd;
}

/* ---------- Chat path (text → n8n) ----------
 * Already JSON-only; no audio uploaded here.
 */
async function sendChatToN8N(userText) {
  const user_id = getUserIdForWebhook();
  const device = getOrCreateDeviceId();

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
  } catch (e) {
    // already logged
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
            warn("SourceBuffer append error", e);
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
          warn("playStreamedWebmOpus play error", e);
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
    warn("playStreamedWebmOpus error", e);
    return null;
  }
}

/* ---------- Boot ---------- */
updateMicUI();
updateSpeakerUI();
updateModeBtnUI();
showCallView();
