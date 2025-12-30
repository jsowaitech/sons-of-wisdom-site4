// app/home.js
// Home (chat) page controller — desktop & mobile friendly
// Wired to Supabase conversation threads + Netlify function (call-coach) with memory.
//
// ✅ FIXES (already present):
// 1) Hamburger reliably appears
// 2) Hamburger goes to history.html with returnTo + c (so back button works)
// 3) Uses correct query param (history.js expects returnTo)
//
// ✅ NEW (Audio playback in Home chat, iOS Safari-safe):
// - Shared persistent audio element (ttsPlayer)
// - unlockAudioSystem() runs on a user gesture (Send click + Speak click)
// - Plays assistant voice when server returns audio_base64 + mime
// - Optional "Voice Replies" toggle (defaults ON)
// - Optional "Tap to play" fallback button if autoplay is blocked

sessionStorage.removeItem("sow_redirected");

import { supabase, ensureAuthedOrRedirect, getSession } from "./supabase.js";

/* -------------------------- tiny DOM helpers -------------------------- */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));

/* ------------------------------ config -------------------------------- */
// ✅ use unified endpoint
const CHAT_URL = "/.netlify/functions/call-coach";

// DEV toggle: call OpenAI directly from the browser (no server).
// ⚠️ For development ONLY — never enable this on production.
const DEV_DIRECT_OPENAI = false;

const DEV_OPENAI_MODEL = window.OPENAI_MODEL || "gpt-4o-mini";
const DEV_OPENAI_KEY = window.OPENAI_DEV_KEY || "";

// System prompt for DEV_DIRECT_OPENAI only (server has its own prompt)
const DEV_SYSTEM_PROMPT = `
AI BLAKE – SON OF WISDOM COACH
TTS-SAFE • CONVERSATIONAL • DIAGNOSTIC-FIRST • SHORT RESPONSES • VARIATION • NO DEEP-DIVE

YOU ARE: AI BLAKE
`.trim();

/* ------------------------------ state -------------------------------- */
let session = null;
let sending = false;
let conversationId = null; // Supabase conversations.id

// audio-recording state (for Speak button)
let recording = false;
let mediaStream = null;
let mediaRecorder = null;
let mediaChunks = [];
let chosenMime = { mime: "audio/webm;codecs=opus", ext: "webm" };

/* ------------------------------ UI refs ------------------------------- */
const refs = {
  chipsRow: $(".simple-chips"),
  chips: $$(".chip"),
  status: $("#status"),
  input: $("#q"),
  sendBtn: $("#btn-send"),
  callBtn: $("#btn-call"),
  filesBtn: $("#btn-files"),
  speakBtn: $("#btn-speak"),
  chatBox: $("#chat-box"),
  logoutBtn: $("#btn-logout"),
  hamburger: $("#btn-menu"),
};

/* =========================================================
   ✅ iOS Safari-safe audio playback (Home)
   ========================================================= */

const IS_IOS =
  /iPad|iPhone|iPod/i.test(navigator.userAgent || "") ||
  (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);

let ttsPlayer = null;
let audioUnlocked = false;
let voiceRepliesEnabled = true; // default ON

function ensureSharedAudio() {
  if (ttsPlayer) return ttsPlayer;
  ttsPlayer = new Audio();
  ttsPlayer.preload = "auto";
  ttsPlayer.playsInline = true;
  ttsPlayer.crossOrigin = "anonymous";
  ttsPlayer.muted = false;
  ttsPlayer.volume = 1;
  return ttsPlayer;
}

// Must be called on a user gesture (click/tap) on iOS
async function unlockAudioSystem() {
  try {
    ensureSharedAudio();

    // iOS "silent unlock" trick
    if (IS_IOS && !audioUnlocked) {
      const a = ensureSharedAudio();
      a.src =
        "data:audio/mp3;base64,//uQxAAAAAAAAAAAAAAAAAAAAAAAWGluZwAAAA8AAAACAAACcQCA" +
        "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
      a.volume = 0;
      await a.play().catch(() => {});
      a.pause();
      a.currentTime = 0;
      a.volume = 1;
      audioUnlocked = true;
    } else {
      audioUnlocked = true;
    }
  } catch (e) {
    // ignore
  }
}

