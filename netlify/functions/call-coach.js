// netlify/functions/call-coach.js
// Son of Wisdom — Voice / Call coach (Netlify Function)
//
// Features:
// - Normal coach mode: takes transcript + metadata, runs Pinecone RAG + OpenAI chat (Blake prompt),
//   logs to Supabase (call_sessions + conversation_messages), optional rolling summary update,
//   returns { assistant_text, audio_base64, mime }.
// - System mode: supports:
//    - system_event: "no_response_nudge" | "no_response_end"
//    - system_say: speak EXACT line
//   Generates unique non-repeating variants per call/device (warm lambda memory),
//   returns audio for system lines too,
//   logs system assistant lines into conversation_messages (keeps chat thread in sync),
//   optionally logs system events to call_sessions if LOG_SYSTEM_EVENTS=true.
//
// Notes:
// - Requires Node 18+ runtime (Netlify default) for global fetch.
// - Env vars used:
//   OPENAI_API_KEY, OPENAI_MODEL (default gpt-4o-mini), OPENAI_EMBED_MODEL (default text-embedding-3-small)
//   PINECONE_API_KEY, PINECONE_INDEX, PINECONE_NAMESPACE (optional)
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
//   ELEVENLABS_API_KEY, ELEVENLABS_VOICE_ID
//   LOG_SYSTEM_EVENTS (optional "true")
//   USER_UUID_OVERRIDE (optional)

const { Pinecone } = require("@pinecone-database/pinecone");

// ---------- ENV ----------
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";
const OPENAI_EMBED_MODEL =
  process.env.OPENAI_EMBED_MODEL || "text-embedding-3-small";

const PINECONE_API_KEY = process.env.PINECONE_API_KEY;
const PINECONE_INDEX = process.env.PINECONE_INDEX;
const PINECONE_NAMESPACE = process.env.PINECONE_NAMESPACE || undefined;

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const SUPABASE_REST = SUPABASE_URL ? `${SUPABASE_URL}/rest/v1` : null;

const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY || "";
const ELEVENLABS_VOICE_ID = process.env.ELEVENLABS_VOICE_ID || "";

const SENTINEL_UUID = "00000000-0000-0000-0000-000000000000";
const USER_UUID_OVERRIDE = process.env.USER_UUID_OVERRIDE || null;

const LOG_SYSTEM_EVENTS =
  (process.env.LOG_SYSTEM_EVENTS || "").toLowerCase() === "true";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, Accept",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// ---------- Anti-repeat memory (in-memory per warm lambda) ----------
const NO_RESPONSE_MEMORY = new Map(); // key: callId|deviceId => { nudges:[], ends:[] }
const MAX_RECENT_VARIANTS = 8;

function getNoRespKey(callId, deviceId) {
  return `${callId || "no_call"}|${deviceId || "no_device"}`;
}

function rememberVariant(key, kind, text) {
  if (!text) return;
  const slot = NO_RESPONSE_MEMORY.get(key) || { nudges: [], ends: [] };
  const arr = kind === "end" ? slot.ends : slot.nudges;

  const clean = String(text).trim();
  if (!clean) return;

  const existingIdx = arr.findIndex((t) => t === clean);
  if (existingIdx >= 0) arr.splice(existingIdx, 1);

  arr.push(clean);
  while (arr.length > MAX_RECENT_VARIANTS) arr.shift();

  NO_RESPONSE_MEMORY.set(key, slot);
}

function recentVariants(key, kind) {
  const slot = NO_RESPONSE_MEMORY.get(key);
  if (!slot) return [];
  return (kind === "end" ? slot.ends : slot.nudges) || [];
}

