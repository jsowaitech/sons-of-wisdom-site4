// netlify/functions/call-greeting.js
// Son of Wisdom — Dynamic AI greeting (varied + reliable)
// Returns JSON: { text, assistant_text, audio_base64, mime, call_id }

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";

const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY || "";
const ELEVENLABS_VOICE_ID = process.env.ELEVENLABS_VOICE_ID || "";

// Supabase (REST) for logging greeting as a turn
const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_SERVICE_ROLE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  process.env.SUPABASE_SERVICE_KEY ||
  "";

const CALL_SESSIONS_TABLE = "call_sessions";
const CONVERSATION_MESSAGES_TABLE = "conversation_messages";
const SENTINEL_UUID = "00000000-0000-0000-0000-000000000000";

function mustHave(value, name) {
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

function safeJsonParse(str) {
  try {
    return JSON.parse(str || "{}");
  } catch {
    return {};
  }
}

function isUuid(v) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    v || ""
  );
}

function pickUuidForHistory(userId) {
  if (!userId) return SENTINEL_UUID;
  if (isUuid(userId)) return userId;
  return SENTINEL_UUID;
}

function randomSeed() {
  // stable enough for randomness, not for cryptography
  return Math.random().toString(36).slice(2) + "-" + Date.now();
}

async function openaiChat(messages, opts = {}) {
  mustHave(OPENAI_API_KEY, "OPENAI_API_KEY");

  const body = {
    model: OPENAI_MODEL,
    messages,
    temperature: opts.temperature ?? 0.9,
    presence_penalty: opts.presence_penalty ?? 0.6,
    frequency_penalty: opts.frequency_penalty ?? 0.5,
  };

  if (opts.maxTokens) body.max_tokens = opts.maxTokens;
  if (opts.user) body.user = opts.user;

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
  return data?.choices?.[0]?.message?.content?.trim() || "";
}

async function elevenLabsTTS(text) {
  mustHave(ELEVENLABS_API_KEY, "ELEVENLABS_API_KEY");
  mustHave(ELEVENLABS_VOICE_ID, "ELEVENLABS_VOICE_ID");

  const trimmed = (text || "").trim();
  if (!trimmed) throw new Error("Empty greeting text");

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
      voice_settings: { stability: 0.5, similarity_boost: 0.8 },
    }),
  });

  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`ElevenLabs TTS ${res.status}: ${t || res.statusText}`);
  }

  const buf = Buffer.from(await res.arrayBuffer());
  return { audio_base64: buf.toString("base64"), mime: "audio/mpeg" };
}

async function supabaseInsert(table, rows) {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) return;

  const payload = Array.isArray(rows) ? rows : [rows];

  try {
    const url = `${SUPABASE_URL}/rest/v1/${encodeURIComponent(table)}`;
    const res = await fetch(url, {
      method: "POST",
      headers: {
        apikey: SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        "Content-Type": "application/json",
        Prefer: "return=minimal",
      },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      const t = await res.text().catch(() => "");
      console.warn("[call-greeting] Supabase insert error", table, res.status, t);
    }
  } catch (err) {
    console.warn("[call-greeting] Supabase insert failed", table, err);
  }
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") {
    return {
      statusCode: 204,
      headers: { ...corsHeaders, "Cache-Control": "no-store" },
      body: "",
    };
  }

  if (event.httpMethod !== "POST") {
    return {
      statusCode: 405,
      headers: { ...corsHeaders, "Content-Type": "application/json", "Cache-Control": "no-store" },
      body: JSON.stringify({ error: "Method not allowed" }),
    };
  }

  try {
    const body = safeJsonParse(event.body);

    const userIdRaw = (body.user_id || body.userId || "").toString().trim();
    const deviceId = (body.device_id || body.deviceId || "").toString().trim();
    const callId = (body.call_id || body.callId || "").toString().trim() || null;
    const conversationId =
      (body.conversationId || body.conversation_id || body.c || "").toString().trim() || null;

    // Stronger variation controls
    const seed = randomSeed();
    const palette = [
      "warm and grounded",
      "firm and encouraging",
      "calm and confident",
      "direct but compassionate",
      "steady and brotherly",
    ];
    const style = palette[Math.floor(Math.random() * palette.length)];

    const system = `
You are AI Blake, a concise masculine Christian coach for Son of Wisdom.
Return ONE short spoken greeting (1–2 sentences).
Tone: ${style}.
Goal: invite the man to share what's on his heart right now.
Rules:
- Plain text only (no markdown)
- No bullet points
- Do NOT repeat common openers like "Hey man" or "What's on your heart" every time.
- Vary wording and cadence.
`.trim();

    const user = `
Generate a fresh greeting for call mode.

Seed: ${seed}
User id: ${userIdRaw || "unknown"}
Device id: ${deviceId || "unknown"}
Conversation id: ${conversationId || "none"}
`.trim();

    // 1) Get greeting text
    const text = await openaiChat(
      [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      {
        temperature: 0.95,
        maxTokens: 90,
        user: deviceId || userIdRaw || "sow",
        presence_penalty: 0.7,
        frequency_penalty: 0.7,
      }
    );

    // 2) TTS
    const audio = await elevenLabsTTS(text);

    // 3) Log (best-effort)
    const nowIso = new Date().toISOString();
    const userUuid = pickUuidForHistory(userIdRaw);

    if (callId) {
      await supabaseInsert(CALL_SESSIONS_TABLE, {
        call_id: callId,
        user_id_uuid: userUuid,
        input_transcript: null,
        ai_text: text,
        source: "voice_greeting",
        system_event: null,
        created_at: nowIso,
        timestamp: nowIso,
      });
    }

    if (conversationId) {
      await supabaseInsert(CONVERSATION_MESSAGES_TABLE, {
        conversation_id: conversationId,
        role: "assistant",
        content: text,
        source: "voice_greeting",
        call_id: callId,
        created_at: nowIso,
      });
    }

    // 4) Return
    return {
      statusCode: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json", "Cache-Control": "no-store" },
      body: JSON.stringify({
        text,
        assistant_text: text,
        audio_base64: audio.audio_base64,
        mime: audio.mime || "audio/mpeg",
        call_id: callId,
      }),
    };
  } catch (err) {
    console.error("[call-greeting] error:", err);
    return {
      statusCode: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json", "Cache-Control": "no-store" },
      body: JSON.stringify({
        error: "Server error",
        detail: String(err?.message || err),
        hint:
          "Ensure OPENAI_API_KEY, ELEVENLABS_API_KEY, ELEVENLABS_VOICE_ID, and Supabase env vars are set in Netlify.",
      }),
    };
  }
};
