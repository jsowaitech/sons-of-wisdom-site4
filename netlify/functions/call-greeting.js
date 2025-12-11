// netlify/functions/call-greeting.js
// Son of Wisdom — Dynamic AI greeting (ALWAYS transcribable)
// Returns JSON: { text, assistant_text, audio_base64, mime, call_id }
//
// This version also:
// - Accepts call_id + conversationId in the POST body
// - Logs the greeting into Supabase:
//     * call_sessions (ai_text only, tied to call_id)
//     * conversation_messages (assistant role, tied to conversationId) if provided

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

async function openaiChat(messages, opts = {}) {
  mustHave(OPENAI_API_KEY, "OPENAI_API_KEY");

  const body = {
    model: OPENAI_MODEL,
    messages,
    temperature: opts.temperature ?? 0.8,
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
    const body = JSON.parse(event.body || "{}");
    const userIdRaw = (body.user_id || "").toString().trim();
    const deviceId = (body.device_id || "").toString().trim();
    const callId = (body.call_id || body.callId || "").toString().trim() || null;
    const conversationId =
      (body.conversationId || body.conversation_id || body.c || "").toString().trim() ||
      null;

    // ---------- 1) Generate a fresh, varied greeting ----------
    const system = `
You are AI Blake, a concise masculine Christian coach for Son of Wisdom.
Return one short spoken greeting (1–2 sentences) that feels warm and strong, not repetitive.
Invite the man to share what is on his heart right now.
No markdown, no bullet points, plain text only.
Do not say the same line every time; vary your wording.`.trim();

    const user = `
Generate a fresh greeting for call mode.

User id: ${userIdRaw || "unknown"}
Device id: ${deviceId || "unknown"}`.trim();

    const text = await openaiChat(
      [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      { temperature: 0.9, maxTokens: 90 }
    );

    // ---------- 2) Turn greeting into TTS audio ----------
    const audio = await elevenLabsTTS(text);

    // ---------- 3) Log greeting into Supabase (best-effort) ----------
    const nowIso = new Date().toISOString();
    const userUuid = pickUuidForHistory(userIdRaw);

    // call_sessions row (assistant side only)
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

    // conversation_messages rows (assistant only) for this conversation
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

    // ---------- 4) Return JSON payload ----------
    return {
      statusCode: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
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
      headers: corsHeaders,
      body: JSON.stringify({
        error: "Server error",
        detail: String(err),
        hint:
          "Ensure OPENAI_API_KEY, ELEVENLABS_API_KEY, ELEVENLABS_VOICE_ID, SUPABASE_URL, and SUPABASE_SERVICE_ROLE_KEY are set in Netlify env.",
      }),
    };
  }
};
