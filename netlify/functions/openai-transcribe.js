// netlify/functions/openai-transcribe.js
// Son of Wisdom — OpenAI Transcribe proxy (Netlify Function, Node 18+)
//
// Accepts: multipart/form-data from browser (FormData)
// - Looks for an audio file field named: "audio" (preferred) or "file"
// - Forwards to OpenAI /v1/audio/transcriptions
// - Returns: { text }
//
// ENV:
// - OPENAI_API_KEY (required)
// - OPENAI_TRANSCRIBE_MODEL (optional, default: "gpt-4o-mini-transcribe")
//
// Notes:
// - Uses busboy to parse multipart in Netlify Functions reliably.
// - Uses native fetch/FormData/Blob (Node 18+).

import Busboy from "busboy";

export const handler = async (event) => {
  const cors = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
  };

  // Preflight
  if (event.httpMethod === "OPTIONS") {
    return {
      statusCode: 204,
      headers: { ...cors, "Cache-Control": "no-store" },
      body: "",
    };
  }

  // Only POST
  if (event.httpMethod !== "POST") {
    return {
      statusCode: 405,
      headers: { ...cors, "Content-Type": "application/json" },
      body: JSON.stringify({ error: "Method not allowed" }),
    };
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return {
      statusCode: 500,
      headers: { ...cors, "Content-Type": "application/json" },
      body: JSON.stringify({ error: "Missing OPENAI_API_KEY env var" }),
    };
  }

  const MODEL = process.env.OPENAI_TRANSCRIBE_MODEL || "gpt-4o-mini-transcribe";

  try {
    const contentType =
      event.headers["content-type"] || event.headers["Content-Type"] || "";

    if (!String(contentType).includes("multipart/form-data")) {
      return {
        statusCode: 400,
        headers: { ...cors, "Content-Type": "application/json" },
        body: JSON.stringify({ error: "Expected multipart/form-data" }),
      };
    }

    // Parse multipart
    const bb = Busboy({ headers: { "content-type": contentType } });

    let audioBuffer = null;
    let audioFilename = "audio.webm";
    let audioMime = "audio/webm";
    let gotFileField = "";

    bb.on("file", (fieldname, file, info) => {
      // We accept "audio" or "file" (browser may send either)
      if (fieldname !== "audio" && fieldname !== "file") {
        // Drain unused file streams to avoid hanging
        file.resume();
        return;
      }

      gotFileField = fieldname;

      const { filename, mimeType } = info || {};
      if (filename) audioFilename = filename;
      if (mimeType) audioMime = mimeType;

      const chunks = [];
      file.on("data", (d) => chunks.push(d));
      file.on("end", () => {
        audioBuffer = Buffer.concat(chunks);
      });
    });

    // (Optional) collect fields, in case you want to use them later
    // e.g. "mime" from client, but we primarily trust the file mimeType
    bb.on("field", (_name, _val) => {});

    const finished = new Promise((resolve, reject) => {
      bb.on("finish", resolve);
      bb.on("error", reject);
    });

    const bodyBuf = event.isBase64Encoded
      ? Buffer.from(event.body || "", "base64")
      : Buffer.from(event.body || "", "utf8");

    bb.end(bodyBuf);
    await finished;

    if (!audioBuffer || !audioBuffer.length) {
      return {
        statusCode: 400,
        headers: { ...cors, "Content-Type": "application/json" },
        body: JSON.stringify({
          error: "Missing audio file",
          hint: "Send multipart/form-data with a file field named 'audio' (preferred) or 'file'.",
        }),
      };
    }

    // Build OpenAI form-data
    const fd = new FormData();
    fd.append("file", new Blob([audioBuffer], { type: audioMime }), audioFilename);
    fd.append("model", MODEL);

    // You can optionally add language hints:
    // fd.append("language", "en");

    const resp = await fetch("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
      body: fd,
    });

    if (!resp.ok) {
      const txt = await resp.text().catch(() => "");
      return {
        statusCode: resp.status,
        headers: { ...cors, "Content-Type": "application/json" },
        body: JSON.stringify({
          error: "OpenAI transcribe failed",
          details: txt || resp.statusText,
          model: MODEL,
          received_file_field: gotFileField || null,
          received_mime: audioMime,
        }),
      };
    }

    const data = await resp.json().catch(() => ({}));
    return {
      statusCode: 200,
      headers: {
        ...cors,
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
      },
      body: JSON.stringify({ text: data?.text || "" }),
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
};
