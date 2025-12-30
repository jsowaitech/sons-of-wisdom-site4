// app/history.js
// Conversation history page controller — patched for kebab menu + rename/delete + animated open

import { supabase, ensureAuthedOrRedirect } from "./supabase.js";

const $ = (s, r = document) => r.querySelector(s);

// Main list container
const listEl =
  $("#list") ||
  $("#conversation-list") ||
  (() => {
    const div = document.createElement("div");
    div.id = "list";
    document.body.appendChild(div);
    return div;
  })();

// Template
const template = $("#conv-item-template");

// Query params
const params = new URLSearchParams(window.location.search);
const returnTo = params.get("returnTo") || "home.html";

// --- helpers -----------------------------------------------------------

function convUrl(id) {
  const q = new URLSearchParams({ c: id }).toString();
  return `./home.html?${q}`;
}

function formatDate(ts) {
  if (!ts) return "";
  const d = new Date(ts);
  return d.toLocaleDateString(undefined, {
    month: "long",
    day: "numeric",
  });
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

async function renameConversation(id, newTitle) {
  if (!id) return false;
  try {
    const { error } = await supabase
      .from("conversations")
      .update({ title: newTitle, updated_at: new Date().toISOString() })
      .eq("id", id);

    if (error) throw error;
    return true;
  } catch (e) {
    console.error("[HISTORY] rename failed:", e);
    return false;
  }
}

async function deleteConversation(id) {
  if (!id) return false;
  try {
    const { error } = await supabase.from("conversations").delete().eq("id", id);
    if (error) throw error;
    return true;
  } catch (e) {
    console.error("[HISTORY] delete failed:", e);
    return false;
  }
}

// --- menu behavior -----------------------------------------------------

function closeAllMenus() {
  document.querySelectorAll(".conv-actions.open").forEach((actions) => {
    actions.classList.remove("open");

    const menu = actions.querySelector(".conv-menu");
    const kebab = actions.querySelector(".conv-kebab");
    const item = actions.closest(".conv-item");

    if (menu) menu.setAttribute("aria-hidden", "true");
    if (kebab) kebab.setAttribute("aria-expanded", "false");
    if (item) item.classList.remove("menu-open");
  });
}

// Close menus on outside click
document.addEventListener("click", (e) => {
  if (!e.target.closest(".conv-actions")) closeAllMenus();
});

// Close menus on Escape
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeAllMenus();
});

// Close menus when list scrolls (prevents float overlaps)
listEl?.addEventListener("scroll", () => closeAllMenus(), { passive: true });

// Close menus on resize (prevents weird alignment on mobile rotation)
window.addEventListener("resize", () => closeAllMenus());

// --- render ------------------------------------------------------------

function renderEmptyState() {
  if (!listEl) return;
  listEl.innerHTML = "";

  const empty = document.createElement("div");
  empty.className = "conv-item empty";
  empty.textContent = "No conversations yet. Tap “New Conversation” to start.";
  listEl.appendChild(empty);
}

function renderConvos(convos) {
  if (!listEl) return;
  listEl.innerHTML = "";

  if (!convos || convos.length === 0) {
    renderEmptyState();
    return;
  }

  for (const c of convos) {
    const node = template?.content
      ? template.content.firstElementChild.cloneNode(true)
      : document.createElement("div");

    // Ensure consistent base
    node.classList.add("conv-item");
    node.dataset.convId = c.id;
    node.setAttribute("data-conv-id", c.id);

    const titleText = node.querySelector(".title-text");
    const titleEdit = node.querySelector(".title-edit");
    const dateEl = node.querySelector(".date");
    const kebabBtn = node.querySelector(".conv-kebab");
    const menu = node.querySelector(".conv-menu");
    const actions = node.querySelector(".conv-actions");

    // Title + date
    if (titleText) titleText.textContent = c.title || "Untitled";
    if (titleEdit) titleEdit.value = c.title || "Untitled";
    if (dateEl) dateEl.textContent = formatDate(c.updated_at);

    // Ensure accessible defaults
    if (menu) menu.setAttribute("aria-hidden", "true");
    if (kebabBtn) kebabBtn.setAttribute("aria-expanded", "false");

    // Clicking row opens conversation (unless renaming or clicking actions)
    node.addEventListener("click", (e) => {
      if (node.classList.contains("renaming")) return;
      if (e.target.closest(".conv-actions")) return;
      if (e.target.closest("input")) return;
      window.location.href = convUrl(c.id);
    });

    // Kebab open/close
    kebabBtn?.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();

      const isOpen = actions?.classList.contains("open");
      closeAllMenus();

      if (!isOpen) {
        actions?.classList.add("open");
        node.classList.add("menu-open"); // lifts row above others
        menu?.setAttribute("aria-hidden", "false");
        kebabBtn?.setAttribute("aria-expanded", "true");
      } else {
        actions?.classList.remove("open");
        node.classList.remove("menu-open");
        menu?.setAttribute("aria-hidden", "true");
        kebabBtn?.setAttribute("aria-expanded", "false");
      }
    });

    // Menu actions (rename/delete)
    menu?.addEventListener("click", async (e) => {
      const btn = e.target.closest("button[data-action]");
      if (!btn) return;

      e.preventDefault();
      e.stopPropagation();

      const action = btn.dataset.action;

      if (action === "rename") {
        closeAllMenus();
        node.classList.add("renaming");

        // Delay focus slightly to avoid Safari glitch
        setTimeout(() => {
          titleEdit?.focus();
          titleEdit?.select();
        }, 0);
      }

      if (action === "delete") {
        closeAllMenus();

        const ok = confirm("Delete this conversation?");
        if (!ok) return;

        const success = await deleteConversation(c.id);
        if (success) {
          node.remove();

          // If list is empty after deletion, show empty state
          if (!listEl.querySelector(".conv-item:not(.empty)")) {
            renderEmptyState();
          }
        }
      }
    });

    // Rename commit (enter / escape)
    titleEdit?.addEventListener("keydown", async (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        titleEdit.blur();
      }

      if (e.key === "Escape") {
        e.preventDefault();
        node.classList.remove("renaming");
        titleEdit.value = titleText?.textContent || "Untitled";
        titleEdit.blur();
      }
    });

    // Rename commit on blur
    titleEdit?.addEventListener("blur", async () => {
      if (!node.classList.contains("renaming")) return;

      const newTitle = (titleEdit.value || "").trim() || "Untitled";

      // Only update if changed
      if (newTitle !== (titleText?.textContent || "").trim()) {
        const ok = await renameConversation(c.id, newTitle);
        if (ok && titleText) titleText.textContent = newTitle;
        if (!ok) titleEdit.value = titleText?.textContent || "Untitled";
      }

      node.classList.remove("renaming");
    });

    listEl.appendChild(node);
  }
}

// --- event bindings ----------------------------------------------------

$("#btn-close")?.addEventListener("click", () => {
  const dest = decodeURIComponent(returnTo);
  window.location.href = dest.match(/\.html/) ? dest : "home.html";
});

$("#btn-new")?.addEventListener("click", async () => {
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const id = await createConversation(user?.id);
  if (id) window.location.href = convUrl(id);
});

// --- boot --------------------------------------------------------------

(async function boot() {
  await ensureAuthedOrRedirect();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  const convos = await getConvosFromSupabase(user?.id);
  renderConvos(convos);
})();
