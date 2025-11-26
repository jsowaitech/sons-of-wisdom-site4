// netlify/functions/call-greeting.js
// Dynamic greeting for call mode:
// 1) Uses OpenAI to generate a short spoken greeting
// 2) Sends that text to ElevenLabs TTS with custom voice_settings
// 3) Returns audio (MP3) back to the browser

const OpenAI = require("openai");

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const ELEVEN_API_KEY = process.env.ELEVENLABS_API_KEY;
const ELEVEN_VOICE_ID = process.env.ELEVENLABS_VOICE_ID || "YOUR_VOICE_ID_HERE";
const ELEVEN_MODEL_ID =
  process.env.ELEVENLABS_MODEL_ID || "eleven_multilingual_v2";

// Helper: small safe JSON parse
function safeJson(body) {
  try {
    return JSON.parse(body || "{}");
  } catch {
    return {};
  }
}

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return {
      statusCode: 405,
      headers: { Allow: "POST" },
      body: "Method Not Allowed",
    };
  }

  if (!process.env.OPENAI_API_KEY || !ELEVEN_API_KEY) {
    console.error("[call-greeting] Missing OPENAI_API_KEY or ELEVENLABS_API_KEY");
    return {
      statusCode: 500,
      body: "Server not configured.",
    };
  }

  try {
    const payload = safeJson(event.body);
    const {
      userName,
      lastTranscript,
      rollingSummary,
    } = payload;

    // Build a compact prompt for a *spoken* greeting
    const namePart = userName ? `His name is ${userName}.` : "";
    const lastPart = lastTranscript
      ? `He just said: "${lastTranscript}".`
      : "";
    const summaryPart = rollingSummary
      ? `Recent context: ${rollingSummary}.`
      : "";

    const userPrompt = `
You are Blake, a lion-hearted yet lamb-like spiritual father.
Generate a short SPOKEN greeting for a voice call (not text chat).

Constraints:
- 2–3 sentences max.
- Natural spoken language.
- Fatherly, prophetic, warm, and focused.
- No meta comments like "I'm an AI" or "this is a call".
- Start by briefly welcoming him and acknowledging that he came here for help.
- Then invite him to share what battle or pressure is loudest right now.

Context (if any):
${namePart}
${lastPart}
${summaryPart}
`.trim();

    const completion = await openai.chat.completions.create({
      model: process.env.OPENAI_MODEL || "gpt-4o-mini",
      temperature: 0.85,
      max_tokens: 180,
      messages: [
        {
          role: "system",
          content:
            "You are AI Blake, a spiritual father. Produce only the spoken greeting text. No extra explanations.",
        },
        {
          role: "user",
          content: userPrompt,
        },
      ],
    });

    const greetingText =
      completion?.choices?.[0]?.message?.content?.trim() ||
      "Son, welcome. This is holy ground. Tell me honestly where you are right now in your soul and what battle feels loudest.";

    console.log("[call-greeting] Generated greeting text:", greetingText);

    // Call ElevenLabs TTS with custom voice_settings
    const ttsUrl = `https://api.elevenlabs.io/v1/text-to-speech/${ELEVEN_VOICE_ID}`;

    const ttsBody = {
      model_id: ELEVEN_MODEL_ID,
      text: greetingText,
      voice_settings: {
        stability: 0.3,
        similarity_boost: 0.3,
        style: 0,
        use_speaker_boost: false,
      },
    };

    const ttsResp = await fetch(ttsUrl, {
      method: "POST",
      headers: {
        "xi-api-key": ELEVEN_API_KEY,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(ttsBody),
    });

    if (!ttsResp.ok) {
      const errText = await ttsResp.text().catch(() => "");
      console.error(
        "[call-greeting] ElevenLabs error",
        ttsResp.status,
        errText
      );
      return {
        statusCode: 502,
        body: "Failed to synthesize greeting audio.",
      };
    }

    const audioArrayBuffer = await ttsResp.arrayBuffer();
    const audioBuffer = Buffer.from(audioArrayBuffer);

    // Netlify binary response: base64 + isBase64Encoded
    return {
      statusCode: 200,
      headers: {
        "Content-Type": "audio/mpeg",
        "Cache-Control": "no-store",
      },
      body: audioBuffer.toString("base64"),
      isBase64Encoded: true,
    };
  } catch (err) {
    console.error("[call-greeting] Unexpected error:", err);
    return {
      statusCode: 500,
      body: "Greeting generation failed.",
    };
  }
};
