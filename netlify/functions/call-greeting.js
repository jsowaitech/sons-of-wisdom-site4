// netlify/functions/call-greeting.js
// Generates a unique voice greeting for call mode:
// 1) Uses OpenAI to create a short, cinematic, fatherly greeting.
// 2) Sends the text to ElevenLabs TTS.
// 3) Returns { audio_base64, text, mime } as JSON.

const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY || "";
// Put your preferred voice ID in Netlify env as ELEVENLABS_VOICE_ID
const ELEVENLABS_VOICE_ID = process.env.ELEVENLABS_VOICE_ID || ""; 

// Fallback voice model + settings (mirror your n8n node)
const ELEVENLABS_MODEL_ID = process.env.ELEVENLABS_MODEL_ID || "eleven_turbo_v2_5";
const DEFAULT_VOICE_SETTINGS = {
  stability: 0.35,
  similarity_boost: 0.92,
  style: 0.55,
  use_speaker_boost: true,
};

exports.handler = async function handler(event) {
  try {
    if (event.httpMethod !== "POST") {
      return {
        statusCode: 405,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ error: "Method not allowed" }),
      };
    }

    if (!OPENAI_API_KEY) {
      console.error("[call-greeting] Missing OPENAI_API_KEY");
      return {
        statusCode: 500,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ error: "Server misconfigured: OPENAI_API_KEY missing" }),
      };
    }
    if (!ELEVENLABS_API_KEY || !ELEVENLABS_VOICE_ID) {
      console.error("[call-greeting] Missing ElevenLabs API key or voice ID");
      return {
        statusCode: 500,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          error: "Server misconfigured: ELEVENLABS_API_KEY or ELEVENLABS_VOICE_ID missing",
        }),
      };
    }

    // Optional: you *could* pass context in here later
    let bodyJson = {};
    try {
      bodyJson = event.body ? JSON.parse(event.body) : {};
    } catch (e) {
      // ignore; not required for now
    }
    const callerName =
      (bodyJson && typeof bodyJson.name === "string" && bodyJson.name.trim()) || "son";

    // --- 1) Generate greeting text with OpenAI via raw fetch ---
    const systemPrompt = `
You are the Solomon Codex AI Coach for Son of Wisdom.
Generate a unique, cinematic, fatherly greeting for the START of a voice call.
Speak directly to the man as "${callerName}" or "son".
Tone: lion-hearted, tender, prophetic, and practical.
Length: 2–4 sentences **max**, then end with ONE short, soul-peeling question that invites him
to share where his heart really is right now.
Do NOT mention that you are an AI, a model, or anything technical.
Vary your metaphors, imagery, and language EVERY time so greetings never feel reused.
`.trim();

    const userPrompt = `
Create a fresh greeting now. The man just tapped "Call" and is hearing you for the first seconds.
`.trim();

    const openaiRes = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: OPENAI_MODEL,
        temperature: 0.9,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
      }),
    });

    if (!openaiRes.ok) {
      const errText = await openaiRes.text().catch(() => "");
      console.error("[call-greeting] OpenAI error:", openaiRes.status, errText);
      return {
        statusCode: 500,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          error: "Failed to generate greeting text",
          details: `OpenAI ${openaiRes.status}`,
        }),
      };
    }

    const openaiJson = await openaiRes.json().catch(() => null);
    const greetingText =
      openaiJson?.choices?.[0]?.message?.content?.trim() ||
      `Son, welcome. This is holy ground. Before we go further, tell me honestly: where is your heart right now?`;

    // --- 2) Send greeting text to ElevenLabs for TTS audio ---
    const ttsUrl = `https://api.elevenlabs.io/v1/text-to-speech/${ELEVENLABS_VOICE_ID}/stream?optimize_streaming_latency=0&output_format=mp3_22050_32`;

    const ttsBody = {
      text: greetingText.slice(0, 5000), // just in case
      model_id: ELEVENLABS_MODEL_ID,
      voice_settings: DEFAULT_VOICE_SETTINGS,
    };

    const ttsRes = await fetch(ttsUrl, {
      method: "POST",
      headers: {
        "xi-api-key": ELEVENLABS_API_KEY,
        "Content-Type": "application/json",
        Accept: "audio/mpeg",
      },
      body: JSON.stringify(ttsBody),
    });

    if (!ttsRes.ok) {
      const errText = await ttsRes.text().catch(() => "");
      console.error("[call-greeting] ElevenLabs error:", ttsRes.status, errText);
      return {
        statusCode: 500,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          error: "Failed to generate greeting audio",
          details: `ElevenLabs ${ttsRes.status}`,
        }),
      };
    }

    const audioBuffer = await ttsRes.arrayBuffer();
    const audioBase64 = Buffer.from(audioBuffer).toString("base64");

    // --- 3) Return JSON with base64 audio ---
    return {
      statusCode: 200,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
      },
      body: JSON.stringify({
        audio_base64: audioBase64,
        mime: "audio/mpeg",
        text: greetingText,
      }),
    };
  } catch (err) {
    console.error("[call-greeting] Unexpected error:", err);
    return {
      statusCode: 500,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error: "Unexpected server error in greeting function" }),
    };
  }
};
