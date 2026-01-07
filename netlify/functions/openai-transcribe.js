// netlify/functions/openai-transcribe.js
// ✅ Dependency-free Whisper forwarding for Netlify
// ✅ Adds required model=whisper-1
// ✅ Works with multipart/form-data from the browser

export async function handler(event) {
  const cors = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Cache-Control": "no-store",
  };

  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: cors, body: "" };
  }

  if (event.httpMethod !== "POST") {
    return {
      statusCode: 405,
      headers: { ...cors, "Content-Type": "application/json" },
      body: JSON.stringify({ error: "Method not allowed" }),
    };
  }

  try {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      return {
        statusCode: 500,
        headers: { ...cors, "Content-Type": "application/json" },
        body: JSON.stringify({ error: "Missing OPENAI_API_KEY env var" }),
      };
    }

    const contentType =
      event.headers["content-type"] || event.headers["Content-Type"];

    if (!contentType?.includes("multipart/form-data")) {
      return {
        statusCode: 400,
        headers: { ...cors, "Content-Type": "application/json" },
        body: JSON.stringify({ error: "Expected multipart/form-data" }),
      };
    }

    // ✅ Decode body into buffer
    const rawBody = event.isBase64Encoded
      ? Buffer.from(event.body, "base64")
      : Buffer.from(event.body);

    // ✅ We must inject model=whisper-1 into the multipart payload.
    // BUT: easiest way is to append it as another part.
    // So we rebuild multipart by adding a new part at the end.

    const boundary = contentType.split("boundary=")[1];
    if (!boundary) {
      return {
        statusCode: 400,
        headers: { ...cors, "Content-Type": "application/json" },
        body: JSON.stringify({ error: "Missing multipart boundary" }),
      };
    }

    const boundaryText = `--${boundary}`;
    const endBoundaryText = `--${boundary}--`;

    // ✅ Add model field part before the final boundary
    const injection =
      `\r\n${boundaryText}\r\n` +
      `Content-Disposition: form-data; name="model"\r\n\r\n` +
      `whisper-1\r\n`;

    // ✅ Insert injection BEFORE end boundary
    const rawStr = rawBody.toString("latin1");
    const idx = rawStr.lastIndexOf(endBoundaryText);

    if (idx === -1) {
      return {
        statusCode: 400,
        headers: { ...cors, "Content-Type": "application/json" },
        body: JSON.stringify({ error: "Malformed multipart body" }),
      };
    }

    const rebuilt =
      rawStr.slice(0, idx) + injection + rawStr.slice(idx);

    const finalBody = Buffer.from(rebuilt, "latin1");

    const resp = await fetch("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": contentType,
      },
      body: finalBody,
    });

    if (!resp.ok) {
      const txt = await resp.text().catch(() => "");
      return {
        statusCode: resp.status,
        headers: { ...cors, "Content-Type": "application/json" },
        body: JSON.stringify({
          error: "OpenAI transcribe failed",
          details: txt || resp.statusText,
        }),
      };
    }

    const data = await resp.json();
    return {
      statusCode: 200,
      headers: { ...cors, "Content-Type": "application/json" },
      body: JSON.stringify({ text: data.text || "" }),
    };
  } catch (e) {
    return {
      statusCode: 500,
      headers: { ...cors, "Content-Type": "application/json" },
      body: JSON.stringify({
        error: "Server error",
        details: String(e?.message || e),
      }),
    };
  }
}
