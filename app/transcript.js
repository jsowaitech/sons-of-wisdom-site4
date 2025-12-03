// app/transcript.js
import { supabase } from "./supabase.js";

const params = new URLSearchParams(location.search);
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
};

let currentCallId = null;
let channel = null;
let cache = []; // for copy/download

function getParam(name) {
  const u = new URL(location.href);
  return u.searchParams.get(name);
}

function fmtTime(iso) {
  try {
    const d = new Date(iso || Date.now());
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  } catch {
    return "";
  }
}

function setCallId(id) {
  currentCallId = id;
  els.callIdLabel.textContent = `call_id: ${id || "—"}`;
  if (els.callIdInput) els.callIdInput.value = id || "";
  if (id) {
    try {
      localStorage.setItem("last_call_id", id);
    } catch (e) {
      // ignore
    }
  }
}

// NEW: turn one DB row into up to 2 renderables (You + AI)
function rowToRenderables(r) {
  const ts =
    r.created_at || r.timestamp || r.inserted_at || new Date().toISOString();
  const baseId = r.id || (globalThis.crypto?.randomUUID?.() || String(ts));

  const userText = r.input_transcript || r.input_text || "";
  const aiText = r.ai_text || "";

  const audioUser = r.audio_url || "";
  const audioAI = r.ai_audio_url || r.audio_mp3_url || "";

  const out = [];

  if (userText && String(userText).trim()) {
    out.push({
      id: `${baseId}-u`,
      role: "user",
      text: String(userText),
      audio: audioUser,
      ts,
    });
  }

  if (aiText && String(aiText).trim()) {
    out.push({
      id: `${baseId}-a`,
      role: "assistant",
      text: String(aiText),
      audio: audioAI,
      ts,
    });
  }

  // If there was no split and we somehow have neither, fallback to a generic row
  if (!out.length) {
    out.push({
      id: baseId,
      role: r.role === "assistant" ? "assistant" : "user",
      text:
        r.role === "assistant"
          ? aiText
          : userText || r.text || r.message || "",
      audio: audioUser || audioAI || "",
      ts,
    });
  }

  return out;
}

function appendTurn(renderable, { scroll = true } = {}) {
  cache.push(renderable);

  const row = document.createElement("div");
  row.className = `turn ${renderable.role}`;
  row.innerHTML = `
    <div class="bubble">
      <div class="meta">
        <span class="role">${
          renderable.role === "assistant" ? "AI" : "You"
        }</span>
        <span class="time">${fmtTime(renderable.ts)}</span>
      </div>
      <div class="text">${escapeHTML(renderable.text || "")}</div>
      ${
        renderable.audio
          ? `<audio controls preload="none" src="${renderable.audio}"></audio>`
          : ""
      }
    </div>
  `;
  els.list.appendChild(row);
  if (scroll) els.list.scrollTop = els.list.scrollHeight;
}

function escapeHTML(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

async function loadInitial(callId) {
  els.list.innerHTML = "";
  cache = [];
  if (!callId) return;

  const { data, error } = await supabase
    .from("call_sessions")
    .select("*")
    .eq("call_id", callId)
    .order("timestamp", { ascending: true });

  if (error) {
    console.warn("[transcript] initial load error:", error);
    return;
  }

  (data || [])
    .flatMap(rowToRenderables)
    .forEach((r) => appendTurn(r, { scroll: false }));
  els.list.scrollTop = els.list.scrollHeight;
}

function subscribe(callId) {
  if (channel) {
    try {
      supabase.removeChannel(channel);
    } catch {}
    channel = null;
  }
  if (!callId) return;

  channel = supabase
    .channel(`call_sessions_${callId}`)
    .on(
      "postgres_changes",
      {
        event: "*",
        schema: "public",
        table: "call_sessions",
        filter: `call_id=eq.${callId}`,
      },
      (payload) => {
        if (payload.eventType === "INSERT") {
          const news = rowToRenderables(payload.new || {});
          news.forEach((r) => appendTurn(r));
        } else if (payload.eventType === "UPDATE") {
          // Optional: update existing bubbles, currently ignored
        } else if (payload.eventType === "DELETE") {
          // Optional: remove bubbles, currently ignored
        }
      }
    )
    .subscribe((status) => {
      if (els.liveBadge) {
        els.liveBadge.classList.toggle("is-live", status === "SUBSCRIBED");
      }
    });
}

// NEW: embed-mode prefers last_call_id and hides footer input
function chooseStartCallId() {
  if (isEmbed) {
    const fromStorage = (() => {
      try {
        return localStorage.getItem("last_call_id") || "";
      } catch {
        return "";
      }
    })();
    return (
      fromStorage ||
      getParam("call_id") ||
      (els.callIdInput ? els.callIdInput.value.trim() : "") ||
      ""
    );
  }

  // Standalone mode: ?call_id > input > localStorage
  return (
    getParam("call_id") ||
    (els.callIdInput ? els.callIdInput.value.trim() : "") ||
    (() => {
      try {
        return localStorage.getItem("last_call_id") || "";
      } catch {
        return "";
      }
    })()
  );
}

async function watch(callId) {
  setCallId(callId);
  await loadInitial(callId);
  subscribe(callId);
}

function copyAll() {
  const text = cache
    .map((t) => {
      const who = t.role === "assistant" ? "AI" : "You";
      return `[${fmtTime(t.ts)}] ${who}: ${t.text}`;
    })
    .join("\n");
  if (!text) return;
  navigator.clipboard.writeText(text).catch(() => {});
}

function downloadAll() {
  const blob = new Blob([JSON.stringify(cache, null, 2)], {
    type: "application/json",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${currentCallId || "transcript"}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/* ---------- UI events ---------- */
if (els.watchBtn && !isEmbed) {
  els.watchBtn.addEventListener("click", () => {
    const id = els.callIdInput?.value.trim();
    if (id) watch(id);
  });
}

if (els.copyBtn) els.copyBtn.addEventListener("click", copyAll);
if (els.downloadBtn) els.downloadBtn.addEventListener("click", downloadAll);

/* ---------- Boot ---------- */
if (isEmbed && els.footer) {
  // For embed mode (inside the call page), hide the Call ID input/footer.
  els.footer.style.display = "none";
}

const startId = chooseStartCallId();
if (startId) watch(startId);
else setCallId("");
