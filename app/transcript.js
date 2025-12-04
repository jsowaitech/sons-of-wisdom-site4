// app/transcript.js
// Live transcription viewer for Son of Wisdom calls.
// - Reads call_sessions from Supabase for a given call_id
// - Renders separate bubbles for user + AI
// - Streams new inserts via Realtime
// - When embedded (?embed=1), hides call-id footer controls
//   and tweaks layout so it fits inside the call page panel.

import { supabase } from "./supabase.js";

const params = new URLSearchParams(window.location.search);
const isEmbed = params.get("embed") === "1";

const els = {
  list: document.getElementById("turnList"),
  callIdLabel: document.getElementById("callIdLabel"),
  callIdInput: document.getElementById("callIdInput"),
  watchBtn: document.getElementById("watchBtn"),
  copyBtn: document.getElementById("copyBtn"),
  downloadBtn: document.getElementById("downloadBtn"),
  liveBadge: document.getElementById("liveBadge"),
  footer: document.querySelector(".ts-footer"),
  autoScrollBtn: document.getElementById("autoScrollBtn"),
  closeBtn: document.getElementById("closeBtn"),
};

let autoScrollEnabled = true;
let currentCallId = "";
let realtimeChannel = null;
const cache = []; // { role, text, ts }

// ---------- Helpers ----------