function base64ToBlobUrl(b64, mime = "audio/mpeg") {
  const raw = b64.includes(",") ? b64.split(",").pop() : b64;
  const bytes = Uint8Array.from(atob(raw), (c) => c.charCodeAt(0));
  const blob = new Blob([bytes], { type: mime || "audio/mpeg" });
  const url = URL.createObjectURL(blob);
  return { url, blob };
}

async function playAudioUrl(url) {
  const a = ensureSharedAudio();
  try {
    a.pause();
  } catch {}
  a.src = url;
  a.preload = "auto";
  try {
    const p = a.play();
    if (p?.catch) await p.catch(() => false);
    return true;
  } catch {
    return false;
  }
}

/* Render a message bubble + optional "Play" fallback button */
function appendBubble(role, text, { audio } = {}) {
  if (!refs.chatBox) return null;

  const wrap = document.createElement("div");
  wrap.className = `bubble ${role}`;

  const msg = document.createElement("div");
  msg.className = "bubble-text";
  msg.textContent = text || "";
  wrap.appendChild(msg);

  // Optional: add playback control (useful if autoplay is blocked)
  if (audio?.url) {
    const row = document.createElement("div");
    row.className = "bubble-audio-row";

    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "bubble-audio-btn";
    btn.textContent = "Play voice";
    btn.addEventListener("click", async () => {
      await unlockAudioSystem();
      await playAudioUrl(audio.url);
    });

    row.appendChild(btn);
    wrap.appendChild(row);
  }

  refs.chatBox.appendChild(wrap);
  ensureChatScroll();
  return { wrap, msg };
}

/* Add a tiny "Voice replies" toggle below status (no HTML changes required) */
function ensureVoiceToggle() {
  if (!refs.status) return;
  if ($("#voice-toggle")) return;

  const row = document.createElement("div");
  row.id = "voice-toggle";
  row.style.display = "flex";
  row.style.alignItems = "center";
  row.style.gap = "10px";
  row.style.marginTop = "10px";
  row.style.opacity = "0.95";

  const label = document.createElement("label");
  label.style.display = "flex";
  label.style.alignItems = "center";
  label.style.gap = "8px";
  label.style.cursor = "pointer";

  const cb = document.createElement("input");
  cb.type = "checkbox";
  cb.checked = true;
  cb.addEventListener("change", () => {
    voiceRepliesEnabled = cb.checked;
  });

  const txt = document.createElement("span");
  txt.textContent = "Voice replies";

  label.appendChild(cb);
  label.appendChild(txt);
  row.appendChild(label);

  refs.status.insertAdjacentElement("afterend", row);
}

/* ---------------------------- utilities ------------------------------- */
function setStatus(msg, isError = false) {
  if (!refs.status) return;
  refs.status.textContent = msg || "";
  refs.status.style.color = isError ? "#ffb3b3" : "var(--text-soft)";
}

function setSendingState(v) {
  sending = !!v;
  if (refs.sendBtn) {
    refs.sendBtn.disabled = sending;
    refs.sendBtn.textContent = sending ? "Sending…" : "Send";
  }
  if (refs.input && !recording) refs.input.disabled = sending;
}

/* bubbles */
function ensureChatScroll() {
  if (!refs.chatBox) return;
  const scroller = refs.chatBox.parentElement || refs.chatBox;
  scroller.scrollTo({ top: scroller.scrollHeight, behavior: "smooth" });
}

/* -------- load previous messages for this conversation --------- */
async function loadConversationHistory(convId) {
  if (!convId || !refs.chatBox) return;
  try {
    setStatus("Loading conversation…");

    const { data, error } = await supabase
      .from("conversation_messages")
      .select("role, content, created_at")
      .eq("conversation_id", convId)
      .order("created_at", { ascending: true });

    if (error) {
      console.error("[HOME] loadConversationHistory error:", error);
      setStatus("Could not load previous messages.", true);
      return;
    }

    refs.chatBox.innerHTML = "";

    (data || []).forEach((row) => {
      const bubbleRole = row.role === "assistant" ? "ai" : "user";
      appendBubble(bubbleRole, row.content || "");
    });
  } catch (err) {
    console.error("[HOME] loadConversationHistory failed:", err);
    setStatus("Could not load previous messages.", true);
  }
}

/* ---------------------------- networking ------------------------------ */
/**
 * Unified coach endpoint request.
 * We send both transcript + utterance for compatibility with your function.
 */