// ---------- SYSTEM PROMPT ----------
const SYSTEM_PROMPT_BLAKE = `
AI BLAKE – SON OF WISDOM COACH
TTS-SAFE • CONVERSATIONAL • DIAGNOSTIC-FIRST • SHORT RESPONSES • VARIATION • NO DEEP-DIVE

YOU ARE: AI BLAKE

You are AI Blake, the digital embodiment of the Son of Wisdom movement and the voice of a seasoned, battle-tested, biblically masculine mentor.

You speak with the voice, conviction, and style of Blake Templeton (Travis persona) as used inside Son of Wisdom and Solomon Codex.

Your assignment is to pull men out of the slavemarket, sever the Slavelord’s voice, and rebuild them as Kings who govern their homes emotionally, spiritually, and atmospherically with wisdom, love, and fearless authority.

Your answers will be spoken through a text-to-speech engine, so everything you say must be TTS-friendly plain text. Follow the TTS rules below strictly.

TTS / ELEVENLABS RULES (CRITICAL)
- Plain text only.
- No markdown (#, *, _, >, backticks).
- No bullet lists or numbered list lines.
- No emojis.
- Short paragraphs are OK.
- Keep it natural to speak.

WORD LIMITS
- Diagnostic mode default: 3–6 sentences, max 120 words.
- Micro-guidance: 90–160 words, max 190 words.
- Do NOT do long teachings. Be concise.

DO NOT mention Pinecone, embeddings, vector search, or internal tooling.
If you reference content, call it “Son of Wisdom material” or “our Son of Wisdom resources”.
`.trim();

// ---------- Pinecone setup ----------
let pineconeClient = null;
let pineconeIndex = null;

function ensurePinecone() {
  if (!PINECONE_API_KEY || !PINECONE_INDEX) return null;
  if (!pineconeClient) {
    pineconeClient = new Pinecone({ apiKey: PINECONE_API_KEY });
    pineconeIndex = pineconeClient.index(PINECONE_INDEX);
  }
  return pineconeIndex;
}

// ---------- helpers ----------
function isUuid(v) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    v || ""
  );
}

function pickUuidForHistory(userId) {
  if (USER_UUID_OVERRIDE && isUuid(USER_UUID_OVERRIDE)) return USER_UUID_OVERRIDE;
  if (isUuid(userId)) return userId;
  return SENTINEL_UUID;
}

function safeJsonParse(s, fallback = {}) {
  try {
    return JSON.parse(s || "{}");
  } catch {
    return fallback;
  }
}

// Keep output TTS-safe + bounded
function clampTtsSafe(text, maxChars = 900) {
  const s = String(text || "")
    .replace(/[#*_>`]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!s) return "";
  if (s.length <= maxChars) return s;
  return s.slice(0, maxChars - 1).trim() + "…";
}

// ---------- OpenAI helpers ----------
async function openaiEmbedding(text) {
  if (!OPENAI_API_KEY) throw new Error("Missing OPENAI_API_KEY");

  const res = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: OPENAI_EMBED_MODEL,
      input: String(text || "").slice(0, 8000),
    }),
  });

  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`OpenAI embeddings ${res.status}: ${t || res.statusText}`);
  }

  const data = await res.json();
  const vec = data?.data?.[0]?.embedding;
  if (!Array.isArray(vec)) throw new Error("No embedding returned");
  return vec;
}

async function openaiChat(messages, opts = {}) {
  if (!OPENAI_API_KEY) throw new Error("Missing OPENAI_API_KEY");

  const body = {
    model: OPENAI_MODEL,
    messages,
    temperature: opts.temperature ?? 0.7,
  };
  if (opts.maxTokens) body.max_tokens = opts.maxTokens;

  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`OpenAI chat ${res.status}: ${t || res.statusText}`);
  }

  const data = await res.json();
  const out = data?.choices?.[0]?.message?.content?.trim() || "";
  return out;
}

// ---------- Pinecone RAG ----------
function buildKBQuery(userMessage) {
  if (!userMessage) return "";
  const words = String(userMessage).split(/\s+/).filter(Boolean);
  return words.slice(0, 18).join(" ");
}

async function getKnowledgeContext(question, topK = 10) {
  try {
    const index = ensurePinecone();
    if (!index || !question) return "";

    const vector = await openaiEmbedding(question);

    const target =
      PINECONE_NAMESPACE && typeof index.namespace === "function"
        ? index.namespace(PINECONE_NAMESPACE)
        : index;

    const queryRes = await target.query({
      vector,
      topK,
      includeMetadata: true,
    });

    const matches = queryRes?.matches || [];
    if (!matches.length) return "";

    const chunks = matches
      .sort((a, b) => (b.score || 0) - (a.score || 0))
      .map((m) => {
        const md = m.metadata || {};
        return md.text || md.chunk || md.content || md.body || "";
      })
      .filter(Boolean)
      .slice(0, 12);

    const joined = chunks.join("\n\n---\n\n");
    return joined.slice(0, 4500);
  } catch (err) {
    console.error("[call-coach] getKnowledgeContext error:", err);
    return "";
  }
}

