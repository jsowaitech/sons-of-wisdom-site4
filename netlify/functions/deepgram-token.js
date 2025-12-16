// netlify/functions/deepgram-token.js
// Returns a short-lived Deepgram temporary key (access_token) for browser WebSocket usage.
//
// IMPORTANT:
// - Requires Netlify env var: DEEPGRAM_API_KEY (your Deepgram Project API Key)
// - This function must NOT be cached by CDNs/browsers.
// - For mobile reliability, keep ttl small (e.g., 60–300s) and refresh when needed.

export async function handler(event) {
  try {
    // CORS (mobile browsers sometimes call preflight depending on headers)
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
    };

    if (event.httpMethod === "OPTIONS") {
      return {
        statusCode: 204,
        headers: {
          ...corsHeaders,
          "Cache-Control": "no-store",
        },
        body: "",
      };
    }

    if (event.httpMethod !== "GET") {
      return {
        statusCode: 405,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
        body: JSON.stringify({ error: "Method not allowed" }),
      };
    }

    const apiKey = process.env.DEEPGRAM_API_KEY;
    if (!apiKey) {
      return {
        statusCode: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
        body: JSON.stringify({ error: "Missing DEEPGRAM_API_KEY env var" }),
      };
    }

    // ttl via query param (seconds), bounded
    // Recommended: 60–300 seconds for browser WS usage.
    const url = new URL(event.rawUrl || "https://x.local/?");
    let ttl = Number(url.searchParams.get("ttl") || "120");
    if (!Number.isFinite(ttl)) ttl = 120;
    ttl = Math.max(1, Math.min(3600, ttl)); // Deepgram allows 1..3600

    const resp = await fetch("https://api.deepgram.com/v1/auth/grant", {
      method: "POST",
      headers: {
        Authorization: `Token ${apiKey}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({ ttl_seconds: ttl }),
    });

    if (!resp.ok) {
      const txt = await resp.text().catch(() => "");
      return {
        statusCode: resp.status,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
        body: JSON.stringify({
          error: "Deepgram token request failed",
          status: resp.status,
          details: txt || resp.statusText,
        }),
      };
    }

    const data = await resp.json().catch(() => ({}));
    const access_token = data.access_token || "";
    const expires_in = data.expires_in ?? null;

    if (!access_token) {
      return {
        statusCode: 502,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
        body: JSON.stringify({ error: "Deepgram token missing access_token" }),
      };
    }

    return {
      statusCode: 200,
      headers: {
        ...corsHeaders,
        "Content-Type": "application/json",
        "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate",
        Pragma: "no-cache",
        Expires: "0",
      },
      body: JSON.stringify({ access_token, expires_in }),
    };
  } catch (e) {
    return {
      statusCode: 500,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
      },
      body: JSON.stringify({
        error: "Server error",
        details: String(e?.message || e),
      }),
    };
  }
}