function fmtTime(input) {
  if (!input) return "";
  const d = typeof input === "string" ? new Date(input) : input;
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function scrollToBottom() {
  if (!els.list || !autoScrollEnabled) return;
  els.list.scrollTop = els.list.scrollHeight;
}

function setLive(isLive) {
  if (!els.liveBadge) return;
  els.liveBadge.textContent = isLive ? "LIVE" : "OFFLINE";
  els.liveBadge.classList.toggle("is-live", isLive);
}

function clearUI() {
  if (els.list) els.list.innerHTML = "";
  cache.length = 0;
}

function updateAutoScrollUI() {
  if (!els.autoScrollBtn) return;
  els.autoScrollBtn.classList.toggle("on", autoScrollEnabled);
  els.autoScrollBtn.textContent = autoScrollEnabled
    ? "Auto scroll"
    : "Scroll locked";
}

// Type-out effect for new text
function typeIntoElement(el, fullText) {
  const text = (fullText || "").toString();
  if (!el) return;

  if (!text.length) {
    el.textContent = "";
    return;
  }

  // Speed heuristic: shorter text → slightly slower; longer text → faster
  const minDelay = 8;
  const maxDelay = 24;
  const delay = Math.max(minDelay, Math.min(maxDelay, 1200 / text.length));

  let idx = 0;
  function step() {
    if (idx > text.length) return;
    el.textContent = text.slice(0, idx);
    if (autoScrollEnabled) scrollToBottom();
    if (idx < text.length) {
      idx += 1;
      window.setTimeout(step, delay);
    }
  }
  step();
}

function appendTurn(role, text, ts, { animate = false } = {}) {
  const trimmed = (text || "").trim();
  if (!trimmed) return;
  if (!els.list) return;

  const article = document.createElement("article");
  article.className = `turn ${role}`;

  const bubble = document.createElement("div");
  bubble.className = "bubble";

  const meta = document.createElement("div");
  meta.className = "meta";

  const whoSpan = document.createElement("span");
  whoSpan.className = "role";
  whoSpan.textContent = role === "assistant" ? "Blake" : "You";

  const timeSpan = document.createElement("span");
  timeSpan.className = "time";
  timeSpan.textContent = fmtTime(ts);

  meta.appendChild(whoSpan);
  meta.appendChild(timeSpan);

  const textEl = document.createElement("div");
  textEl.className = "text";

  bubble.appendChild(meta);
  bubble.appendChild(textEl);
  article.appendChild(bubble);
  els.list.appendChild(article);

  cache.push({
    role,
    text: trimmed,
    ts: ts instanceof Date ? ts.toISOString() : ts,
  });

  if (animate) typeIntoElement(textEl, trimmed);
  else textEl.textContent = trimmed;

  if (autoScrollEnabled) scrollToBottom();
}

function handleRow(row, { animate = false } = {}) {
  if (!row) return;
  const ts = row.timestamp || row.created_at || new Date().toISOString();

  if (row.input_transcript) {
    appendTurn("user", row.input_transcript, ts, { animate });
  }
  if (row.ai_text) {
    appendTurn("assistant", row.ai_text, ts, { animate });
  }
}

// ---------- Data: initial load + realtime ----------

async function loadInitial(callId) {
  clearUI();
  setLive(false);

  if (!callId) return;

  const { data, error } = await supabase
    .from("call_sessions")
    .select("input_transcript, ai_text, timestamp, created_at")
    .eq("call_id", callId)
    .order("timestamp", { ascending: true });

  if (error) {
    console.warn("[transcript] error loading call_sessions:", error);
    appendTurn(
      "assistant",
      "I wasn't able to load the transcript for this call yet.",
      new Date(),
      { animate: false }
    );
    return;
  }

  (data || []).forEach((row) => handleRow(row, { animate: false }));
  scrollToBottom();
}

function subscribeRealtime(callId) {
  if (realtimeChannel) {
    realtimeChannel.unsubscribe();
    realtimeChannel = null;
  }

  if (!callId) {
    setLive(false);
    return;
  }

  realtimeChannel = supabase
    .channel(`call_sessions_${callId}`)
    .on(
      "postgres_changes",
      {
        event: "INSERT",
        schema: "public",
        table: "call_sessions",
        filter: `call_id=eq.${callId}`,
      },
      (payload) => {
        handleRow(payload.new, { animate: true });
      }
    )
    .subscribe((status) => {
      setLive(status === "SUBSCRIBED");
    });
}

async function watchCallId(callId) {
  currentCallId = callId || "";
  if (els.callIdInput) els.callIdInput.value = currentCallId;
  if (els.callIdLabel) els.callIdLabel.textContent = currentCallId || "–";

  await loadInitial(currentCallId);
  subscribeRealtime(currentCallId);
}

// ---------- UX helpers ----------

function chooseStartCallId() {
  const fromQuery = params.get("call_id") || params.get("callId");
  if (fromQuery) return fromQuery;

  // When embedded inside call.html, prefer the last_call_id from localStorage
  if (isEmbed) {
    const stored = window.localStorage.getItem("last_call_id");
    if (stored) return stored;
  }

  // Standalone page: prefer the input field, then last_call_id.
  if (els.callIdInput && els.callIdInput.value.trim()) {
    return els.callIdInput.value.trim();
  }

  const stored = window.localStorage.getItem("last_call_id");
  return stored || "";
}

// ---------- Event wiring ----------

if (els.watchBtn) {
  els.watchBtn.addEventListener("click", (e) => {
    e.preventDefault();
    const id = (els.callIdInput?.value || "").trim();
    if (!id) return;
    watchCallId(id);
  });
}

if (els.autoScrollBtn) {
  els.autoScrollBtn.addEventListener("click", () => {
    autoScrollEnabled = !autoScrollEnabled;
    updateAutoScrollUI();
    if (autoScrollEnabled) scrollToBottom();
  });
}

if (els.copyBtn) {
  els.copyBtn.addEventListener("click", () => {
    if (!cache.length) return;
    const text = cache
      .map((t) => {
        const who = t.role === "assistant" ? "Blake" : "You";
        return `[${fmtTime(t.ts)}] ${who}: ${t.text}`;
      })
      .join("\n");
    if (!text) return;
    window.navigator.clipboard?.writeText(text).catch(() => {});
  });
}

if (els.downloadBtn) {
  els.downloadBtn.addEventListener("click", () => {
    if (!cache.length) return;
    const blob = new Blob([JSON.stringify(cache, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `sow-transcript-${currentCallId || "call"}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  });
}

if (els.closeBtn) {
  els.closeBtn.addEventListener("click", (e) => {
    e.preventDefault();
    if (!isEmbed && window.close) {
      window.close();
    } else {
      // In embed mode, let the parent decide what to do (no-op if ignored).
      window.parent?.postMessage?.({ type: "sow-close-transcript" }, "*");
    }
  });
}

// ---------- Boot ----------

if (isEmbed) {
  // Mark that transcript.html is inside the call page panel
  document.body.classList.add("embed");

  // Hide the Call ID input/footer for embed mode
  if (els.footer) {
    els.footer.style.display = "none";
  }
}

updateAutoScrollUI();

const startId = chooseStartCallId();
if (startId) {
  watchCallId(startId);
} else {
  clearUI();
  setLive(false);
}