// ---------- Supabase REST helper ----------
async function supaFetch(
  path,
  { method = "GET", headers = {}, query, body } = {}
) {
  if (!SUPABASE_REST || !SUPABASE_SERVICE_ROLE_KEY) return null;

  const url = new URL(`${SUPABASE_REST}/${path}`);
  if (query) {
    for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
  }

  const res = await fetch(url.toString(), {
    method,
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      ...headers,
    },
    body,
  });

  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    console.error(
      `[call-coach] Supabase ${method} ${path} ${res.status}:`,
      txt || res.statusText
    );
    throw new Error(`Supabase ${method} ${path} ${res.status}`);
  }

  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

// Conversation helpers
async function fetchConversation(conversationId) {
  if (!conversationId) return null;
  const rows = await supaFetch("conversations", {
    query: {
      select: "id,user_id,title,summary,updated_at,last_updated_at",
      id: `eq.${conversationId}`,
      limit: "1",
    },
  });
  if (!Array.isArray(rows) || !rows.length) return null;
  return rows[0];
}

async function fetchRecentMessages(conversationId, limit = 12) {
  if (!conversationId) return [];
  const rows = await supaFetch("conversation_messages", {
    query: {
      select: "role,content,created_at",
      conversation_id: `eq.${conversationId}`,
      order: "created_at.desc",
      limit: String(limit),
    },
  });
  if (!Array.isArray(rows)) return [];
  return rows
    .slice()
    .sort(
      (a, b) =>
        new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
    );
}

async function insertConversationMessages(
  conversation,
  conversationId,
  userText,
  assistantText
) {
  if (!conversation || !conversationId || !conversation.user_id) return;

  const nowIso = new Date().toISOString();
  const rows = [
    {
      conversation_id: conversationId,
      user_id: conversation.user_id,
      role: "user",
      content: String(userText || "").trim(),
      created_at: nowIso,
    },
    {
      conversation_id: conversationId,
      user_id: conversation.user_id,
      role: "assistant",
      content: String(assistantText || "").trim(),
      created_at: nowIso,
    },
  ];

  await supaFetch("conversation_messages", {
    method: "POST",
    headers: { "Content-Type": "application/json", Prefer: "return=minimal" },
    body: JSON.stringify(rows),
  });

  await supaFetch("conversations", {
    method: "PATCH",
    headers: { "Content-Type": "application/json", Prefer: "return=minimal" },
    query: { id: `eq.${conversationId}` },
    body: JSON.stringify({ updated_at: nowIso, last_updated_at: nowIso }),
  });
}

function makeConversationTitleFromText(text, maxLen = 80) {
  const clean = String(text || "").replace(/\s+/g, " ").trim();
  if (!clean) return "New Conversation";
  let t = clean;
  if (t.length > maxLen) t = t.slice(0, maxLen - 1) + "…";
  return t.charAt(0).toUpperCase() + t.slice(1);
}

async function maybeUpdateConversationTitle(conversation, conversationId, firstUserMessage) {
  if (!conversation || !conversationId || !firstUserMessage) return;
  const current = String(conversation.title || "").trim();
  if (current && current !== "New Conversation") return;

  const newTitle = makeConversationTitleFromText(firstUserMessage);
  const nowIso = new Date().toISOString();

  await supaFetch("conversations", {
    method: "PATCH",
    headers: { "Content-Type": "application/json", Prefer: "return=minimal" },
    query: { id: `eq.${conversationId}` },
    body: JSON.stringify({
      title: newTitle,
      updated_at: nowIso,
      last_updated_at: nowIso,
    }),
  });
}

async function buildRollingSummary(existingSummary, messages) {
  const prev = String(existingSummary || "").trim();
  if (!messages || !messages.length) return prev;

  const historyText = messages
    .map((m) => `${m.role === "user" ? "User" : "Coach"}: ${m.content}`)
    .join("\n");

  const sys =
    "Write a short rolling summary (2–4 sentences, max 500 characters) of an ongoing coaching conversation. Capture situation, patterns, and goals. Do NOT mention that this is a summary.";
  const user = `
Previous summary (may be empty):
${prev || "(none)"}

Recent messages (oldest to newest):
${historyText}

Update the summary now, staying under 500 characters.
`.trim();

  const summary = await openaiChat(
    [
      { role: "system", content: sys },
      { role: "user", content: user },
    ],
    { temperature: 0.2, maxTokens: 220 }
  );

  return String(summary || "").slice(0, 500);
}

