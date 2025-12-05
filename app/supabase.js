// app/supabase.js
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// ✅ Your real Supabase project URL
const DEFAULT_SUPABASE_URL = "https://plrobtlpedniyvkpwdmp.supabase.co";

// ⚠️ Replace this with the *anon public* key from:
// Supabase Dashboard → Project Settings → API → "anon public"
const DEFAULT_SUPABASE_ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InBscm9idGxwZWRuaXl2a3B3ZG1wIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NDY2Mjk4NTAsImV4cCI6MjA2MjIwNTg1MH0.7jK32FivCUTXnzG7sOQ9oYUyoJa4OEjMIuNN4eRr-UA";

// Allow optional window overrides, but validate/sanitize
const RAW_URL = (window.SUPABASE_URL || DEFAULT_SUPABASE_URL).trim();
const RAW_KEY = (window.SUPABASE_ANON_KEY || DEFAULT_SUPABASE_ANON_KEY).trim();

function normalizeHttpsOrigin(maybeUrl, fallbackOrigin) {
  try {
    const u = new URL(maybeUrl);
    if (u.protocol !== "https:") throw new Error("Supabase URL must be https");
    // sanitize accidental repeated dots
    u.hostname = u.hostname.replace(/\.+/g, ".");
    return u.origin;
  } catch (e) {
    console.error("[supabase] Invalid SUPABASE_URL:", maybeUrl, e);
    return fallbackOrigin;
  }
}

export const SUPABASE_URL = normalizeHttpsOrigin(RAW_URL, DEFAULT_SUPABASE_URL);
export const SUPABASE_ANON_KEY = RAW_KEY;

console.log("[supabase] Using URL:", SUPABASE_URL);

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true,
    flowType: "pkce",
  },
});

// Helpers used by home.js and other pages
export async function getSession() {
  const { data, error } = await supabase.auth.getSession();
  if (error) throw error;
  return data.session;
}

export async function ensureAuthedOrRedirect(redirectTo = "auth.html") {
  const session = await getSession();
  if (!session?.user) {
    window.location.href = redirectTo;
    throw new Error("Not authenticated");
  }
  return session;
}

export async function signOutAndRedirect(redirectTo = "auth.html") {
  try {
    await supabase.auth.signOut();
  } finally {
    window.location.href = redirectTo;
  }
}
