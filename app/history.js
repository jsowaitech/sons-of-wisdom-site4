// app/history.js
// Conversation history page controller
// FIXED: per-conversation 3-dot menu overlays correctly + no aria-hidden focus warnings
// Uses [hidden] instead of aria-hidden, and manages aria-expanded.

import { supabase, ensureAuthedOrRedirect } from "./supabase.js";

const $ = (s, r = document) => r.querySelector(s);

// Main list container (support either #list or #conversation-list)
const listEl =
  $("#list") ||
  $("#conversation-list") ||
  (() => {
    const div = document.createElement("div");
    div.id = "list";
    document.body.appendChild(div);
    return div;
  })();

// Template (added in updated history.html)
const itemTpl = $("#conv-item-template");

// Query params
const params = new URLSearchParams(window.location.search);
const returnTo = params.get("returnTo") || "home.html";

/* ----------------------------- helpers -------------------------------- */

function initialFromEmail(email = "") {
  const c = (email || "?").trim()[0] || "?";
  return c.toUpperCase();
}

function convUrl(id) {
  const q = new URLSearchParams({ c: id }).toString();
  return `./home.html?${q}`;
}

function formatDate(ts) {
  if (!ts) return "";
  const d = new Date(ts);
  return d.toLocaleDateString(undefined, { month: "long", day: "numeric" });
}

function normalizeTitle(s) {
  return (s || "").replace(/\s+/g, " ").trim();
}

function isUntitled(title) {
  const t = normalizeTitle(title).toLowerCase();
  return !t || t === "untitled" || t === "new conversation";
}

async function getConvosFromSupabase(userId) {
  if (!userId) return [];

  const { data, error } = await supabase
    .from("conversations")
    .select("id, title, created_at, updated_at")
    .eq("user_id", userId)
    .order("updated_at", { ascending: false });

  if (error) {
    console.error("[HISTORY] Error loading conversations:", error);
    return [];
  }

  return (data || []).map((r) => ({
    id: r.id,
    title: r.title || "Untitled",
    updated_at: r.updated_at || r.created_at || new Date().toISOString(),
  }));
}

/* -------------------------- menu handling ------------------------------ */

function closeAllMenus(exceptActionsEl = null) {
  document.querySelectorAll(".conv-actions.open").forEach((actionsEl) => {
    if (exceptActionsEl && actionsEl === exceptActionsEl) return;

    actionsEl.classList.remove("open");

    const kebab = actionsEl.querySelector(".conv-kebab");
    const menu = actionsEl.querySelector(".conv-menu");

    if (kebab) kebab.setAttribute("aria-expanded", "false");
    if (menu) menu.hidden = true;
  });
}

function toggleMenu(actionsEl) {
  const isOpen = actionsEl.classList.contains("open");
  const kebab = actionsEl.querySelector(".conv-kebab");
  const menu = actionsEl.querySelector(".conv-menu");

  if (!menu) return;

  if (isOpen) {
    actionsEl.classList.remove("open");
    menu.hidden = true;
    if (kebab) kebab.setAttribute("aria-expanded", "false");
    // return focus to kebab for accessibility
    kebab?.focus?.();
    return;
  }

  closeAllMenus(actionsEl);
  actionsEl.classList.add("open");
  menu.hidden = false;
  if (kebab) kebab.setAttribute("aria-expanded", "true");

  // Focus first item for keyboard users
  const firstItem = menu.querySelector(".conv-menu-item");
  firstItem?.focus?.();
}

/* ------------------------- supabase actions ---------------------------- */

async function deleteConversation(convId) {
  // Safe path if FK does not cascade:
  // delete messages first to avoid FK errors.
  const { error: msgErr } = await supabase
    .from("conversation_messages")
    .delete()
    .eq("conversation_id", convId);

  if (msgErr) {
    // If cascade exists, this may still be fine, but log it.
    console.warn("[HISTORY] message delete warning:", msgErr);
  }

  const { error: convErr } = await supabase
    .from("conversations")
    .delete()
    .eq("id", convId);

  if (convErr) throw convErr;
}