async function updateConversationSummary(
  conversation,
  conversationId,
  priorMessages,
  newUserText,
  newAssistantText
) {
  if (!conversation || !conversationId) return conversation?.summary || null;
  try {
    const base = Array.isArray(priorMessages) ? priorMessages.slice() : [];
    base.push({ role: "user", content: newUserText });
    base.push({ role: "assistant", content: newAssistantText });

    const newSummary = await buildRollingSummary(conversation.summary, base);

    const nowIso = new Date().toISOString();
    await supaFetch("conversations", {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Prefer: "return=minimal" },
      query: { id: `eq.${conversationId}` },
      body: JSON.stringify({ summary: newSummary, last_updated_at: nowIso }),
    });

    return newSummary;
  } catch (e) {
    console.error("[call-coach] updateConversationSummary error:", e);
    return conversation.summary || null;
  }
}

// ---------- ElevenLabs TTS ----------
async function elevenLabsTTS(text) {
  if (!ELEVENLABS_API_KEY || !ELEVENLABS_VOICE_ID) return null;

  const trimmed = String(text || "").trim();
  if (!trimmed) return null;

  const url = `https://api.elevenlabs.io/v1/text-to-speech/${ELEVENLABS_VOICE_ID}`;

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "xi-api-key": ELEVENLABS_API_KEY,
      "Content-Type": "application/json",
      Accept: "audio/mpeg",
    },
    body: JSON.stringify({
      text: trimmed,
      model_id: "eleven_turbo_v2",
      voice_settings: {
        stability: 0.5,
        similarity_boost: 0.8,
      },
    }),
  });

  if (!res.ok) {
    const t = await res.text().catch(() => "");
    console.error(
      "[call-coach] ElevenLabs TTS error:",
      res.status,
      t || res.statusText
    );
    return null;
  }

  const buf = Buffer.from(await res.arrayBuffer());
  const audioBase64 = buf.toString("base64");
  return { audio_base64: audioBase64, mime: "audio/mpeg" };
}

/**
 * Insert a call_sessions row, resilient to schema differences.
 * Some schemas do not accept created_at/timestamp depending on RLS & defaults.
 */
async function tryInsertCallSession(row) {
  if (!SUPABASE_REST || !SUPABASE_SERVICE_ROLE_KEY) return;

  const baseHeaders = {
    "Content-Type": "application/json",
    Prefer: "return=minimal",
  };

  try {
    await supaFetch("call_sessions", {
      method: "POST",
      headers: baseHeaders,
      body: JSON.stringify([row]),
    });
    return;
  } catch (e1) {
    try {
      const clone = { ...row };
      delete clone.created_at;
      delete clone.timestamp;
      await supaFetch("call_sessions", {
        method: "POST",
        headers: baseHeaders,
        body: JSON.stringify([clone]),
      });
    } catch (e2) {
      console.error("[call-coach] call_sessions insert error:", e2);
    }
  }
}

// ---------- No-response line generation ----------
async function generateNoResponseLine({ kind, recent = [] }) {
  const mode = kind === "end" ? "end" : "nudge";

  const sys = `
You are AI Blake, a masculine, fatherly Christian coach.
Output ONE short, TTS-friendly line only.
No bullet points. No markdown. No quotes. No emojis. No Scripture citations.

Goal:
- If mode is nudge: gently check in and invite the man to speak.
- If mode is end: state you haven't heard him, you'll end the call, and he can call again.

Variation rules:
- Do not reuse or closely mirror any of the recent lines provided.
- Vary phrasing, cadence, and openings.

Length:
- Nudge: 12 to 22 words.
- End: 14 to 26 words.
`.trim();

  const user = `
Mode: ${mode}

Recent lines to avoid:
${recent.length ? recent.map((s) => `- ${s}`).join("\n") : "(none)"}

Write ONE line now:
`.trim();

  const out = await openaiChat(
    [
      { role: "system", content: sys },
      { role: "user", content: user },
    ],
    { temperature: 0.95, maxTokens: 80 }
  );

  const cleaned = clampTtsSafe(out, mode === "end" ? 210 : 170);

  if (!cleaned) {
    return mode === "end"
      ? "I haven’t heard from you, so I’m going to end this call. Call me again when you’re ready."
      : "I’m here with you. If you’re still there, go ahead and tell me what’s happening.";
  }

  return cleaned;
}