async function coachRequest({ text, source = "chat", wantAudio = false, extra = {} }) {
  if (DEV_DIRECT_OPENAI) {
    // dev mode returns text only
    const reply = await chatDirectOpenAI(text, extra);
    return { assistant_text: reply, audio_base64: null, mime: null };
  }

  const payload = {
    source,
    conversationId: conversationId || null,
    transcript: text,
    utterance: text,
    user_turn: text,
    // optional identifiers; safe if missing
    user_id: session?.user?.id || session?.user?.email || "",
    device_id: localStorage.getItem("sow_device_id") || "",
    // you can ignore on server if you want
    want_audio: !!wantAudio,
    ...extra,
  };

  const res = await fetch(CHAT_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`Coach ${res.status}: ${t || res.statusText}`);
  }

  const data = await res.json().catch(() => ({}));
  // normalize
  return {
    assistant_text: data.assistant_text ?? data.text ?? data.reply ?? "",
    audio_base64: data.audio_base64 ?? null,
    mime: data.mime ?? data.audio_mime ?? "audio/mpeg",
  };
}

async function chatDirectOpenAI(text, meta = {}) {
  const key = (DEV_OPENAI_KEY || "").trim();
  if (!key) {
    throw new Error(
      "Missing OpenAI key. For dev-only browser calls, set window.OPENAI_DEV_KEY in app/dev-local.js."
    );
  }

  const systemPrompt = meta.system || DEV_SYSTEM_PROMPT;
  const history = Array.isArray(meta.history) ? meta.history : [];
  const messages = [
    { role: "system", content: systemPrompt },
    ...history.map((m) => ({ role: m.role, content: m.content })),
    { role: "user", content: text },
  ];

  const body = { model: DEV_OPENAI_MODEL, messages, temperature: 0.7 };

  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`OpenAI ${res.status}: ${errText || "Request failed"}`);
  }

  const data = await res.json();
  const reply = data?.choices?.[0]?.message?.content?.trim() || "";
  return reply;
}

/* ------------------------------ actions ------------------------------- */
async function handleSend() {
  if (!refs.input) return;
  const text = refs.input.value.trim();
  if (!text || sending) return;

  // ✅ iOS unlock must be on gesture; Send is a gesture.
  await unlockAudioSystem();

  appendBubble("user", text);
  setSendingState(true);
  setStatus("Thinking…");

  let audioUrlToRevoke = null;

  try {
    const wantAudio = !!voiceRepliesEnabled;
    const { assistant_text, audio_base64, mime } = await coachRequest({
      text,
      source: wantAudio ? "voice" : "chat",
      wantAudio,
      extra: {
        email: session?.user?.email ?? null,
        page: "home",
        timestamp: new Date().toISOString(),
      },
    });

    // Build audio URL if returned
    let audio = null;
    if (audio_base64 && wantAudio) {
      const { url } = base64ToBlobUrl(audio_base64, mime || "audio/mpeg");
      audio = { url, mime };
      audioUrlToRevoke = url;
    }

    // Append assistant bubble (with optional Play button)
    appendBubble("ai", assistant_text || "…", { audio });

    // Try to autoplay (best effort). If blocked, user can tap "Play voice".
    if (audio?.url && wantAudio) {
      const ok = await playAudioUrl(audio.url);
      if (!ok) {
        // leave the Play button visible; nothing else needed
      }
    }

    setStatus("Ready.");
  } catch (err) {
    console.error("[HOME] chat error:", err);
    appendBubble("ai", "Sorry — something went wrong while replying.");
    setStatus("Request failed. Please try again.", true);
  } finally {
    setSendingState(false);
    refs.input.value = "";
    refs.input.focus();

    if (audioUrlToRevoke) {
      // delay revoke a bit so Safari doesn't lose it mid-play
      setTimeout(() => {
        try {
          URL.revokeObjectURL(audioUrlToRevoke);
        } catch {}
      }, 60_000);
    }
  }
}

/* -------------------------- SPEAK (record) ---------------------------- */
function pickSupportedMime() {
  const candidates = [
    { mime: "audio/webm;codecs=opus", ext: "webm" },
    { mime: "audio/webm", ext: "webm" },
    { mime: "audio/ogg;codecs=opus", ext: "ogg" },
    { mime: "audio/mp4", ext: "m4a" },
    { mime: "audio/mpeg", ext: "mp3" },
  ];
  for (const c of candidates) {
    if (window.MediaRecorder && MediaRecorder.isTypeSupported?.(c.mime)) return c;
  }
  return { mime: "audio/webm", ext: "webm" };
}