async function renameConversation(convId, newTitle) {
  const title = normalizeTitle(newTitle);
  const finalTitle = title || "Untitled";

  const { error } = await supabase
    .from("conversations")
    .update({
      title: finalTitle,
      updated_at: new Date().toISOString(),
    })
    .eq("id", convId);

  if (error) throw error;
  return finalTitle;
}

/* ------------------------------ UI ------------------------------------ */

function showEmptyStateIfNeeded() {
  const remaining =
    listEl?.querySelectorAll(".conv-item:not(.empty)")?.length || 0;
  if (remaining === 0) {
    const empty = document.createElement("div");
    empty.className = "conv-item empty";
    empty.textContent = "No conversations yet. Tap “New Conversation” to start.";
    listEl?.appendChild(empty);
  }
}

function beginInlineRename(rowEl, conv) {
  if (!rowEl) return;

  closeAllMenus();

  const titleTextEl = rowEl.querySelector(".title-text");
  const titleEditEl = rowEl.querySelector(".title-edit");

  if (!titleTextEl || !titleEditEl) {
    alert(
      "Rename UI missing. Please update history.html template to support inline rename."
    );
    return;
  }

  rowEl.classList.add("renaming");

  const current = normalizeTitle(conv.title);
  titleEditEl.value = isUntitled(current) ? "" : current;

  titleEditEl.focus();
  titleEditEl.select();

  let committed = false;

  const cleanup = () => {
    rowEl.classList.remove("renaming");
    titleEditEl.removeEventListener("keydown", onKeyDown);
    titleEditEl.removeEventListener("blur", onBlur);
    titleEditEl.disabled = false;
  };

  const commit = async () => {
    if (committed) return;
    committed = true;

    const nextTitle = normalizeTitle(titleEditEl.value);
    const originalTitle = conv.title || "Untitled";

    if (normalizeTitle(nextTitle) === normalizeTitle(originalTitle)) {
      cleanup();
      return;
    }

    titleTextEl.textContent = nextTitle || "Untitled";
    conv.title = nextTitle || "Untitled";

    titleEditEl.disabled = true;

    try {
      const saved = await renameConversation(conv.id, nextTitle);
      conv.title = saved;
      titleTextEl.textContent = saved;
      cleanup();
    } catch (err) {
      console.error("[HISTORY] rename failed:", err);
      alert("Could not rename conversation. Please try again.");

      conv.title = originalTitle;
      titleTextEl.textContent = originalTitle || "Untitled";

      committed = false;
      titleEditEl.disabled = false;
      titleEditEl.focus();
      titleEditEl.select();
    }
  };

  const cancel = () => {
    if (committed) return;
    committed = true;
    cleanup();
  };

  const onKeyDown = async (e) => {
    e.stopPropagation();

    if (e.key === "Enter") {
      e.preventDefault();
      await commit();
    } else if (e.key === "Escape") {
      e.preventDefault();
      cancel();
    }
  };

  const onBlur = async () => {
    await commit();
  };

  titleEditEl.addEventListener("keydown", onKeyDown);
  titleEditEl.addEventListener("blur", onBlur);

  // Prevent row click while editing
  titleEditEl.addEventListener("click", (e) => e.stopPropagation());
}