// ---------- Netlify handler ----------
exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: corsHeaders, body: "" };
  }

  if (event.httpMethod !== "POST") {
    return {
      statusCode: 405,
      headers: corsHeaders,
      body: JSON.stringify({ error: "Method not allowed" }),
    };
  }

  try {
    const body = safeJsonParse(event.body, {});
    const nowIso = new Date().toISOString();

    const source = String(body.source || "voice").toLowerCase();

    const conversationId =
      body.conversationId || body.conversation_id || body.c || null;

    const callId = body.call_id || body.callId || null;
    const deviceId = body.device_id || body.deviceId || null;

    const systemEvent = String(body.system_event || body.systemEvent || "").trim();
    const systemSay = String(body.system_say || body.systemSay || "").trim();
    const isSystemMode = Boolean(systemSay || systemEvent);

    // Conversation memory (optional)
    let conversation = null;
    let recentMessages = [];
    if (SUPABASE_REST && SUPABASE_SERVICE_ROLE_KEY && conversationId) {
      try {
        conversation = await fetchConversation(conversationId);
        recentMessages = await fetchRecentMessages(conversationId, 12);
      } catch (e) {
        console.error("[call-coach] Supabase fetch error:", e);
      }
    }

    // ---------- SYSTEM MODE ----------
    if (isSystemMode) {
      const key = getNoRespKey(callId, deviceId);

      let reply = "";
      if (systemSay) {
        reply = clampTtsSafe(systemSay, 220);
      } else if (systemEvent === "no_response_nudge") {
        const recent = recentVariants(key, "nudge");
        reply = await generateNoResponseLine({ kind: "nudge", recent });
        rememberVariant(key, "nudge", reply);
      } else if (systemEvent === "no_response_end") {
        const recent = recentVariants(key, "end");
        reply = await generateNoResponseLine({ kind: "end", recent });
        rememberVariant(key, "end", reply);
      } else {
        reply = "I’m here. If you’re still with me, go ahead and speak.";
      }

      // TTS
      let audio = null;
      try {
        audio = await elevenLabsTTS(reply);
      } catch (e) {
        console.error("[call-coach] TTS error (system mode):", e);
      }

      // Optional: log system events to call_sessions
      if (LOG_SYSTEM_EVENTS && SUPABASE_REST && SUPABASE_SERVICE_ROLE_KEY) {
        const userId = String(body.user_id || "");
        const userUuid = pickUuidForHistory(userId);
        try {
          const row = {
            user_id_uuid: userUuid,
            device_id: deviceId || null,
            call_id: callId || null,
            source: source || "voice_system",
            input_transcript: systemEvent
              ? `[system_event] ${systemEvent}`
              : "[system_say]",
            ai_text: reply,
            created_at: nowIso,
          };
          await tryInsertCallSession(row);
        } catch (e) {
          console.error("[call-coach] call_sessions insert error (system mode):", e);
        }
      }

      // Log system assistant line into conversation_messages so thread stays synced
      if (conversation && conversationId && SUPABASE_REST && SUPABASE_SERVICE_ROLE_KEY) {
        try {
          await supaFetch("conversation_messages", {
            method: "POST",
            headers: { "Content-Type": "application/json", Prefer: "return=minimal" },
            body: JSON.stringify([
              {
                conversation_id: conversationId,
                user_id: conversation.user_id,
                role: "assistant",
                content: reply,
                created_at: nowIso,
              },
            ]),
          });

          await supaFetch("conversations", {
            method: "PATCH",
            headers: { "Content-Type": "application/json", Prefer: "return=minimal" },
            query: { id: `eq.${conversationId}` },
            body: JSON.stringify({ updated_at: nowIso, last_updated_at: nowIso }),
          });
        } catch (e) {
          console.error("[call-coach] conversation system-message logging error:", e);
        }
      }

      const responseBody = {
        text: reply,
        assistant_text: reply,
        usedKnowledge: false,
        conversationId: conversationId || null,
        call_id: callId || null,
        system_event: systemEvent || null,
      };

      if (audio && audio.audio_base64) {
        responseBody.audio_base64 = audio.audio_base64;
        responseBody.mime = audio.mime || "audio/mpeg";
      }

      return {
        statusCode: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
        body: JSON.stringify(responseBody),
      };
    }

    // ---------- NORMAL COACH MODE ----------
    const rollingSummaryFromClient = String(
      body.rolling_summary || body.rollingSummary || ""
    ).trim();

    const rawUtterance = String(
      body.user_turn || body.utterance || body.transcript || ""
    ).trim();

    const userMessageForAI = String(body.transcript || rawUtterance || "").trim();

    if (!rawUtterance && !userMessageForAI) {
      return {
        statusCode: 400,
        headers: corsHeaders,
        body: JSON.stringify({ error: "Missing transcript" }),
      };
    }

    const historySnippet = recentMessages.length
      ? recentMessages
          .map((m) => `${m.role === "user" ? "User" : "Coach"}: ${m.content || ""}`)
          .join("\n")
      : "—";

    const conversationSummary = (conversation && conversation.summary) || "—";

    const combinedRollingSummary = rollingSummaryFromClient
      ? `Conversation summary:\n${conversationSummary}\n\nRecent call summary:\n${rollingSummaryFromClient}`
      : conversationSummary;

    // Pinecone KB context (optional)
    const kbQuery = buildKBQuery(rawUtterance || userMessageForAI);
    const kbContext = await getKnowledgeContext(kbQuery);
    const usedKnowledge = Boolean(kbContext && kbContext.trim());

    const messages = [];

    messages.push({ role: "system", content: SYSTEM_PROMPT_BLAKE });

    const kbInstruction = `
CRITICAL INSTRUCTION – KNOWLEDGE BASE USAGE

If the context below is relevant, use it to ground your answer and stay consistent with Son of Wisdom language and frameworks.
Synthesize; do not paste large blocks.
If context is empty or unrelated, answer from Son of Wisdom coaching principles and biblical wisdom.

Never mention Pinecone, embeddings, or retrieval.

KNOWLEDGE BASE CONTEXT:
${kbContext || "No relevant Son of Wisdom knowledge base passages were retrieved for this turn."}
`.trim();

    messages.push({ role: "system", content: kbInstruction });

    const memoryInstruction = `
Conversation memory context for this thread.

Rolling summary:
${combinedRollingSummary}

Recent history (oldest to newest):
${historySnippet}

Use this context to stay consistent. Do not read this back to the user.
`.trim();

    messages.push({ role: "system", content: memoryInstruction });
    messages.push({ role: "user", content: userMessageForAI });

    const rawReply = await openaiChat(messages);
    const reply = clampTtsSafe(rawReply, 1200);
    const assistant_text = reply;

    // Supabase logging (optional)
    if (SUPABASE_REST && SUPABASE_SERVICE_ROLE_KEY) {
      const userId = String(body.user_id || "");
      const userUuid = pickUuidForHistory(userId);

      try {
        const row = {
          user_id_uuid: userUuid,
          device_id: deviceId || null,
          call_id: callId || null,
          source,
          input_transcript: rawUtterance || userMessageForAI,
          ai_text: reply,
          created_at: nowIso,
        };
        await tryInsertCallSession(row);
      } catch (e) {
        console.error("[call-coach] call_sessions insert error:", e);
      }

      if (conversation && conversationId) {
        try {
          await insertConversationMessages(
            conversation,
            conversationId,
            rawUtterance || userMessageForAI,
            reply
          );

          await updateConversationSummary(
            conversation,
            conversationId,
            recentMessages,
            rawUtterance || userMessageForAI,
            reply
          );

          await maybeUpdateConversationTitle(
            conversation,
            conversationId,
            rawUtterance || userMessageForAI
          );
        } catch (e) {
          console.error("[call-coach] conversation logging error:", e);
        }
      }
    }

    // ElevenLabs TTS
    let audio = null;
    if (source === "voice" || source === "chat") {
      try {
        audio = await elevenLabsTTS(reply);
      } catch (e) {
        console.error("[call-coach] TTS error:", e);
      }
    }

    const responseBody = {
      text: reply,
      assistant_text,
      usedKnowledge,
      conversationId: conversationId || null,
      call_id: callId || null,
    };

    if (audio && audio.audio_base64) {
      responseBody.audio_base64 = audio.audio_base64;
      responseBody.mime = audio.mime || "audio/mpeg";
    }

    return {
      statusCode: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
      body: JSON.stringify(responseBody),
    };
  } catch (err) {
    console.error("[call-coach] handler error:", err);
    return {
      statusCode: 500,
      headers: corsHeaders,
      body: JSON.stringify({
        error: "Server error",
        detail: String(err && err.message ? err.message : err),
      }),
    };
  }
};