async function startRecording() {
  if (!navigator.mediaDevices?.getUserMedia) {
    setStatus("Mic not supported in this browser.", true);
    return;
  }

  // ✅ unlock on gesture (Speak click)
  await unlockAudioSystem();

  try {
    chosenMime = pickSupportedMime();
    mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    mediaRecorder = new MediaRecorder(mediaStream, { mimeType: chosenMime.mime });
    mediaChunks = [];

    mediaRecorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) mediaChunks.push(e.data);
    };

    mediaRecorder.onstop = async () => {
      const blob = new Blob(mediaChunks, { type: chosenMime.mime });

      // Minimal: use client-side speech-to-text elsewhere if needed.
      // For now we just confirm capture.
      // If you want: upload blob to a voice-STT function then call coach.
      // eslint-disable-next-line no-unused-vars
      const _blob = blob;

      mediaStream.getTracks().forEach((t) => t.stop());
      mediaStream = null;
      mediaRecorder = null;
      mediaChunks = [];
      setStatus("Ready.");
    };

    mediaRecorder.start();
    recording = true;
    refs.speakBtn?.classList.add("recording");
    refs.speakBtn.textContent = "Stop";
    refs.input?.setAttribute("disabled", "true");
    setStatus("Recording… tap Speak again to stop.");
  } catch (err) {
    console.error("startRecording error:", err);
    setStatus("Microphone access failed.", true);
  }
}

function stopRecording() {
  if (!mediaRecorder) return;
  mediaRecorder.stop();
  recording = false;
  refs.speakBtn?.classList.remove("recording");
  refs.speakBtn.textContent = "Speak";
  refs.input?.removeAttribute("disabled");
  setStatus("Processing audio…");
}

/* -------------------------- tooltips (guides) -------------------------- */
function isTouchLike() {
  return (
    window.matchMedia?.("(hover: none)").matches ||
    "ontouchstart" in window ||
    navigator.maxTouchPoints > 0
  );
}

function initTooltips() {
  const targets = Array.from(document.querySelectorAll("[data-tt-title]"));
  if (!targets.length) return;

  const tt = document.createElement("div");
  tt.className = "sow-tooltip";
  tt.innerHTML = `<div class="tt-title"></div><div class="tt-body"></div>`;
  document.body.appendChild(tt);

  const setContent = (el) => {
    tt.querySelector(".tt-title").textContent =
      el.getAttribute("data-tt-title") || "";
    tt.querySelector(".tt-body").textContent =
      el.getAttribute("data-tt-body") || "";
  };

  const position = (el) => {
    const r = el.getBoundingClientRect();

    tt.classList.add("show");
    const tr = tt.getBoundingClientRect();

    const preferAbove = r.top > tr.height + 18;

    let top = preferAbove ? r.top - tr.height - 12 : r.bottom + 12;
    let left = r.left + r.width / 2 - tr.width / 2;

    left = Math.max(12, Math.min(left, window.innerWidth - tr.width - 12));
    top = Math.max(12, Math.min(top, window.innerHeight - tr.height - 12));

    tt.style.left = `${left}px`;
    tt.style.top = `${top}px`;

    const centerX = r.left + r.width / 2;
    const arrowX = Math.max(14, Math.min(centerX - left, tr.width - 14));

    tt.style.setProperty("--arrow-left", `${arrowX - 5}px`);
    if (preferAbove) {
      tt.style.setProperty("--arrow-top", `${tr.height - 4}px`);
      tt.style.setProperty("--arrow-rot", "225deg");
    } else {
      tt.style.setProperty("--arrow-top", `-6px`);
      tt.style.setProperty("--arrow-rot", "45deg");
    }
  };

  let showTimer = null;
  let hideTimer = null;

  const show = (el) => {
    setContent(el);
    position(el);
  };

  const hide = () => {
    tt.classList.remove("show");
  };

  if (!isTouchLike()) {
    targets.forEach((el) => {
      el.addEventListener("mouseenter", () => {
        clearTimeout(hideTimer);
        clearTimeout(showTimer);
        showTimer = setTimeout(() => show(el), 250);
      });
      el.addEventListener("mouseleave", () => {
        clearTimeout(showTimer);
        hideTimer = setTimeout(hide, 80);
      });
      el.addEventListener("focus", () => show(el));
      el.addEventListener("blur", hide);
    });
  } else {
    targets.forEach((el) => {
      let pressTimer = null;

      el.addEventListener(
        "touchstart",
        () => {
          clearTimeout(pressTimer);
          pressTimer = setTimeout(() => show(el), 550);
        },
        { passive: true }
      );

      el.addEventListener(
        "touchend",
        () => {
          clearTimeout(pressTimer);
          hide();
        },
        { passive: true }
      );

      el.addEventListener(
        "touchmove",
        () => {
          clearTimeout(pressTimer);
          hide();
        },
        { passive: true }
      );
    });
  }

  window.addEventListener("scroll", hide, { passive: true });
  window.addEventListener("resize", hide);
}