function makeConvRow(c) {
  let el;

  if (itemTpl?.content?.firstElementChild) {
    el = itemTpl.content.firstElementChild.cloneNode(true);
  } else {
    el = document.createElement("button");
    el.type = "button";
    el.className = "conv-item";
    el.innerHTML = `
      <div class="conv-main">
        <div class="title">
          <span class="title-text"></span>
          <input class="title-edit" type="text" aria-label="Rename conversation" />
        </div>
        <div class="date tiny muted"></div>
      </div>

      <div class="conv-actions">
        <button class="conv-kebab" type="button" aria-label="Conversation options" aria-expanded="false">
          <span></span><span></span><span></span>
        </button>

        <div class="conv-menu" role="menu" hidden>
          <button class="conv-menu-item" type="button" data-action="rename" role="menuitem">
            Rename
          </button>
          <button class="conv-menu-item danger" type="button" data-action="delete" role="menuitem">
            Delete
          </button>
        </div>
      </div>
    `;
  }

  el.dataset.convId = c.id;

  const titleTextEl = el.querySelector(".title-text") || el.querySelector(".title");
  const dateEl = el.querySelector(".date");
  if (titleTextEl) titleTextEl.textContent = c.title || "Untitled";
  if (dateEl) dateEl.textContent = formatDate(c.updated_at);

  // Clicking the row opens the conversation (unless renaming)
  el.addEventListener("click", () => {
    if (el.classList.contains("renaming")) return;
    window.location.href = convUrl(c.id);
  });

  const actions = el.querySelector(".conv-actions");
  const kebab = el.querySelector(".conv-kebab");
  const menu = el.querySelector(".conv-menu");

  // Ensure base accessibility state
  kebab?.setAttribute("aria-expanded", "false");
  if (menu) menu.hidden = true;

  // Kebab should NOT open the conversation
  kebab?.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (actions) toggleMenu(actions);
  });

  // Menu should NOT open the conversation
  menu?.addEventListener("click", async (e) => {
    e.preventDefault();
    e.stopPropagation();

    const btn = e.target.closest("[data-action]");
    if (!btn) return;

    const action = btn.getAttribute("data-action");

    // close menu
    actions?.classList.remove("open");
    if (menu) menu.hidden = true;
    kebab?.setAttribute("aria-expanded", "false");
    kebab?.focus?.();

    if (action === "rename") {
      beginInlineRename(el, c);
      return;
    }

    if (action === "delete") {
      const ok = confirm("Delete this conversation? This cannot be undone.");
      if (!ok) return;

      // optimistic UI
      el.classList.add("is-busy");

      try {
        await deleteConversation(c.id);
        el.remove();
        showEmptyStateIfNeeded();
      } catch (err) {
        console.error("[HISTORY] delete failed:", err);
        alert("Could not delete conversation. Please try again.");
        el.classList.remove("is-busy");
      }
    }
  });

  // Keyboard: close menu on Escape when focused inside it
  menu?.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      actions?.classList.remove("open");
      if (menu) menu.hidden = true;
      kebab?.setAttribute("aria-expanded", "false");
      kebab?.focus?.();
    }
  });

  return el;
}

function renderConvos(convos) {
  if (!listEl) return;
  listEl.innerHTML = "";

  if (!convos || convos.length === 0) {
    const empty = document.createElement("div");
    empty.className = "conv-item empty";
    empty.textContent = "No conversations yet. Tap “New Conversation” to start.";
    listEl.appendChild(empty);
    return;
  }

  for (const c of convos) {
    listEl.appendChild(makeConvRow(c));
  }
}

async function createConversation(userId) {
  if (!userId) return null;

  const title = "New Conversation";
  try {
    const { data, error } = await supabase
      .from("conversations")
      .insert([{ user_id: userId, title }])
      .select("id")
      .single();

    if (error) throw error;
    return data.id;
  } catch (e) {
    console.error("[HISTORY] Failed to create conversation:", e);
    return null;
  }
}

/* ------------------ global menu dismissal ----------------------------- */

document.addEventListener(
  "click",
  (e) => {
    // If click is inside a conv-actions block, don't immediately close it here.
    if (e.target?.closest?.(".conv-actions")) return;
    closeAllMenus();
  },
  { capture: true }
);

document.addEventListener(
  "keydown",
  (e) => {
    if (e.key === "Escape") closeAllMenus();
  },
  { capture: true }
);

/* --------------------------- bindings --------------------------------- */

$("#btn-close")?.addEventListener("click", () => {
  const dest = decodeURIComponent(returnTo);
  window.location.href = dest.match(/\.html/) ? dest : "home.html";
});

$("#btn-new")?.addEventListener("click", async () => {
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const id = await createConversation(user?.id);
  if (id) {
    window.location.href = convUrl(id);
  }
});

/* ------------------------------ boot ---------------------------------- */

(async function boot() {
  await ensureAuthedOrRedirect();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  // Optional bottom user row support (if you add it later)
  const nameEl = $("#user-name");
  const avatarEl = $("#avatar");

  if (nameEl) {
    nameEl.textContent =
      user?.user_metadata?.full_name || user?.email || "You";
  }
  if (avatarEl) {
    avatarEl.textContent = initialFromEmail(user?.email);
  }

  const convos = await getConvosFromSupabase(user?.id);
  renderConvos(convos);
})();