/* ------------------------------ bindings ------------------------------ */
function bindUI() {
  // chips -> fill input
  refs.chips.forEach((chip) => {
    chip.addEventListener("click", () => {
      const fill = chip.getAttribute("data-fill") || chip.textContent || "";
      if (refs.input) {
        refs.input.value = fill;
        refs.input.focus();
      }
    });
  });

  // send button
  refs.sendBtn?.addEventListener("click", handleSend);

  // Enter to send
  refs.input?.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  });

  // tools
  refs.callBtn?.addEventListener("click", () => {
    const url = new URL("call.html", window.location.origin);
    if (conversationId) url.searchParams.set("c", conversationId);
    window.location.href = url.toString();
  });

  refs.filesBtn?.addEventListener("click", async () => {
    alert("Files: connect your upload flow here.");
  });

  // SPEAK toggle
  refs.speakBtn?.addEventListener("click", async () => {
    if (!recording) {
      await startRecording();
    } else {
      stopRecording();
    }
  });

  // ✅ Conversations / history (hamburger)
  refs.hamburger?.addEventListener("click", () => {
    const url = new URL("history.html", window.location.origin);

    // Pass current conversation (optional)
    if (conversationId) url.searchParams.set("c", conversationId);

    // IMPORTANT: history.js expects ?returnTo=...
    url.searchParams.set("returnTo", encodeURIComponent("home.html"));

    window.location.href = url.toString();
  });

  // logout
  refs.logoutBtn?.addEventListener("click", async () => {
    try {
      await supabase.auth.signOut();
    } catch (e) {
      console.warn("signOut error:", e);
    } finally {
      window.location.replace("/auth.html");
    }
  });
}

/* ---------------------- conversation wiring --------------------------- */
async function ensureConversationForUser(user) {
  const url = new URL(window.location.href);
  const params = url.searchParams;
  const existingId = params.get("c");
  const forceNew = params.get("new") === "1";

  // If URL has a conversation id and we're not forcing a new one, verify it
  if (existingId && !forceNew) {
    const { data, error } = await supabase
      .from("conversations")
      .select("id")
      .eq("id", existingId)
      .eq("user_id", user.id)
      .maybeSingle();

    if (!error && data && data.id) {
      return data.id;
    }
  }

  // Else create a new conversation
  const { data, error } = await supabase
    .from("conversations")
    .insert({
      user_id: user.id,
      title: "New Conversation",
    })
    .select("id")
    .single();

  if (error || !data?.id) {
    console.error("[HOME] Failed to create conversation:", error);
    throw new Error("Could not create conversation");
  }

  const newId = data.id;
  // Update URL to reflect the new conversation and clear ?new=1
  params.set("c", newId);
  params.delete("new");
  url.search = params.toString();
  window.history.replaceState({}, "", url.toString());

  return newId;
}

/* -------------------------------- boot -------------------------------- */
(async function boot() {
  await ensureAuthedOrRedirect();
  session = await getSession();

  if (!session?.user) {
    setStatus("No user session found.", true);
    return;
  }

  try {
    conversationId = await ensureConversationForUser(session.user);
    await loadConversationHistory(conversationId);
  } catch (e) {
    console.error("[HOME] conversation init error:", e);
    setStatus("Could not create conversation. Please refresh.", true);
  }

  bindUI();
  initTooltips();
  ensureVoiceToggle();
  ensureSharedAudio();

  // Ensure hamburger is visible even if something sets display:none elsewhere
  if (refs.hamburger) refs.hamburger.style.display = "";

  setStatus("Signed in. How can I help?");
})();
