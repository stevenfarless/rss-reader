(() => {
"use strict";

/* RSS Reader — client-only, PWA.
   Feed loading, in order, all from this page (no install, no backend of ours):
   1. Direct fetch of the feed (works when the publisher sends CORS headers).
   2. WordPress REST API (/wp-json/wp/v2/posts) for WordPress sites — WordPress
      sends permissive CORS headers on its API even when its /feed does not.
   3. A public feed-to-JSON service (rss2json), only when the user opts in
      in Settings ("proxyFallback"): the feed passes through a third party.
   Full-article text is fetched the same way: directly, or via the
   WordPress API looked up by the article slug (which returns full
   content), or via the opt-in reader/proxy services. */

const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const K = "rss-reader.feeds.v1", S = "rss-reader.settings.v1", DB = "rss-reader-cache";
const KF = "rss-reader.folders.v1", KT = "rss-reader.tags.v1", LR = "rss-reader.lastRefresh.v1";
const KS = "rss-reader.savedSearches.v1", KR = "rss-reader.rules.v1";
const PROXY_API = "https://api.rss2json.com/v1/api.json?rss_url=";
const ALLORIGINS = "https://api.allorigins.win/raw?url=";
const JINA = "https://r.jina.ai/";
const FETCH_TIMEOUT_MS = 15000;
const PROXY_TIMEOUT_MS = 30000;
const MAX_ITEMS_PER_FEED = 200;
/* The version shown in Settings and in the update check (#144). Bump
   it with every release, alongside package.json and the SW cache. */
const APP_VERSION = "1.8.4";

const state = {
  feeds: [], items: [], highlights: [], view: "all", feed: null, folder: null, filter: "all",
  sort: "newest", query: "", selected: null, tag: null, savedSearch: null,
  folders: [], tags: [], savedSearches: [], rules: [],
  settings: { theme: "dark", width: "comfortable", size: "normal", readerFont: "serif", lineHeight: "comfortable", ttsRate: 1, hideDuplicates: true, proxyFallback: false, sidebarCollapsed: false, sidebarWidth: 230, listWidth: 430, sort: "newest", filter: "all", progressPosition: "bottom", cardExcerpt: "full", cardImage: true, backgroundSync: false, notifyNew: false }
};
let db, timer, pendingG = null, refreshAt = 0, orgEdit = null, pendingDelete = null, searchTimer = null, ruleEdit = null;
/* Text-to-speech state (#105): the article being read, its sentence
   chunks, and where playback has reached. Null when nothing is playing. */
let tts = null;

const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
}[c]));
const id = () => crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random();
const host = u => { try { return new URL(u).hostname.replace(/^www\./, ""); } catch { return u; } };
const stripTags = s => String(s ?? "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
const decodeHtml = s => {
  const t = document.createElement("textarea");
  t.innerHTML = String(s ?? "");
  return t.value;
};
const plainText = s => decodeHtml(stripTags(s));
/* Inline SVG icons from the <symbol> sprite in index.html. */
const icon = (name, cls) => `<svg class="ic${cls ? " " + cls : ""}" aria-hidden="true"><use href="#i-${name}"/></svg>`;
/* Relative dates for list cards ("5m ago", "Yesterday"), with the full
   date kept in the title attribute. */
const relDate = d => {
  if (!d) return "No date";
  const s = Math.max(0, (Date.now() - d.getTime()) / 1000);
  if (s < 60) return "Just now";
  if (s < 3600) return Math.floor(s / 60) + "m ago";
  if (s < 86400) return Math.floor(s / 3600) + "h ago";
  const days = Math.floor(s / 86400);
  if (days === 1) return "Yesterday";
  if (days < 7) return days + "d ago";
  return d.toLocaleDateString();
};
/* Shorten text for list cards: cut at a word boundary and add an
   ellipsis, instead of slicing mid-word. */
/* Estimated reading time (#110): words in the text the reader would
   show (full text when loaded, otherwise the feed content or summary)
   at about 200 words per minute. Under 40 words there is nothing
   worth estimating, so the caller omits it. */
const readingTimeText = x => {
  const words = plainText(x.fullContent || x.content || x.summary || "").split(/\s+/).filter(Boolean).length;
  if (words < 40) return "";
  return Math.max(1, Math.round(words / 200)) + " min read";
};
/* Canonical article URL (#115): the strict duplicate definition. The
   same story at the same address is one article, even when feeds carry
   it with different tracking parameters, a fragment, or a www prefix.
   A different address is a different article, even with the same title. */
/* Byline timestamp without seconds ("11/16/2026 · 11:00 AM"). */
const fmtDateTime = d => d.toLocaleDateString() + " · " + d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
/* Strip publisher boilerplate out of summaries before they reach the
   list. Hacker News descriptions are "Article URL: … Comments URL: …
   Points: N # Comments: M"; some feeds (e.g. NASA APOD via WordPress)
   ship site navigation in the summary, which is cut at the first nav
   marker with the leading header tokens dropped. */
/* Strip publisher navigation boilerplate from the top of an article
   body element, using the same NAV_MARKERS as the summary cleaner so
   the two rules stay in sync. Only the leading boilerplate is removed:
   the run of leading nodes whose text contains a marker. A marker that
   appears later in the body is legitimate content and is left alone.
   A container holding nav and article together is stripped from the
   inside, and nav mixed with article text in one long node is cut
   through the last marker instead of deleting the node. A leading
   breadcrumb — a short list whose text holds a run of the article
   title — is also removed, so a nav block sitting under it becomes
   leading and is stripped too. Returns false when the strip would
   remove more than 40% of the body text, so the caller can keep the
   un-stripped body rather than risk gutting the article. Runs after
   cleanHTML has dropped the page chrome, so a nav block that sat under
   the site header is leading by the time it runs. */
function stripLeadingNavEl(body, title) {
  const total = (body.textContent || "").length;
  let removed = 0;
  const cutAfterLastMarker = n => {
    const raw = n.textContent || "";
    const norm = raw.replace(/[\u2018\u2019]/g, "'");
    let end = -1;
    for (const m of NAV_MARKERS) {
      const i = norm.lastIndexOf(m);
      if (i >= 0) end = Math.max(end, i + m.length);
    }
    if (end < 0) return true;
    const rest = raw.slice(end).replace(/^[\s|·:–—-]+/, "");
    if (!rest.trim()) { n.remove(); return false; }
    n.textContent = rest;
    return true;
  };
  const strip = el => {
    while (el.firstChild) {
      const n = el.firstChild;
      const t = (n.textContent || "").replace(/\s+/g, " ").trim();
      // Empty nodes are skipped, except media (an image paragraph is
      // article content, not boilerplate) which stops the strip.
      if (!t) {
        const hasMedia = n.nodeType === Node.ELEMENT_NODE && n.querySelector("img,video,audio,iframe,canvas,svg,object,embed");
        if (hasMedia) return true;
        el.removeChild(n);
        continue;
      }
      if (!NAV_MARKERS.some(m => t.includes(m))) {
        // A leading breadcrumb (a short list holding a run of the
        // article title) is boilerplate too; removing it lets the nav
        // block under it become leading and be stripped.
        if (n.nodeType === Node.ELEMENT_NODE && (n.tagName === "OL" || n.tagName === "UL") &&
            t.length < 300 && title && titleAnchorPos(t, title) >= 0) {
          el.removeChild(n);
          removed += t.length;
          if (removed > total * 0.4) return false;
          continue;
        }
        return true;
      }
      if (n.nodeType === Node.ELEMENT_NODE && n.children.length && t.length > 400) {
        if (!strip(n)) return false;
        if (!n.textContent.trim()) { el.removeChild(n); continue; }
        return true;
      }
      if (t.length > 400) {
        if (cutAfterLastMarker(n)) return true;
        continue;
      }
      el.removeChild(n);
      removed += t.length;
      if (removed > total * 0.4) return false;
    }
    return true;
  };
  return strip(body);
}
/* Position of the article title inside a body of text, as the longest run
   of consecutive title words (at least 3) that appears in the text, or -1
   when no such run exists. Title prefixes (a site name, a date, "APOD: …")
   are skipped by trying shorter runs from the front. */
function titleAnchorPos(text, title) {
  const words = String(title || "").split(/\s+/).filter(Boolean);
  for (let len = words.length; len >= 3; len--) {
    for (let i = 0; i + len <= words.length; i++) {
      const phrase = words.slice(i, i + len).join(" ");
      const pos = text.indexOf(phrase);
      if (pos >= 0) return pos;
    }
  }
  return -1;
}
/* Drop everything before the first block containing the article title.
   Reader-service output (and some feed content) can carry the whole page
   — site menus, nav, footer — flattened into plain blocks with no
   structure to strip by tag or class. The title is the one reliable
   anchor: it sits at the head of the article itself. Only cuts when the
   title is within the first 8000 characters and no long prose paragraph
   sits before it — a title mentioned late in a real article is a mention,
   not the article head, and the prose before it is the article itself.
   Returns true when it removed anything. */
function cutBeforeTitleEl(body, title) {
  const text = body.textContent || "";
  const pos = titleAnchorPos(text, title);
  if (pos < 0 || pos > 8000) return false;
  let seen = 0;
  let longProse = 0;
  const toRemove = [];
  for (const child of [...body.children]) {
    const len = (child.textContent || "").length;
    if (seen + len > pos) break;
    if ((child.tagName === "P" || child.tagName === "BLOCKQUOTE") && len > 300) longProse += len;
    seen += len;
    toRemove.push(child);
  }
  // If most of what would be removed is article prose, the title is a
  // late mention, not the article head — leave it alone.
  if (seen > 0 && longProse / seen > 0.5) return false;
  toRemove.forEach(c => body.removeChild(c));
  return toRemove.length > 0;
}
/* Feed label for a list card. The stored feedTitle can be empty for
   items saved by an older build, and the feed may have been re-added
   since (new id), so fall back to the feed's current title, then to
   matching the article's host against the feeds' sites and feed URLs.
   The host match ignores scheme and www, since older saved links can
   be http: while the feed is now https:. */
const feedTitleFor = x => {
  if (x.feedTitle) return x.feedTitle;
  const byId = state.feeds.find(f => f.id === x.feedId);
  if (byId?.title) return byId.title;
  try {
    const host = new URL(x.url).hostname.replace(/^www\./, "");
    const byHost = state.feeds.find(f => [f.site, f.url].some(u => {
      try { return u && new URL(u).hostname.replace(/^www\./, "") === host; } catch { return false; }
    }));
    if (byHost?.title) return byHost.title;
  } catch {}
  return "";
};

function toast(s, action) {
  const e = $("#toast");
  e.textContent = s;
  if (action) {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = action.label;
    b.onclick = () => { e.classList.remove("show"); action.fn(); };
    e.appendChild(b);
  }
  e.classList.add("show");
  clearTimeout(timer);
  // Long messages stay up longer so they can actually be read; an
  // action (e.g. Undo) gets a full 8 seconds to be noticed and used.
  const ms = action ? 8000 : Math.min(9000, 3200 + Math.max(0, s.length - 60) * 30);
  timer = setTimeout(() => e.classList.remove("show"), ms);
}
function local(k, v) {
  try { localStorage.setItem(k, JSON.stringify(v)); }
  catch (e) { toast("Browser storage is full."); }
}
/* Whitelist + validate stored settings: unknown keys and out-of-range
   values are dropped instead of silently corrupting the settings.
   Shared by loadLocal (a corrupt localStorage entry) and
   importSettings (an imported file). */
function validateSettings(d) {
  if (!d || typeof d !== "object") return {};
  const pick = (sel, val) => { const opts = [...$(sel).options].map(o => o.value); return opts.includes(val) ? val : null; };
  const next = {};
  const theme = pick("#themeSelect", d.theme); if (theme) next.theme = theme;
  const width = pick("#widthSelect", d.width); if (width) next.width = width;
  const size = pick("#sizeSelect", d.size); if (size) next.size = size;
  const font = pick("#fontSelect", d.readerFont); if (font) next.readerFont = font;
  const lh = pick("#lineHeightSelect", d.lineHeight); if (lh) next.lineHeight = lh;
  if (typeof d.ttsRate === "number" && d.ttsRate >= 0.5 && d.ttsRate <= 2) next.ttsRate = d.ttsRate;
  const prog = pick("#progressSelect", d.progressPosition); if (prog) next.progressPosition = prog;
  const exc = pick("#cardExcerptSelect", d.cardExcerpt); if (exc) next.cardExcerpt = exc;
  if (typeof d.cardImage === "boolean") next.cardImage = d.cardImage;
  if (typeof d.hideDuplicates === "boolean") next.hideDuplicates = d.hideDuplicates;
  if (typeof d.backgroundSync === "boolean") next.backgroundSync = d.backgroundSync;
  if (typeof d.notifyNew === "boolean") next.notifyNew = d.notifyNew;
  if (typeof d.proxyFallback === "boolean") next.proxyFallback = d.proxyFallback;
  if (typeof d.sidebarCollapsed === "boolean") next.sidebarCollapsed = d.sidebarCollapsed;
  if (typeof d.sidebarWidth === "number" && d.sidebarWidth >= 180 && d.sidebarWidth <= 420) next.sidebarWidth = d.sidebarWidth;
  if (typeof d.listWidth === "number" && d.listWidth >= 320 && d.listWidth <= 640) next.listWidth = d.listWidth;
  if (d.sort === "newest" || d.sort === "oldest") next.sort = d.sort;
  if (["all", "today", "week"].includes(d.filter)) next.filter = d.filter;
  return next;
}
function loadLocal() {
  try {
    state.feeds = JSON.parse(localStorage.getItem(K) || "[]");
    if (!Array.isArray(state.feeds)) throw Error("bad feeds");
  } catch {
    try {
      state.feeds = JSON.parse(localStorage.getItem(K + ".bak") || "[]");
      if (!Array.isArray(state.feeds)) throw Error("bad backup");
      state.feedsRestored = true;
    } catch { state.feeds = []; }
  }
  try { state.settings = { ...state.settings, ...validateSettings(JSON.parse(localStorage.getItem(S) || "{}")) }; } catch {}
  state.sort = state.settings.sort === "oldest" ? "oldest" : "newest";
  state.filter = ["all", "today", "week"].includes(state.settings.filter) ? state.settings.filter : "all";
  try { state.folders = JSON.parse(localStorage.getItem(KF) || "[]"); } catch {}
  try { state.tags = JSON.parse(localStorage.getItem(KT) || "[]"); } catch {}
  try { state.savedSearches = JSON.parse(localStorage.getItem(KS) || "[]"); if (!Array.isArray(state.savedSearches)) state.savedSearches = []; } catch { state.savedSearches = []; }
  try { state.rules = JSON.parse(localStorage.getItem(KR) || "[]"); if (!Array.isArray(state.rules)) state.rules = []; } catch { state.rules = []; }
  try { state.lastRefresh = Number(localStorage.getItem(LR) || 0) || 0; } catch { state.lastRefresh = 0; }
  syncFolders();
}
function saveFeeds() {
  // Keep a backup copy: a corrupt primary entry must not silently
  // erase every subscription (loadLocal restores from it).
  local(K, state.feeds);
  local(K + ".bak", state.feeds);
  mirrorSync();
}
function saveFolders() { local(KF, state.folders); }
function saveTags() { local(KT, state.tags); }
function saveSavedSearches() { local(KS, state.savedSearches); }
function saveRules() { local(KR, state.rules); }
/* Folders come from the stored list plus any group a feed already has
   (e.g. from an OPML import), so imported folders never vanish. */
function syncFolders() {
  const names = new Set(state.folders);
  for (const f of state.feeds) if (f.group) names.add(f.group);
  state.folders = [...names].sort((a, b) => a.localeCompare(b));
}
/* Tags likewise: the stored list plus any tag already on an article. */
function syncTags() {
  const names = new Set(state.tags);
  for (const x of state.items) for (const t of x.tags || []) names.add(t);
  state.tags = [...names].sort((a, b) => a.localeCompare(b));
}

/* ---------- storage ---------- */
/* IndexedDB connections can be closed by the browser (versionchange from
   another tab, storage pressure). A closed connection makes every
   transaction throw "The database connection is closing", so every
   operation retries once after reopening. */
function openDB() {
  return new Promise((res, rej) => {
    const r = indexedDB.open(DB, 3);
    r.onupgradeneeded = () => {
      const d = r.result;
      if (!d.objectStoreNames.contains("items")) d.createObjectStore("items", { keyPath: "id" });
      // The service worker reads this store for background refresh:
      // it cannot see localStorage, so the feed list and the
      // sync-relevant settings are mirrored here.
      if (!d.objectStoreNames.contains("sync")) d.createObjectStore("sync", { keyPath: "key" });
      // Highlights (#116): the article id, the selected text, and an
      // optional note, rendered back into the article when it opens.
      if (!d.objectStoreNames.contains("highlights")) d.createObjectStore("highlights", { keyPath: "id" });
    };
    r.onsuccess = () => {
      r.result.onclose = () => { db = null; };
      res(r.result);
    };
    r.onerror = () => rej(r.error);
  });
}
function runTx(mode, op, store = "items") {
  return new Promise((resolve, reject) => {
    let retries = 0;
    const attempt = () => {
      if (!db) {
        openDB().then(ndb => { db = ndb; attempt(); }).catch(reject);
        return;
      }
      let req;
      try {
        req = op(db.transaction(store, mode).objectStore(store));
      } catch (e) {
        if (retries < 1) {
          retries++;
          db = null;
          attempt();
        } else reject(e);
        return;
      }
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    };
    attempt();
  });
}
function dbAll() { return runTx("readonly", s => s.getAll()); }
function put(item) { return runTx("readwrite", s => s.put(item)); }
function dbDelete(itemId) { return runTx("readwrite", s => s.delete(itemId)); }
/* Highlights (#116) live in their own store, keyed by highlight id. */
function hlAll() { return runTx("readonly", s => s.getAll(), "highlights"); }
function hlPut(h) { return runTx("readwrite", s => s.put(h), "highlights"); }
function hlDelete(hlId) { return runTx("readwrite", s => s.delete(hlId), "highlights"); }
/* Batch IndexedDB writes: one transaction for many items, with the
   same reopen-and-retry as runTx. */
function runBatch(mode, fn, store = "items") {
  return new Promise((resolve, reject) => {
    let retries = 0;
    const attempt = () => {
      if (!db) { openDB().then(ndb => { db = ndb; attempt(); }).catch(reject); return; }
      let tx;
      try { tx = db.transaction(store, mode); fn(tx.objectStore(store)); }
      catch (e) { if (retries < 1) { retries++; db = null; attempt(); } else reject(e); return; }
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    };
    attempt();
  });
}
function putMany(items) { return runBatch("readwrite", s => { for (const x of items) s.put(x); }); }
function deleteMany(ids) { return runBatch("readwrite", s => { for (const id of ids) s.delete(id); }); }
/* Mirror the feed list and the sync-relevant settings into IndexedDB,
   where the service worker can read them for background refresh.
   Fire-and-forget: a mirror failure must not break the UI. */
function mirrorSync() {
  const feeds = state.feeds.map(f => ({ id: f.id, url: f.url, title: f.title, via: f.via, wpRoot: f.wpRoot, site: f.site }));
  const settings = { proxyFallback: !!state.settings.proxyFallback, notifyNew: !!state.settings.notifyNew };
  runBatch("readwrite", s => {
    s.put({ key: "feeds", value: feeds });
    s.put({ key: "settings", value: settings });
  }, "sync").catch(() => {});
}
/* Periodic Background Sync registration. Only Chrome on Android (for an
   installed PWA) supports it; elsewhere the registration throws and the
   setting is turned back off with an explanation. Notifications only
   come from a background refresh, so turning refresh off also turns
   notifications off. */
async function applyBackgroundSync(quiet) {
  const off = (msg) => {
    state.settings.backgroundSync = false;
    state.settings.notifyNew = false;
    local(S, state.settings);
    mirrorSync();
    const b = $("#backgroundSyncToggle"), n = $("#notifyNewToggle");
    if (b) b.checked = false;
    if (n) n.checked = false;
    if (msg && !quiet) toast(msg);
  };
  if (!("serviceWorker" in navigator)) { if (state.settings.backgroundSync) off("Background refresh is not available in this browser."); return; }
  let reg;
  try { reg = await navigator.serviceWorker.ready; } catch { reg = null; }
  if (!reg || !("periodicSync" in reg)) { if (state.settings.backgroundSync) off("Background refresh is not available in this browser. It needs Chrome on Android with the app installed."); return; }
  if (state.settings.backgroundSync) {
    try {
      const status = await navigator.permissions.query({ name: "periodic-background-sync" });
      if (status.state === "denied") throw Error("denied");
      // 12 hours is the minimum the browser allows; it decides the
      // actual timing and may run less often.
      await reg.periodicSync.register("refresh-feeds", { minInterval: 12 * 60 * 60 * 1000 });
    } catch (e) {
      off("Background refresh could not be turned on. It needs Chrome on Android with the app installed, and the browser grants it based on use.");
      return;
    }
    if (state.settings.notifyNew && "Notification" in window) {
      const perm = await Notification.requestPermission();
      if (perm !== "granted") {
        state.settings.notifyNew = false;
        local(S, state.settings);
        mirrorSync();
        const n = $("#notifyNewToggle");
        if (n) n.checked = false;
        if (!quiet) toast("Notifications are blocked in this browser, so new-article notifications are off.");
      }
    }
  } else {
    try { await reg.periodicSync.unregister("refresh-feeds"); } catch {}
    if (state.settings.notifyNew) {
      state.settings.notifyNew = false;
      local(S, state.settings);
      mirrorSync();
      const n = $("#notifyNewToggle");
      if (n) n.checked = false;
    }
  }
}

/* ---------- settings ---------- */
function applySettings() {
  let t = state.settings.theme;
  if (t === "system") t = matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
  document.documentElement.dataset.theme = t;
  // Keep the browser chrome (status bar, task switcher) on the same
  // color as the theme, so the theme never flashes the wrong color.
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.content = t === "light" ? "#f4f2ec" : "#171916";
  document.documentElement.dataset.width = state.settings.width;
  document.documentElement.dataset.size = state.settings.size;
  // Reader typography (#111): serif/comfortable are the defaults, so
  // the existing look is unchanged until the user picks otherwise.
  document.documentElement.dataset.readerFont = state.settings.readerFont || "serif";
  document.documentElement.dataset.lineHeight = state.settings.lineHeight || "comfortable";
  applySidebarCollapsed();
  applyPaneWidths();
}
/* Sidebar collapse: the sidebar becomes a 52px rail holding only the
   toggle (top left), so the list and reader get the full width. The
   choice persists with the other settings. */
function applySidebarCollapsed() {
  const collapsed = !!state.settings.sidebarCollapsed;
  document.body.classList.toggle("sidebar-collapsed", collapsed);
  const btn = $("#sideToggle");
  if (!btn) return;
  btn.setAttribute("aria-expanded", String(!collapsed));
  btn.setAttribute("aria-label", collapsed ? "Expand sidebar" : "Collapse sidebar");
  btn.title = collapsed ? "Expand sidebar" : "Collapse sidebar";
  // The chevron icon flips via CSS (body.sidebar-collapsed rotates it).
  positionSplitters();
}

/* Draggable pane widths (#90): the sidebar and article-list widths are
   CSS variables on the grid (--side-w, --list-w), persisted in settings.
   The splitter handles are absolutely positioned in .layout and placed
   from the panes' actual rects, so they stay on the boundary even when
   the grid clamps a column on a narrow viewport. */
const SIDE_W = { min: 180, max: 420, def: 230 };
const LIST_W = { min: 320, max: 640, def: 430 };
function clampW(v, r) { return Math.min(r.max, Math.max(r.min, Math.round(v) || r.def)); }
function applyPaneWidths() {
  const side = clampW(state.settings.sidebarWidth, SIDE_W);
  const list = clampW(state.settings.listWidth, LIST_W);
  state.settings.sidebarWidth = side;
  state.settings.listWidth = list;
  document.documentElement.style.setProperty("--side-w", side + "px");
  document.documentElement.style.setProperty("--list-w", list + "px");
  // The splitters report their size to assistive tech, like a slider.
  const ss = $("#splitSide"), sl = $("#splitList");
  if (ss) ss.setAttribute("aria-valuenow", String(side));
  if (sl) sl.setAttribute("aria-valuenow", String(list));
  positionSplitters();
}
/* Place the splitter handles on the panes' right edges. Skipped on
   mobile, where the sidebar is a drawer and the splitters are hidden. */
function positionSplitters() {
  if (!matchMedia("(min-width:821px)").matches) return;
  const layout = $(".layout");
  const side = $("#sidebar"), list = $(".list-pane");
  if (!layout || !side || !list) return;
  const l = layout.getBoundingClientRect();
  const place = (el, edge) => { if (el) el.style.left = (edge - l.left - 4.5) + "px"; };
  place($("#splitSide"), side.getBoundingClientRect().right);
  place($("#splitList"), list.getBoundingClientRect().right);
}
/* Pointer drag on a splitter: move the pane edge, live. Double-click
   resets that pane to its default width; arrow keys nudge it. */
function bindSplitter(el, kind) {
  if (!el) return;
  const range = kind === "side" ? SIDE_W : LIST_W;
  const key = kind === "side" ? "sidebarWidth" : "listWidth";
  el.addEventListener("pointerdown", e => {
    if (e.button !== 0) return;
    e.preventDefault();
    el.setPointerCapture(e.pointerId);
    el.classList.add("dragging");
    document.body.classList.add("dragging-splitter");
    const startX = e.clientX, start = state.settings[key];
    const move = ev => {
      state.settings[key] = clampW(start + (ev.clientX - startX), range);
      document.documentElement.style.setProperty(kind === "side" ? "--side-w" : "--list-w", state.settings[key] + "px");
      el.setAttribute("aria-valuenow", String(state.settings[key]));
      positionSplitters();
    };
    const up = () => {
      el.classList.remove("dragging");
      document.body.classList.remove("dragging-splitter");
      // A drag can still leave a selection behind; clear it (#139).
      try { getSelection()?.removeAllRanges(); } catch {}
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      el.removeEventListener("pointercancel", up);
      local(S, state.settings);
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", up);
  });
  el.addEventListener("dblclick", () => {
    state.settings[key] = range.def;
    applyPaneWidths();
    local(S, state.settings);
  });
  el.addEventListener("keydown", e => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    state.settings[key] = clampW(state.settings[key] + (e.key === "ArrowRight" ? 10 : -10), range);
    applyPaneWidths();
    local(S, state.settings);
  });
}
function bindSplitters() {
  bindSplitter($("#splitSide"), "side");
  bindSplitter($("#splitList"), "list");
  window.addEventListener("resize", positionSplitters);
}

/* Reading progress (#92): thin bar at the bottom of the reader, filled
   by how far the open article is scrolled. Hidden when the article is
   too short to scroll. */
function updateReadProgress() {
  const reader = $("#reader"), bar = $("#readProgress");
  if (!reader || !bar) return;
  const max = reader.scrollHeight - reader.clientHeight;
  // A few pixels of scrollable distance is rounding and the bar's own
  // height, not a real scroll: hide the bar for a short article.
  if (max < 10) { bar.style.display = "none"; return; }
  bar.style.display = "";
  const pct = Math.min(100, Math.max(0, reader.scrollTop / max * 100));
  bar.firstElementChild.style.width = pct + "%";
}

/* Dates: null when missing/unparseable, so dateless items sort after dated
   ones instead of silently becoming 1970-01-01. */
function date(v) {
  if (!v) return null;
  const d = new Date(v);
  return isNaN(d) ? null : d;
}
function dateSortKey(x) {
  const d = date(x.published);
  return d ? d.getTime() : null;
}

/* ---------- error classification ---------- */
function classifyError(e, wasHttp) {
  if (e && e.name === "AbortError") return "Timed out after " + (FETCH_TIMEOUT_MS / 1000) + "s. The publisher did not respond in time.";
  const msg = String((e && e.message) || e || "");
  if (/Failed to fetch|NetworkError|Load failed|Network request failed/i.test(msg)) {
    // The address was http: and was rewritten to https: for the fetch, so
    // name the original scheme instead of blaming the rewritten one.
    if (wasHttp) return "Could not be reached from this browser. This feed only serves http:, which a secure page cannot load. Try the site's https address, if it has one.";
    return "Could not be reached from this browser. This usually means the publisher does not allow cross-origin requests (CORS), or the address uses http: on a secure page.";
  }
  if (/^HTTP \d+/.test(msg)) return "The publisher answered with " + msg + ".";
  if (/No feed link found/i.test(msg)) return msg;
  if (/not a supported/i.test(msg)) return msg;
  return msg || "Could not load this feed.";
}

/* ---------- fetching ---------- */
async function fetchWithTimeout(url, opts = {}, ms = FETCH_TIMEOUT_MS) {
  const r = await fetch(url, { ...opts, signal: AbortSignal.timeout(ms) });
  return r;
}
async function fetchText(url) {
  const r = await fetchWithTimeout(url, {
    headers: { Accept: "application/atom+xml,application/rss+xml,application/xml,text/xml,application/feed+json,application/json,*/*" },
    cache: "no-store"
  });
  if (!r.ok) throw Error("HTTP " + r.status);
  return { text: await r.text(), finalUrl: r.url || url };
}
const looksLikeFeed = t => {
  const s = t.trim();
  return s.startsWith("<?xml") || /<(rss|feed|rdf:RDF)\b/i.test(s) || s.startsWith("{");
};

/* ---------- feed parsing ---------- */
/* localName-based lookups: getElementsByTagName("creator") does NOT match
   <dc:creator>, and <content:encoded> is localName "encoded". */
function childEl(node, name) {
  if (!node) return null;
  for (const c of node.childNodes) {
    if (c.nodeType === 1 && c.localName === name) return c;
  }
  return null;
}
function childText(node, name) {
  const el = childEl(node, name);
  return el ? (el.textContent || "").trim() : "";
}
function atomLink(node) {
  if (!node) return "";
  const links = [...node.childNodes].filter(c => c.nodeType === 1 && c.localName === "link");
  const pick = links.find(l => l.getAttribute("rel") === "alternate")
    || links.find(l => { const r = l.getAttribute("rel"); return !r || r !== "self"; })
    || links[0];
  return pick ? (pick.getAttribute("href") || "") : "";
}
/* First image in a block of HTML. Many feeds carry the photo in the
   article's own description, not in a media tag, so this is the
   fallback that makes card thumbnails actually appear. */
function firstImgSrc(html) {
  const m = (html || "").match(/<img[^>]+src\s*=\s*["']([^"']+)["']/i);
  return m ? m[1] : "";
}
function itemImage(n) {
  const thumb = childEl(n, "thumbnail");
  if (thumb && thumb.getAttribute("url")) return thumb.getAttribute("url");
  const media = childEl(n, "content");
  if (media && media.getAttribute("url") && /^image\//.test(media.getAttribute("type") || "")) return media.getAttribute("url");
  const enc = childEl(n, "enclosure");
  if (enc && enc.getAttribute("url") && /^image\//.test(enc.getAttribute("type") || "")) return enc.getAttribute("url");
  return firstImgSrc(childText(n, "encoded") || childText(n, "content") || childText(n, "description") || childText(n, "summary") || "");
}
function itemEnclosure(n) {
  const enc = childEl(n, "enclosure");
  if (enc && enc.getAttribute("url")) return { url: enc.getAttribute("url"), type: enc.getAttribute("type") || "" };
  const media = childEl(n, "content");
  if (media && media.getAttribute("url") && /^(audio|video)\//.test(media.getAttribute("type") || "")) {
    return { url: media.getAttribute("url"), type: media.getAttribute("type") };
  }
  return null;
}
function itemAuthor(n) {
  const dc = childText(n, "creator");
  if (dc) return dc;
  const a = childEl(n, "author");
  if (a) return childText(a, "name") || (a.textContent || "").trim();
  return "";
}

function parseFeed(text, url) {
  const doc = new DOMParser().parseFromString(text, "text/xml");
  if (doc.querySelector("parsererror")) {
    try {
      const j = JSON.parse(text);
      if (j.items) {
        return {
          title: j.title || host(url), site: j.home_page_url || url,
          items: j.items.map(x => ({
            title: x.title || "(untitled)",
            url: x.url || x.external_url || url,
            guid: x.id || x.url || x.external_url || "",
            summary: x.summary || x.content_text || "",
            content: x.content_html || x.content_text || "",
            author: typeof x.author === "string" ? x.author : (x.author?.name || ""),
            date: x.date_published || x.date_modified || "",
            image: x.image || "", enclosure: null
          }))
        };
      }
    } catch {}
    throw Error("The response is not a supported RSS, Atom, or JSON Feed document.");
  }
  const root = doc.documentElement;
  const atom = root.localName === "feed";
  const channel = atom ? root : (doc.querySelector("channel") || root);
  const nodes = atom
    ? [...root.children].filter(n => n.localName === "entry")
    : [...doc.querySelectorAll("item")];
  const site = atom ? (atomLink(channel) || url) : (childText(channel, "link") || url);
  return {
    title: (atom ? (childText(channel, "title")) : childText(channel, "title")) || host(url),
    site,
    items: nodes.map(n => {
      const link = atom ? atomLink(n) : (childText(n, "link") || "");
      const guid = childText(n, "guid") || "";
      const encodedContent = childEl(n, "encoded");
      const atomContent = atom && childEl(n, "content");
      const content = childText(n, "encoded") || childText(n, "content") || childText(n, "description") || childText(n, "summary");
      const summary = childText(n, "summary") || childText(n, "description") || content;
      return {
        title: childText(n, "title") || "(untitled)",
        url: link || guid || url,
        guid,
        summary, content,
        fullContentIncluded: !!(encodedContent || atomContent),
        author: itemAuthor(n),
        date: childText(n, "pubDate") || childText(n, "published") || childText(n, "updated") || childText(n, "date") || "",
        image: itemImage(n),
        enclosure: itemEnclosure(n)
      };
    })
  };
}

/* WordPress REST API adapter. WordPress sends permissive CORS headers on
   /wp-json/ even when /feed sends none, and its posts carry full content. */
async function loadWordPressFeed(origin, knownTitle) {
  const base = origin.replace(/\/$/, "") + "/wp-json/wp/v2/posts";
  // 30 posts, not 100: with _embed the 100-post payload is ~4.5 MB and
  // Some publisher sites can take longer than the 15 s fetch timeout.
  // on a slow connection and fail the add/refresh entirely.
  const r = await fetchWithTimeout(base + "?per_page=30&_embed&orderby=date&order=desc", {
    headers: { Accept: "application/json" }, cache: "no-store"
  });
  if (!r.ok) throw Error("HTTP " + r.status);
  const posts = await r.json();
  if (!Array.isArray(posts)) throw Error("Unexpected WordPress API response.");
  // The site title comes from the /wp-json/ root, but only on add: on
  // refresh the feed already has its title, and a second fetch per
  // feed per refresh is wasted.
  let siteTitle = knownTitle || host(origin), siteUrl = origin;
  if (!knownTitle) {
    try {
      const ir = await fetchWithTimeout(origin.replace(/\/$/, "") + "/wp-json/", {
        headers: { Accept: "application/json" }, cache: "no-store"
      });
      if (ir.ok) {
        const info = await ir.json();
        siteTitle = info.name || siteTitle;
        siteUrl = info.url || siteUrl;
      }
    } catch {}
  }  return {
    title: siteTitle, site: siteUrl,
    items: posts.map(p => ({
      title: plainText(p.title?.rendered) || "(untitled)",
      url: p.link || origin,
      guid: (typeof p.guid === "string" ? p.guid : p.guid?.rendered) || p.link || "",
      summary: plainText(p.excerpt?.rendered) || "",
      content: p.content?.rendered || "",
      author: p._embedded?.author?.[0]?.name || "",
      date: p.date || p.modified || "",
      image: p._embedded?.["wp:featuredmedia"]?.[0]?.source_url || firstImgSrc(p.content?.rendered || ""),
      enclosure: null
    }))
  };
}

/* Public feed-to-JSON fallback (opt-in). The feed passes through a third
   party, so this runs only when the user enables it in Settings. */
async function loadViaProxy(feedUrl) {
  const r = await fetchWithTimeout(PROXY_API + encodeURIComponent(feedUrl), {
    headers: { Accept: "application/json" }, cache: "no-store"
  });
  if (!r.ok) throw Error("HTTP " + r.status);
  const j = await r.json();
  if (j.status !== "ok" || !Array.isArray(j.items)) throw Error("The proxy could not read this feed.");
  return {
    title: j.feed?.title || host(feedUrl), site: j.feed?.link || feedUrl,
    items: j.items.map(x => ({
      title: x.title || "(untitled)",
      url: x.link || feedUrl,
      guid: x.guid || x.link || "",
      summary: plainText(x.description) || "",
      content: x.content || x.description || "",
      author: x.author || "",
      date: x.pubDate || "",
      image: x.thumbnail || x.enclosure?.link || firstImgSrc(x.content || x.description || ""),
      enclosure: x.enclosure?.link ? { url: x.enclosure.link, type: x.enclosure.type || "" } : null
    }))
  };
}

async function discover(url) {
  const { text, finalUrl } = await fetchText(url);
  if (looksLikeFeed(text)) return { url: finalUrl, text };
  const doc = new DOMParser().parseFromString(text, "text/html");
  const pick = sel => doc.querySelector(sel);
  const l = pick('link[rel="alternate"][type*="rss"]')
    || pick('link[rel="alternate"][type*="atom"]')
    || pick('link[rel="alternate"][type*="json"]');
  if (!l) throw Error("No feed link found on that page. Try the direct feed URL.");
  const feedUrl = new URL(l.getAttribute("href"), url).href;
  const found = await fetchText(feedUrl);
  return { url: found.finalUrl, text: found.text };
}
/* Try every in-page source for a feed URL, in order. Returns
   { parsed, via, url, wpRoot }. Throws the direct-fetch error when all fail. */
/* Conventional feed locations, tried in order when only a bare website
   address is given, or when the page advertises no feed link. */
const FEED_PATHS = ["/feed", "/rss", "/feed.xml", "/rss.xml", "/atom.xml", "/index.xml"];
async function loadFeedFromUrl(rawUrl) {
  const url = normalizeFeedUrl(rawUrl);
  let directError = null;
  try {
    const found = await discover(url);
    return { parsed: parseFeed(found.text, found.url), via: "feed", url: found.url, wpRoot: "" };
  } catch (e) { directError = e; }
  const origin = new URL(url).origin;
  // A bare site address, or a page that advertises no feed: probe the
  // conventional locations before falling back to the WordPress API.
  // A specific feed URL that failed (404, bad XML) is not probed — the
  // user asked for that address, so its error is the answer.
  const bare = new URL(url).pathname.replace(/\/$/, "") === "";
  const noLink = /No feed link found/.test(directError?.message || "");
  if (bare || noLink) {
    // Probe the conventional locations in parallel: the first one in
    // list order that returns a feed wins, so a slow 404 on /feed does
    // not hold up the rest.
    const attempts = await Promise.allSettled(FEED_PATHS.map(async p => {
      const found = await discover(origin + p);
      return { parsed: parseFeed(found.text, found.url), via: "feed", url: found.url, wpRoot: "" };
    }));
    for (const a of attempts) {
      if (a.status === "fulfilled") return a.value;
    }
  }
  try {
    const parsed = await loadWordPressFeed(origin);
    if (parsed.items.length) return { parsed, via: "wp", url, wpRoot: origin };
  } catch {}
  if (state.settings.proxyFallback) {
    try {
      const parsed = await loadViaProxy(url);
      return { parsed, via: "proxy", url, wpRoot: "" };
    } catch {}
  }
  throw directError || Error("Could not load this feed.");
}


/* ---------- unified feed discovery ---------- */
const DISCOVERY_PROVIDERS = [
  {
    name: "Apple Podcasts",
    search: async (q, signal) => {
      const params = new URLSearchParams({
        term: q, media: "podcast", entity: "podcast", country: "us", limit: "50"
      });
      const data = await discoveryJSON("https://itunes.apple.com/search?" + params, signal);
      return (Array.isArray(data.results) ? data.results : [])
        .map(x => discoveryNormalize(x, "Apple Podcasts"))
        .filter(Boolean);
    }
  },
  {
    name: "RSS.mobi",
    search: async (q, signal) => {
      const params = new URLSearchParams({ q, limit: "100" });
      const data = await discoveryJSON("https://rss.mobi/api/v1/feeds?" + params, signal);
      return discoveryRecords(data).map(x => discoveryNormalize(x, "RSS.mobi")).filter(Boolean);
    }
  },
  {
    name: "RSSAmp",
    search: async (q, signal) => {
      const data = await discoveryJSON("https://rssamp.com/api/search?q=" + encodeURIComponent(q), signal);
      return discoveryRecords(data).map(x => discoveryNormalize(x, "RSSAmp")).filter(Boolean);
    }
  },
  {
    name: "Feedsearch",
    search: async (q, signal) => {
      if (!/^(https?:\/\/)?(?:[a-z0-9-]+\.)+[a-z]{2,}(?:\/\S*)?$/i.test(q.trim())) return [];
      const data = await discoveryJSON("https://origin.feedsearch.dev/api/v1/search?url=" + encodeURIComponent(q.trim()), signal);
      return discoveryRecords(data).map(x => discoveryNormalize(x, "Feedsearch")).filter(Boolean);
    }
  }
];
let discoveryTimer = null, discoveryController = null, discoveryRun = 0;
function discoveryText(x) { return String(x ?? "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim(); }
async function discoveryJSON(url, signal) {
  const r = await fetch(url, { signal, headers: { Accept: "application/json" }, cache: "no-store" });
  if (!r.ok) throw Error("HTTP " + r.status);
  return r.json();
}
function discoveryRecords(d) {
  if (Array.isArray(d)) return d;
  if (!d || typeof d !== "object") return [];
  for (const k of ["feeds", "results", "blogs", "items", "data"]) if (Array.isArray(d[k])) return d[k];
  const out = [];
  for (const k of ["feed", "blog", "result"]) if (d[k] && typeof d[k] === "object" && !Array.isArray(d[k])) out.push(d[k]);
  return out;
}
function discoveryNormalize(record, source) {
  if (!record || typeof record !== "object") return null;
  const x = Object.assign({}, record, record.feed && typeof record.feed === "object" ? record.feed : {});
  const raw = x.feedUrl || x.feed_url || x.feedURL || x.xmlUrl || x.xml_url || x.rssUrl || x.rss_url || x.feed || x.url;
  if (typeof raw !== "string" || !/^https?:\/\//i.test(raw)) return null;
  let url;
  try {
    const u = new URL(raw);
    if (!["http:", "https:"].includes(u.protocol)) return null;
    u.hash = "";
    u.searchParams.sort();
    [...u.searchParams.keys()].forEach(k => { if (/^(utm_|fbclid|gclid)/i.test(k)) u.searchParams.delete(k); });
    url = u.href;
  } catch { return null; }
  const siteRaw = x.site || x.siteUrl || x.site_url || x.homepage || x.website || x.link || x.collectionViewUrl || "";
  let site = "";
  try { if (typeof siteRaw === "string" && /^https?:\/\//i.test(siteRaw)) site = new URL(siteRaw).href; } catch {}
  return {
    url, site: site || url,
    title: discoveryText(x.title || x.name || x.collectionName || x.collectionCensoredName || x.feedTitle || x.feed_title || x.blogTitle || x.blog_title || x.label) || host(site || url),
    description: discoveryText(x.description || x.summary || x.subtitle || x.about || ""),
    source
  };
}
function discoveryKey(url) {
  try {
    const u = new URL(url);
    return (u.hostname.replace(/^www\./, "").toLowerCase() + (u.pathname.replace(/\/+$/, "") || "/") + u.search).replace(/:443(?=\/|$)/, "");
  } catch { return String(url).toLowerCase(); }
}
function mergeDiscoveryResults(groups) {
  const map = new Map();
  groups.flat().forEach(x => {
    const key = discoveryKey(x.url), old = map.get(key);
    if (!old) map.set(key, Object.assign({}, x, { sources: [x.source] }));
    else {
      if (!old.description && x.description) old.description = x.description;
      if (old.title === host(old.site || old.url) && x.title.length > old.title.length) old.title = x.title;
      if (!old.sources.includes(x.source)) old.sources.push(x.source);
    }
  });
  return [...map.values()].sort((a, b) => a.title.localeCompare(b.title));
}
/* Podcast hosts, used to tell a podcast result from an article result
   when the result came from a general RSS catalog rather than the
   Apple Podcasts directory. */
const PODCAST_HOSTS = ["libsyn.com", "blubrry.com", "podbean.com", "anchor.fm", "spreaker.com", "transistor.fm", "buzzsprout.com", "simplecast.com", "megaphone.fm", "rss.com", "podomatic.com", "audioboom.com"];
function isPodcastResult(x) {
  if ((x.sources || []).includes("Apple Podcasts")) return true;
  const h = host(x.url);
  return PODCAST_HOSTS.some(p => h === p || h.endsWith("." + p));
}
/* Which kind of search result to show: "all", "podcasts", or "articles".
   Reset to "all" on each new search. */
let discoveryFilter = "all";
function renderDiscoveryResults(items) {
  const root = $("#feedSearchResults");
  if (!items.length) {
    root.innerHTML = '<p class="muted discovery-empty">No matching feeds found. Try a different name, topic, or website address.</p>';
    return;
  }
  const row = (x, i) => {
    const added = state.feeds.some(f => sameFeedUrl(f.url, x.url));
    return '<article class="discovery-result"><div class="discovery-result-main"><strong>' + esc(x.title) +
      '</strong><span>' + esc(host(x.site || x.url)) + '</span>' +
      (x.description ? '<p>' + esc(x.description) + '</p>' : '') +
      '<small>' + esc(x.sources.join(" · ")) + '</small></div>' +
      '<button type="button" class="primary discovery-add" data-discovery-add="' + i + '"' +
      (added ? ' disabled' : '') + '>' + (added ? 'Added' : 'Add') + '</button></article>';
  };
  // Split the results into Podcasts and Articles so the user can pick
  // one or both. The original index is kept, because the Add button
  // looks the result up by its place in feedDiscoveryResults.
  const podcasts = [], articles = [];
  items.forEach((x, i) => (isPodcastResult(x) ? podcasts : articles).push([x, i]));
  const btn = (key, label, n) => '<button type="button" class="discovery-filter-btn' + (discoveryFilter === key ? ' active' : '') + '" data-discovery-filter="' + key + '"' + (n ? '' : ' disabled') + '>' + label + ' (' + n + ')</button>';
  const bar = '<div class="discovery-filter" role="group" aria-label="Show podcasts, articles, or both">' + btn("all", "All", items.length) + btn("podcasts", "Podcasts", podcasts.length) + btn("articles", "Articles", articles.length) + '</div>';
  const sec = (label, list) => list.length ? '<h3 class="discovery-section">' + label + '</h3>' + list.map(([x, i]) => row(x, i)).join("") : "";
  root.innerHTML = bar +
    (discoveryFilter === "articles" ? sec("Articles", articles) :
     discoveryFilter === "podcasts" ? sec("Podcasts", podcasts) :
     sec("Podcasts", podcasts) + sec("Articles", articles));
}
async function runDiscoveryProvider(provider, query, parentSignal) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (parentSignal.aborted) controller.abort();
  else parentSignal.addEventListener("abort", abort, { once: true });
  const timeout = setTimeout(() => controller.abort(), 7000);
  try {
    return await provider.search(query, controller.signal);
  } finally {
    clearTimeout(timeout);
    parentSignal.removeEventListener("abort", abort);
  }
}
async function searchFeeds(raw) {
  const q = String(raw || "").trim(), status = $("#feedSearchStatus"), root = $("#feedSearchResults");
  if (q.length < 2) { status.textContent = "Enter at least two characters."; root.innerHTML = ""; return; }
  if (discoveryController) discoveryController.abort();
  const controller = new AbortController();
  discoveryController = controller;
  const run = ++discoveryRun;
  const timeout = setTimeout(() => controller.abort(), 10000);
  status.textContent = "Searching feed directories…";
  root.innerHTML = "";
  try {
    const settled = await Promise.allSettled(DISCOVERY_PROVIDERS.map(p => runDiscoveryProvider(p, q, controller.signal)));
    if (run !== discoveryRun) return;
    const groups = settled.map(r => r.status === "fulfilled" ? r.value : []);
    const items = mergeDiscoveryResults(groups);
    window.feedDiscoveryResults = items;
    discoveryFilter = "all";
    const failed = settled.filter(r => r.status === "rejected").length;
    const podCount = items.filter(isPodcastResult).length;
    const artCount = items.length - podCount;
    status.textContent = items.length + " unique feed" + (items.length === 1 ? "" : "s") + " found" +
      (items.length ? " (" + podCount + " podcast" + (podCount === 1 ? "" : "s") + ", " + artCount + " article" + (artCount === 1 ? "" : "s") + ")" : "") +
      " across " + (settled.length - failed) + " source" + (settled.length - failed === 1 ? "" : "s") +
      (failed ? " · " + failed + " source" + (failed === 1 ? "" : "s") + " unavailable" : "");
    renderDiscoveryResults(items);
  } finally { clearTimeout(timeout); }
}
/* One box for adding a feed (#157): an address (feed URL or bare
   website) goes the direct-add path; anything else is a directory
   search. Same address test Feedsearch uses for URL queries. */
function looksLikeAddress(q) {
  return /^(https?:\/\/)?(?:[a-z0-9-]+\.)+[a-z]{2,}(?:\/\S*)?$/i.test(q.trim());
}
function scheduleFeedSearch() {
  discoveryRun++;
  clearTimeout(discoveryTimer);
  const q = $("#feedSearchInput").value;
  $("#feedError").textContent = "";
  if (q.trim().length < 2) {
    if (discoveryController) discoveryController.abort();
    $("#feedSearchStatus").textContent = "Type an address to add it, or a name or topic to search.";
    $("#feedSearchResults").innerHTML = "";
    return;
  }
  if (looksLikeAddress(q)) {
    if (discoveryController) discoveryController.abort();
    $("#feedSearchStatus").textContent = "Press Enter or Add feed to add this address.";
    $("#feedSearchResults").innerHTML = "";
    return;
  }
  $("#feedSearchStatus").textContent = "Searching feed directories…";
  $("#feedSearchResults").innerHTML = "";
  discoveryTimer = setTimeout(() => searchFeeds(q), 700);
}
async function addDiscoveredFeed(index) {
  const x = window.feedDiscoveryResults && window.feedDiscoveryResults[index];
  if (!x) return;
  const b = $('[data-discovery-add="' + index + '"]');
  if (b) { b.disabled = true; b.textContent = "Adding…"; }
  try {
    await addFeed(x.url);
    if (b) b.textContent = "Added";
    $("#feedSearchStatus").textContent = "Added " + x.title + ".";
  } catch (e) {
    if (b) { b.disabled = false; b.textContent = "Add"; }
    $("#feedError").textContent = classifyError(e);
  }
}

async function addFeed(raw) {
  const url = normalizeFeedUrl(raw);
  if (state.feeds.some(f => sameFeedUrl(f.url, url))) throw Error("You already subscribe to this feed.");
  const loaded = await loadFeedFromUrl(url);
  // The check above only sees the address typed in. The same feed can
  // be reached another way (the bare site vs its /feed, or a probed
  // /rss), so check the resolved feed too: same feed URL, or the same
  // site under the same title.
  const originOf = s => { try { return new URL(s).origin; } catch { return ""; } };
  const dup = state.feeds.find(f =>
    sameFeedUrl(f.url, loaded.url) ||
    (f.site && loaded.parsed.site && originOf(f.site) && originOf(f.site) === originOf(loaded.parsed.site) &&
      (f.title || "").trim().toLowerCase() === (loaded.parsed.title || "").trim().toLowerCase()));
  if (dup) throw Error(`You already subscribe to this feed (“${dup.title}”).`);
  const feed = {
    id: id(), url: loaded.url, title: loaded.parsed.title, site: loaded.parsed.site,
    added: new Date().toISOString(), error: "", via: loaded.via, wpRoot: loaded.wpRoot || "", group: ""
  };
  state.feeds.push(feed);
  saveFeeds();
  try {
    await saveItems(feed, loaded.parsed.items);
  } catch (e) {
    // The subscription itself is saved; a storage failure must not leave
    // an invisible feed that blocks re-adding. Show it with its error.
    feed.error = classifyError(e);
    saveFeeds();
    render();
    toast("Feed added, but its articles failed to save. Refresh to retry.");
    return;
  }
  // Rules can tag a newly added feed's articles; sync the tag list so
  // those tags appear in the sidebar immediately, not at the next refresh.
  syncTags(); saveTags();
  // Make the add unmissable (#137): open the new feed's view, flash
  // its row in the sidebar, and name it in the confirmation.
  state.view = "feed"; state.feed = feed.id; state.folder = null; state.tag = null; state.savedSearch = null; state.selected = null;
  render();
  const row = document.querySelector(`[data-feed="${CSS.escape(feed.id)}"]`);
  if (row) {
    row.scrollIntoView({ block: "nearest" });
    row.classList.add("just-added");
    setTimeout(() => row.classList.remove("just-added"), 2300);
  }
  const n = loaded.parsed.items.length;
  toast(`“${feed.title}” added — ${n} article${n === 1 ? "" : "s"}.`);
}

/* Rules (#109): run on newly fetched articles at refresh time. A rule
   matches when its scope (all feeds, one folder, or one feed) matches
   and every condition it sets (title keyword, author) matches. The
   actions add a tag, save the article, or mark it read. Rules never
   delete anything, and they only run on new arrivals, never on articles
   the user already has (so a rule cannot re-tag something the user
   untagged, and a rule that marks read cannot hide an article the user
   already read and then unread). */
function applyRules(feed, item) {
  for (const rule of state.rules) {
    if (!ruleMatches(rule, feed, item)) continue;
    if (rule.tag) {
      const t = rule.tag.trim();
      if (t && !(item.tags || []).includes(t)) (item.tags ||= []).push(t);
    }
    if (rule.save) item.saved = true;
    if (rule.markRead) item.read = true;
  }
}
async function saveItems(feed, items) {
  const seen = new Set();
  // Map lookups instead of a linear scan per item, and one batched
  // write instead of a transaction per item. The maps are scoped to
  // this feed's items: the key carries the feed id, so no other feed's
  // items can match.
  const mine = state.items.filter(i => i.feedId === feed.id);
  const byId = new Map(mine.map(i => [i.id, i]));
  const byUrl = new Map();
  for (const i of mine) if (!byUrl.has(i.feedId + "|" + i.url)) byUrl.set(i.feedId + "|" + i.url, i);
  const fresh = [];
  for (const x of items) {
    const link = x.url || feed.url;
    const key = feed.id + "|" + (x.guid || link);
    seen.add(key);
    const old = byId.get(key) || byUrl.get(feed.id + "|" + link);
    const d = date(x.date);
    const content = x.content || "";
    let summary = cleanSummary(x.summary || "");
    // When the feed carries no separate description, the summary IS
    // the full content; storing both duplicates the whole article in
    // IndexedDB. Keep a short plaintext snippet for the card preview
    // instead.
    if (summary && summary === cleanSummary(content)) summary = snippet(plainText(summary), 210);
    const freshItem = {
      id: key, feedId: feed.id, feedTitle: feed.title,
      title: x.title, url: link, guid: x.guid || "",
      // The canonical URL is computed once here, at save time, so the
      // duplicate check on every render does not re-parse every URL.
      canonical: old?.canonical || canonicalUrl(link),
      summary, content,
      fullContent: old?.fullContent || "",
      fullContentIncluded: !!x.fullContentIncluded,
      author: x.author || "",
      published: d ? d.toISOString() : null,
      image: x.image || old?.image || "",
      enclosure: x.enclosure || old?.enclosure || null,
      read: old?.read || false, saved: old?.saved || false,
      snoozedUntil: old?.snoozedUntil || null,
      tags: old?.tags || []
    };
    // Rules (#109) run on new arrivals only.
    if (!old) applyRules(feed, freshItem);
    fresh.push(freshItem);
  }
  await putMany(fresh);
  // Mirror the writes in memory instead of re-reading the whole table
  // from IndexedDB (the old code did two full getAlls per feed), and
  // drop the cached search text: the articles' bodies may have changed.
  const byIdAll = new Map(state.items.map(i => [i.id, i]));
  for (const x of fresh) byIdAll.set(x.id, x);
  state.items = [...byIdAll.values()];
  searchTextCache.clear();
  // Prune items no longer in the feed, unless the user saved them, read them,
  // or snoozed them (a snoozed article must survive until it comes back).
  // Cap each feed at MAX_ITEMS_PER_FEED newest items.
  const mineNow = state.items.filter(i => i.feedId === feed.id);
  const pruneIds = mineNow.filter(old => !seen.has(old.id) && !old.saved && !old.read && !(old.snoozedUntil && old.snoozedUntil > Date.now())).map(o => o.id);
  if (pruneIds.length) {
    await deleteMany(pruneIds);
    const ps = new Set(pruneIds);
    state.items = state.items.filter(i => !ps.has(i.id));
  }
  const freshMine = state.items.filter(i => i.feedId === feed.id)
    .sort((a, b) => (dateSortKey(b) ?? -1) - (dateSortKey(a) ?? -1));
  const extraIds = freshMine.slice(MAX_ITEMS_PER_FEED).filter(x => !x.saved).map(x => x.id);
  if (extraIds.length) {
    await deleteMany(extraIds);
    const es = new Set(extraIds);
    state.items = state.items.filter(i => !es.has(i.id));
  }
}

async function refreshFeed(f) {
  try {
    let loaded;
    if (f.via === "wp" && f.wpRoot) {
      loaded = { parsed: await loadWordPressFeed(f.wpRoot, f.title), via: "wp", url: f.url, wpRoot: f.wpRoot };
    } else if (f.via === "proxy") {
      loaded = { parsed: await loadViaProxy(f.url), via: "proxy", url: f.url, wpRoot: "" };
    } else {
      loaded = await loadFeedFromUrl(f.url);
    }
    f.title = loaded.parsed.title || f.title;
    f.error = "";
    f.via = loaded.via;
    f.wpRoot = loaded.wpRoot || f.wpRoot || "";
    if (loaded.url) f.url = loaded.url;
    await saveItems(f, loaded.parsed.items);
    return true;
  } catch (e) {
    f.error = classifyError(e);
    return false;
  }
}
async function refresh() {
  if (!state.feeds.length) { toast("Add a feed first."); return; }
  const now = Date.now();
  if (now - refreshAt < 2000) return; // debounce repeated refreshes (incl. holding "r")
  refreshAt = now;
  const btn = $("#refresh");
  btn.disabled = true;
  btn.setAttribute("aria-busy", "true");
  try {
    const results = await Promise.all(state.feeds.map(f => refreshFeed(f)));
    const ok = results.filter(Boolean).length;
    const failed = state.feeds.filter((f, i) => !results[i]).map(f => f.title);
    saveFeeds();
    // Rules (#109) can add tags to new articles; keep the tag list
    // current after a refresh.
    syncTags();
    saveTags();
    state.lastRefresh = Date.now();
    try { localStorage.setItem(LR, String(state.lastRefresh)); } catch {}
    render();
    toast(ok === state.feeds.length
      ? `Refreshed ${ok} of ${state.feeds.length} feeds.`
      : `Refreshed ${ok} of ${state.feeds.length} feeds. Failed: ${failed.join(", ")}.`);
  } finally {
    btn.disabled = false;
    btn.removeAttribute("aria-busy");
  }
}

/* ---------- list / render ---------- */
/* A snoozed article is hidden from every list until its time comes, and
   only the Snoozed view shows it. Expired snoozes reappear on their own,
   because this is a time comparison, not a flag that needs clearing. */
const isSnoozed = x => x.snoozedUntil && x.snoozedUntil > Date.now();
/* A muted feed (#117) still exists in the sidebar, but its articles
   stay out of the cross-feed lists until it is unmuted. */
const isMutedFeed = feedId => state.feeds.find(f => f.id === feedId)?.muted;
/* Full-text article match (#107, reused by saved searches #108): the
   short fields first, then the body the reader would show (loaded
   full text, then the feed content), stripped of markup. The combined
   lowercase text is cached per item and reused across keystrokes,
   instead of re-stripping and re-lowercasing the whole body per item
   per keystroke. Cleared when the library is reloaded. */
const searchTextCache = new Map();
function searchText(x) {
  let t = searchTextCache.get(x.id);
  if (t === undefined) {
    t = [x.title, x.summary, x.author, x.feedTitle, (x.tags || []).join(" ")].join(" ").toLowerCase()
      + "\n" + plainText(x.fullContent || x.content || "").toLowerCase();
    searchTextCache.set(x.id, t);
  }
  return t;
}
function matchesQuery(x, q) {
  q = String(q || "").toLowerCase();
  if (!q) return true;
  return searchText(x).includes(q);
}
/* Does an article match a saved search (#108)? The feed group comes
   from a lookup map when the caller has one (visible builds it once),
   otherwise from the feed list. */
function savedSearchMatches(s, x, feedById) {
  if (!s) return false;
  if (s.scope?.startsWith("feed:")) { if (x.feedId !== s.scope.slice(5)) return false; }
  else if (s.scope?.startsWith("folder:")) {
    const g = feedById ? (feedById.get(x.feedId)?.group || "") : (state.feeds.find(f => f.id === x.feedId)?.group || "");
    if (g !== s.scope.slice(7)) return false;
  }
  if (s.tag && !(x.tags || []).includes(s.tag)) return false;
  if (s.unreadOnly && x.read) return false;
  return matchesQuery(x, s.query);
}
function visible() {
  // A folder view (#118) and a saved search (#108) need each article's
  // feed group; build the lookup once instead of scanning per article.
  const feedById = (state.view === "folder" || state.view === "savedSearch") ? new Map(state.feeds.map(f => [f.id, f])) : null;
  // The muted feeds, as a set: checking each article against it is
  // O(1), where the old per-item feed lookup was O(feeds). The saved
  // search is looked up once, not once per article.
  const mutedIds = new Set(state.feeds.filter(f => f.muted).map(f => f.id));
  const savedSearch = state.view === "savedSearch" ? state.savedSearches.find(v => v.id === state.savedSearch) : null;
  let a = state.items.filter(x => {
    if (state.view === "snoozed") return isSnoozed(x);
    if (isSnoozed(x)) return false;
    if (state.view === "unread") return !x.read;
    if (state.view === "saved") return x.saved;
    // The Highlights view (#116) lists the highlights themselves, not
    // articles, so renderList renders it separately; visible returns
    // the highlighted articles for the counts and keyboard navigation.
    if (state.view === "highlights") return state.highlights.some(h => h.itemId === x.id);
    if (state.view === "feed") return x.feedId === state.feed;
    if (mutedIds.has(x.feedId)) return false;
    // A folder view (#118) is a cross-feed list, like All and Unread:
    // muted feeds and snoozed articles stay out, duplicates collapse.
    if (state.view === "folder") return (feedById.get(x.feedId)?.group || "") === state.folder;
    if (state.view === "tag") return (x.tags || []).includes(state.tag);
    // A saved search (#108) is a stored filter: keywords, a feed or
    // folder scope, a tag, and unread-only, run over the library.
    if (state.view === "savedSearch") {
      return savedSearchMatches(savedSearch, x, feedById);
    }
    return true;
  });
  if (state.filter === "today") {
    const today = new Date().toDateString();
    a = a.filter(x => { const d = date(x.published); return d && d.toDateString() === today; });
  }
  if (state.filter === "week") {
    a = a.filter(x => { const d = date(x.published); return d && (Date.now() - d.getTime() < 7 * 864e5); });
  }
  if (state.query) {
    a = a.filter(x => matchesQuery(x, state.query));
  }
  const newest = state.sort === "newest";
  // Precompute the date keys once: the old comparator re-parsed each
  // article's date O(log N) times during the sort.
  const keyed = a.map(x => [dateSortKey(x), x]);
  keyed.sort((p, q) => {
    const dx = p[0], dy = q[0];
    if (dx === null && dy === null) return 0;
    if (dx === null) return 1; // dateless items always last
    if (dy === null) return -1;
    return (dy - dx) * (newest ? 1 : -1);
  });
  a = keyed.map(p => p[1]);
  // Duplicates are collapsed in the cross-feed lists only (#115): a
  // feed's own view shows its articles as they are, saved articles
  // are keepers, and snoozed articles are already one-per-time.
  if (state.settings.hideDuplicates !== false && !["feed", "saved", "snoozed"].includes(state.view)) a = dedupeItems(a);
  return a;
}
/* What the All/Unread lists actually show, for the sidebar counts:
   no muted feeds, no snoozed articles, duplicates collapsed. */
function countableItems() {
  const mutedIds = new Set(state.feeds.filter(f => f.muted).map(f => f.id));
  let a = state.items.filter(x => !isSnoozed(x) && !mutedIds.has(x.feedId));
  if (state.settings.hideDuplicates !== false) a = dedupeItems(a);
  return a;
}
function renderNav() {
  const shown = countableItems();
  $("#allCount").textContent = shown.length;
  $("#unreadCount").textContent = shown.filter(x => !x.read).length;
  $("#savedCount").textContent = state.items.filter(x => x.saved && !isSnoozed(x)).length;
  $("#snoozedCount").textContent = state.items.filter(isSnoozed).length;
  $("#highlightsCount").textContent = state.highlights.length;
  $$(".nav").forEach(b => {
    b.classList.toggle("active", b.dataset.view === state.view && state.view !== "feed");
    if (b.dataset.view === state.view && state.view !== "feed") b.setAttribute("aria-current", "true");
    else b.removeAttribute("aria-current");
  });
  const groups = {};
  for (const f of state.feeds) (groups[f.group || ""] ||= []).push(f);
  const groupNames = Object.keys(groups).sort((a, b) => (a === "" ? 1 : b === "" ? -1 : a.localeCompare(b)));
  // Unread counts, aggregated in one pass over the articles instead of
  // a full scan per feed (and per folder) on every render.
  const unreadByFeed = new Map();
  for (const x of state.items) {
    if (!x.read && !isSnoozed(x)) unreadByFeed.set(x.feedId, (unreadByFeed.get(x.feedId) || 0) + 1);
  }
  $("#feeds").innerHTML = state.feeds.length ? groupNames.map(g => {
    // Ungrouped feeds render last, after the folders; label them so they
    // are not misread as belonging to the folder above them.
    // A folder name is a button (#118): it opens the folder's feeds as
    // one merged list, with its unread count beside it.
    const folderUnread = g ? groups[g].reduce((n, f) => n + (unreadByFeed.get(f.id) || 0), 0) : 0;
    const label = g ? `<div class="folder-head"><button type="button" class="feed-group folder-open${state.view === "folder" && state.folder === g ? " active" : ""}" data-folder="${esc(g)}" ${state.view === "folder" && state.folder === g ? 'aria-current="true"' : ""}>${esc(g)}${folderUnread ? `<span>${folderUnread}</span>` : ""}</button><span class="folder-actions"><button type="button" data-folder-rename="${esc(g)}" title="Rename folder" aria-label="Rename folder ${esc(g)}">✎</button><button type="button" data-folder-delete="${esc(g)}" title="Delete folder" aria-label="Delete folder ${esc(g)}">×</button></span></div>` : (groupNames.length > 1 ? `<div class="feed-group">Ungrouped</div>` : "");
    return label + groups[g].map(f => {
      const unreadCount = unreadByFeed.get(f.id) || 0;
      const err = f.error ? ` feed-error" title="${esc(f.error)}` : "";
      const armed = pendingDelete?.kind === "feed" && pendingDelete.id === f.id;
      // The site's own favicon marks the row; if it fails to load the
      // dot comes back (the img hides itself and unhides the dot).
      let fav = "";
      try { fav = new URL(f.site || f.url).origin + "/favicon.ico"; } catch {}
      const mark = fav
        ? `<img class="feed-favicon" src="${esc(fav)}" alt="" loading="lazy" onerror="this.style.display='none';this.nextElementSibling.style.display=''"><span class="feed-dot" style="display:none"></span>`
        : `<span class="feed-dot"></span>`;
      const countBtn = unreadCount ? `<button type="button" class="feed-count" data-mark-read="${esc(f.id)}" title="Mark ${esc(f.title)} read" aria-label="Mark ${esc(f.title)} read">${unreadCount}</button>` : "";
      const muteBtn = `<button type="button" class="feed-mute${f.muted ? " on" : ""}" data-mute="${esc(f.id)}" title="${f.muted ? "Unmute" : "Mute"} ${esc(f.title)}" aria-label="${f.muted ? "Unmute" : "Mute"} ${esc(f.title)}" aria-pressed="${!!f.muted}">${f.muted ? "Muted" : "Mute"}</button>`;
      return `<div class="feed-row-wrap"><button class="feed-row${state.feed === f.id ? " active" : ""}${f.muted ? " muted" : ""}${err}" data-feed="${esc(f.id)}" ${state.feed === f.id ? 'aria-current="true"' : ""}>${mark}<span class="feed-name">${esc(f.title)}</span>${f.error ? '<span class="feed-err" aria-hidden="true">!</span>' : ""}</button>${countBtn}${muteBtn}<button type="button" class="feed-unsub${armed ? " armed" : ""}" data-unsub="${esc(f.id)}" title="${armed ? "Click again to unsubscribe" : `Unsubscribe from ${esc(f.title)}`}" aria-label="${armed ? `Click again to unsubscribe from ${esc(f.title)}` : `Unsubscribe from ${esc(f.title)}`}">×</button></div>`;
    }).join("");
  }).join("") : '<p class="muted">Your feeds will appear here.</p>';
  const tagCounts = {};
  for (const x of state.items) for (const t of x.tags || []) tagCounts[t] = (tagCounts[t] || 0) + 1;
  $("#tags").innerHTML = state.tags.length ? state.tags.map(t =>
    `<button class="nav tag-row${state.view === "tag" && state.tag === t ? " active" : ""}" data-tag="${esc(t)}" ${state.view === "tag" && state.tag === t ? 'aria-current="true"' : ""}>${icon("tag")} ${esc(t)}<span>${tagCounts[t] || 0}</span></button>`
  ).join("") : '<p class="muted">Tag articles from the reader to find them here.</p>';
  // Saved searches (#108): a stored filter as a sidebar view, with its
  // matching count. The feed map is built once for all searches.
  const ssFeedById = new Map(state.feeds.map(f => [f.id, f]));
  const ssMuted = new Set(state.feeds.filter(f => f.muted).map(f => f.id));
  $("#savedSearches").innerHTML = state.savedSearches.length ? state.savedSearches.map(s => {
    const n = state.items.filter(x => !isSnoozed(x) && !ssMuted.has(x.feedId) && savedSearchMatches(s, x, ssFeedById)).length;
    const active = state.view === "savedSearch" && state.savedSearch === s.id;
    return `<button class="nav tag-row${active ? " active" : ""}" data-saved-search="${esc(s.id)}" ${active ? 'aria-current="true"' : ""}>${icon("search")} ${esc(s.name)}<span>${n}</span></button>`;
  }).join("") : '<p class="muted">Save a search to keep it here.</p>';
}
/* The Highlights view (#116): every highlight, newest first, with the
   article it came from. Clicking one opens the article at the passage. */
function renderHighlightsList() {
  const list = [...state.highlights].sort((a, b) => (b.created || 0) - (a.created || 0));
  $("#sort").textContent = state.sort === "newest" ? "Newest first ↓" : "Oldest first ↑";
  $$(".filter").forEach(x => x.classList.toggle("active", x.dataset.filter === state.filter));
  const upd = state.lastRefresh ? " · Updated " + new Date(state.lastRefresh).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : "";
  $("#subtitle").textContent = "Passages you highlighted, with your notes." + upd;
  $("#articleList").innerHTML = list.length ? list.map(h => {
    const x = state.items.find(i => i.id === h.itemId);
    const d = x ? date(x.published) : null;
    return `<article class="article hl-row" data-hl-open="${esc(h.id)}" tabindex="0"><div class="article-main"><div class="article-meta"><span>${esc(x ? feedTitleFor(x) : "Article")}</span><span>·</span><time>${esc(h.created ? relDate(new Date(h.created)) : "")}</time></div><blockquote class="hl-quote">${esc(h.text)}</blockquote>${h.note ? `<p class="hl-note">${esc(h.note)}</p>` : ""}<div class="article-bottom"><span>${esc(x ? x.title : "Article no longer in the library")}</span><span class="article-actions"><button data-action="hl-delete" data-id="${esc(h.id)}" title="Delete highlight" aria-label="Delete highlight">×</button></span></div></div></article>`;
  }).join("") : '<div class="empty"><div class="empty-mark">R</div><h2>No highlights yet.</h2><p>Select text in an article to highlight it, with an optional note.</p></div>';
  const ma = $("#markAbove"), mb = $("#markBelow");
  if (ma) ma.disabled = true;
  if (mb) mb.disabled = true;
}
function renderList() {
  const a = visible();
  const titles = { all: "All articles", unread: "Unread", saved: "Saved", snoozed: "Snoozed", highlights: "Highlights", feed: state.feeds.find(f => f.id === state.feed)?.title || "Feed", folder: state.folder || "Folder", savedSearch: state.savedSearches.find(s => s.id === state.savedSearch)?.name || "Saved search", tag: state.tag ? "Tag: " + state.tag : "Tag" };
  $("#heading").textContent = titles[state.view];
  $("#mobileTitle").textContent = titles[state.view];
  // The Highlights view (#116) lists the highlights themselves, newest
  // first, with the article each came from; clicking one opens it.
  if (state.view === "highlights") { renderHighlightsList(); return; }
  $("#mobileTitle").textContent = titles[state.view];
  // Keep the sort button and the filter pills in step with the
  // persisted sort/filter, so a reload restores them.
  $("#sort").textContent = state.sort === "newest" ? "Newest first ↓" : "Oldest first ↑";
  $$(".filter").forEach(x => x.classList.toggle("active", x.dataset.filter === state.filter));
  const base = state.view === "saved" ? "Articles you have kept for later."
    : state.view === "snoozed" ? "Articles waiting to come back."
    : state.view === "unread" ? "Stories you have not read yet."
    : state.view === "highlights" ? "Passages you highlighted, with your notes."
    : state.view === "folder" ? `Every feed in “${state.folder}”, newest first.`
    : state.view === "savedSearch" ? "A saved filter, run over your library."
    : state.view === "tag" ? `Articles tagged “${state.tag}”.`
    : "";
  const upd = state.lastRefresh ? "Updated " + new Date(state.lastRefresh).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : "";
  // The All view has no description to show — the subtitle is just the
  // last refresh time (#146), not filler.
  $("#subtitle").textContent = [base, upd].filter(Boolean).join(" · ");
  $("#articleList").innerHTML = a.length ? a.map(x => {
    const d = date(x.published);
    // Card options: how much preview text, and whether to show the thumbnail.
    const exc = state.settings.cardExcerpt || "full";
    const excerpt = exc === "none" ? "" : `<p>${esc(snippet(cleanSummary(x.summary), exc === "short" ? 100 : 210))}</p>`;
    const thumb = state.settings.cardImage !== false && x.image ? `<img class="article-thumb" src="${esc(x.image)}" alt="" loading="lazy" onerror="this.remove()">` : "";
    const rt = readingTimeText(x);
    const snoozeNote = state.view === "snoozed" && x.snoozedUntil ? `<span>·</span><span>Snoozed until ${esc(fmtDateTime(new Date(x.snoozedUntil)))}</span>` : "";
    return `<article class="article ${x.read ? "" : "unread"} ${x.id === state.selected ? "selected" : ""}" data-item="${esc(x.id)}" tabindex="0" role="button" aria-label="Open: ${esc(x.title)}"><div class="article-main"><div class="article-meta"><span>${esc(feedTitleFor(x))}</span><span>·</span><time datetime="${esc(d ? d.toISOString() : "")}" title="${esc(d ? d.toLocaleDateString() : "")}">${esc(relDate(d))}</time>${rt ? `<span>·</span><span>${rt}</span>` : ""}${snoozeNote}</div><h2>${esc(x.title)}</h2>${excerpt}<div class="article-bottom"><span>${esc(x.author)}</span><span class="article-actions"><button data-action="read" data-id="${esc(x.id)}" title="Toggle read (m)" aria-label="${x.read ? "Mark unread" : "Mark read"}: ${esc(x.title)}" aria-pressed="${x.read}">${x.read ? "○" : "●"}</button><button data-action="save" data-id="${esc(x.id)}" title="Save (s)" aria-label="${x.saved ? "Unsave" : "Save"}: ${esc(x.title)}" aria-pressed="${x.saved}">${icon(x.saved ? "star-filled" : "star")}</button><button data-action="share" data-id="${esc(x.id)}" title="Share article" aria-label="Share: ${esc(x.title)}">${icon("share")}</button>${state.view === "snoozed" ? `<button class="text-btn" data-action="unsnooze" data-id="${esc(x.id)}" title="Bring back now" aria-label="Unsnooze: ${esc(x.title)}">Unsnooze</button>` : ""}</span></div></div>${thumb}</article>`;
  }).join("") : '<div class="empty"><div class="empty-mark">R</div><h2>Nothing to show.</h2><p>Add a feed or change the current filter.</p><button class="primary" id="emptyAdd">Add a feed</button></div>';
  const b = $("#emptyAdd");
  if (b) b.onclick = showFeed;
  // Mark above/below act on the selected article in this list: without
  // a selection there is nothing above or below to mark. Mark visible
  // read is disabled when nothing visible is unread (#136 follow-up).
  const hasSel = a.some(x => x.id === state.selected);
  const ma = $("#markAbove"), mb = $("#markBelow"), mr = $("#markRead");
  if (ma) ma.disabled = !hasSel;
  if (mb) mb.disabled = !hasSel;
  if (mr) mr.disabled = !a.some(x => !x.read);
  // Save search only appears when there is an active search to save (#146).
  const ss = $("#saveSearchBtn");
  if (ss) ss.hidden = !state.query;
}

/* ---------- sanitising ---------- */
/* Resolve relative URLs BEFORE stripping, or they become "/null".
   Handles href, src, srcset and poster. */
function resolveAttr(el, name, base) {
  const v = el.getAttribute(name);
  if (!v) return;
  if (/^(https?:|mailto:|#|data:)/i.test(v)) return;
  try { el.setAttribute(name, new URL(v, base).href); } catch { el.removeAttribute(name); }
}
function resolveSrcset(el, base) {
  const v = el.getAttribute("srcset");
  if (!v) return;
  const out = v.split(",").map(part => {
    const [u, ...rest] = part.trim().split(/\s+/);
    if (!u || /^(https?:|data:)/i.test(u)) return part.trim();
    try { return [new URL(u, base).href, ...rest].join(" "); } catch { return ""; }
  }).filter(Boolean).join(", ");
  if (out) el.setAttribute("srcset", out); else el.removeAttribute("srcset");
}
/* Page chrome: site furniture, not article text. React/Next.js sites
   (e.g. science.nasa.gov) build their header and footer from <div>s,
   so semantic tags alone do not catch them — roles and the usual
   site-chrome class names are needed too. Shared by cleanHTML and
   extractArticle. */
const CHROME_SELECTOR = "header,nav,footer,aside,[role='navigation'],[role='banner'],[role='contentinfo'],[role='complementary'],[role='search'],.site-header,.site-footer,.site-nav,.global-header,.global-footer,.navbar,.nav,.navigation,.nav-menu,.main-nav,.site-menu,.page-header,.page-footer,.share,.social,.related,.comments,#comments";
function cleanHTML(html, base) {
  const doc = new DOMParser().parseFromString(html, "text/html");
  doc.querySelectorAll("script,style,iframe,object,embed,form,link,meta,noscript," + CHROME_SELECTOR).forEach(n => n.remove());
  doc.querySelectorAll("*").forEach(n => {
    ["href", "src", "poster"].forEach(name => resolveAttr(n, name, base));
    resolveSrcset(n, base);
    [...n.attributes].forEach(a => {
      if (/^on/i.test(a.name)) { n.removeAttribute(a.name); return; }
      if ((a.name === "href" || a.name === "src") && !/^(https?:|mailto:|#|data:image\/)/i.test(a.value)) n.removeAttribute(a.name);
      // SVG's xlink:href is a second href the check above never sees:
      // <a xlink:href="javascript:..."> would run on click.
      if (a.name === "xlink:href") n.removeAttribute(a.name);
      if (a.name === "style") n.removeAttribute(a.name);
    });
    if (n.tagName === "A" && n.getAttribute("href")) { n.target = "_blank"; n.rel = "noopener noreferrer"; }
    if (n.tagName === "IMG") {
      // Lazy-loaded images only carry data-src until the page's scripts
      // run; promote it so the image survives extraction.
      if (!n.getAttribute("src")) {
        const ds = n.getAttribute("data-src") || n.getAttribute("data-lazy-src") || n.getAttribute("data-original");
        if (ds) { n.setAttribute("src", ds); resolveAttr(n, "src", base); }
      }
      if (!n.getAttribute("src")) n.remove();
    }
  });
  return doc.body;
}

/* Full-article extraction (#146): Mozilla Readability first — the same
   library Firefox Reader View and FriRSS use. It scores paragraphs and
   strips the page chrome (nav, sidebars, footers) that the hand-rolled
   heuristic below can leave behind (e.g. the NASA footer on APOD
   pages). Readability needs a document whose base URL resolves
   relative links, so a <base> tag is inserted first, as FriRSS does.
   Its cost grows with the page's nesting, so it is bounded
   (maxElemsToParse) and any failure — or a too-short result — falls
   back to the hand-rolled heuristic, which never throws. */
function extractArticle(html, base) {
  if (typeof Readability === "function") {
    try {
      const doc = new DOMParser().parseFromString(html, "text/html");
      // A relative URL in the page means nothing to a document parsed
      // from a string; <base> resolves it here.
      const b = doc.createElement("base");
      b.setAttribute("href", base);
      if (doc.head) doc.head.prepend(b);
      // Resolve lazy images before Readability scores the page, so an
      // image-heavy article is not scored as empty.
      doc.querySelectorAll("img").forEach(n => {
        const ds = n.getAttribute("data-src") || n.getAttribute("data-lazy-src") || n.getAttribute("data-original");
        if (ds && !n.getAttribute("src")) n.setAttribute("src", ds);
      });
      const parsed = new Readability(doc, { maxElemsToParse: 8000 }).parse();
      if (parsed?.content && (parsed.textContent || "").trim().length >= 200) {
        return cleanHTML(parsed.content, base);
      }
    } catch {}
  }
  return extractArticleHeuristic(html, base);
}
/* The hand-rolled fallback: prefer <article>/<main>, otherwise the
   block with the most paragraph text; drop nav/chrome. */
function extractArticleHeuristic(html, base) {
  const doc = new DOMParser().parseFromString(html, "text/html");
  // Drop page chrome before choosing the article root, or the
  // largest-text scoring picks a page wrapper that contains it.
  doc.querySelectorAll("script,style,form,noscript," + CHROME_SELECTOR).forEach(n => n.remove());
  let root = doc.querySelector("article") || doc.querySelector("main") || doc.querySelector('[role="main"]');
  if (!root) {
    let best = null, bestScore = 0;
    doc.querySelectorAll("div,section").forEach(el => {
      const ps = [...el.querySelectorAll("p")].reduce((t, p) => t + (p.textContent || "").length, 0);
      if (ps > bestScore && ps > 400) { bestScore = ps; best = el; }
    });
    root = best || doc.body;
  }
  const clone = root.cloneNode(true);
  return cleanHTML(clone.innerHTML, base);
}
async function fetchArticleHtml(url, title) {
  let directErr = null;
  try {
    const r = await fetchWithTimeout(url, {
      headers: { Accept: "text/html,application/xhtml+xml,*/*" }, cache: "no-store"
    });
    if (!r.ok) throw Error("HTTP " + r.status);
    const text = await r.text();
    if (!/<(article|main|body|div|p)[\s>]/i.test(text)) throw Error("Not an article page.");
    return text;
  } catch (e) { directErr = e; }
  if (!state.settings.proxyFallback) throw directErr;
  // Reader service (returns the article as Markdown). Fast when it works;
  // it rate-limits shared IPs, so a failure here just falls through.
  // If the title appears only after a long run of navigation text, the
  // service returned the whole page, not the article: keep its output as
  // a last resort, but prefer the raw page HTML below.
  let jinaHtml = null;
  try {
    const r = await fetchWithTimeout(JINA + url, {
      headers: { Accept: "text/plain" }, cache: "no-store"
    }, PROXY_TIMEOUT_MS);
    if (!r.ok) throw Error("HTTP " + r.status);
    const md = await r.text();
    if (/RateLimitTriggeredError/i.test(md)) throw Error("Reader service rate-limited.");
    const html = markdownToHTML(md);
    if (stripTags(html).length < 200) throw Error("No article text found.");
    const pos = titleAnchorPos(stripTags(html), title);
    if (pos < 0 || pos <= 1200) return html;
    jinaHtml = html;
  } catch {}
  // Generic proxy (returns the raw page HTML). Slow and flaky per site.
  try {
    const r = await fetchWithTimeout(ALLORIGINS + encodeURIComponent(url), { cache: "no-store" }, PROXY_TIMEOUT_MS);
    if (!r.ok) throw Error("HTTP " + r.status);
    const text = await r.text();
    if (!/<(article|main|body|div|p)[\s>]/i.test(text)) throw Error("Not an article page.");
    return text;
  } catch (e) {
    if (jinaHtml) return jinaHtml;
    throw directErr || e;
  }
}
/* The site's own WordPress API, looked up by the article slug. No third
   party is involved, so this runs whether or not the proxy is on — the
   same principle as feed loading. Returns the post HTML, or null. */
async function fetchViaWordPress(url) {
  let origin, slug;
  try {
    const u = new URL(url);
    origin = u.origin;
    const parts = u.pathname.split("/").filter(Boolean);
    slug = parts[parts.length - 1] || "";
  } catch { return null; }
  if (!slug) return null;
  try {
    const r = await fetchWithTimeout(`${origin}/wp-json/wp/v2/posts?slug=${encodeURIComponent(slug)}&per_page=1`, {
      headers: { Accept: "application/json" }, cache: "no-store"
    });
    if (!r.ok) return null;
    const posts = await r.json();
    if (!Array.isArray(posts) || !posts.length) return null;
    const content = posts[0]?.content?.rendered || "";
    if (stripTags(content).length < 200) return null;
    return content;
  } catch { return null; }
}
/* Small Markdown → HTML converter for the reader service's output.
   The source is escaped first, so raw HTML in the article cannot inject. */
function markdownToHTML(md) {
  const start = md.indexOf("Markdown Content:");
  const text = start >= 0 ? md.slice(start + "Markdown Content:".length) : md;
  const escMd = s => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const inline = s => escMd(s)
    .replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (m, alt, u) => `<img src="${u}" alt="${escMd(alt)}">`)
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (m, t, u) => `<a href="${u}">${t}</a>`)
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>")
    .replace(/`([^`\n]+)`/g, "<code>$1</code>");
  const lines = text.split("\n");
  let html = "", para = [], list = null;
  /* Consecutive list items belong in ONE list element, not a stack of
     one-item lists. */
  const flushList = () => {
    if (!list) return;
    html += `<${list.tag}>` + list.items.map(i => `<li>${i}</li>`).join("") + `</${list.tag}>`;
    list = null;
  };
  const flush = () => { flushList(); if (para.length) { html += "<p>" + para.join(" ") + "</p>"; para = []; } };
  const startList = tag => {
    if (!list || list.tag !== tag) { flush(); list = { tag, items: [] }; }
  };
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) { flush(); continue; }
    const h = line.match(/^(#{1,3})\s+(.*)$/);
    if (h) { flush(); const lvl = h[1].length + 1; html += `<h${lvl}>${inline(h[2])}</h${lvl}>`; continue; }
    if (/^---+$/.test(line)) { flush(); html += "<hr>"; continue; }
    if (/^>\s?/.test(line)) { flush(); html += `<blockquote>${inline(line.replace(/^>\s?/, ""))}</blockquote>`; continue; }
    if (/^[-*]\s+/.test(line)) { startList("ul"); list.items.push(inline(line.replace(/^[-*]\s+/, ""))); continue; }
    if (/^\d+[.)]\s+/.test(line)) { startList("ol"); list.items.push(inline(line.replace(/^\d+[.)]\s+/, ""))); continue; }
    para.push(inline(line));
  }
  flush();
  return html;
}
async function loadFullText(item) {
  const btn = $('[data-reader="fulltext"]');
  // The button is an icon: change only its state and label, never its content.
  if (btn) { btn.disabled = true; btn.title = "Loading…"; }
  try {
    // The site's own WordPress API first — but only for sites we know
    // are WordPress (their feed loaded via the WP API). Asking every
    // other publisher's origin for /wp-json/ can only 404.
    const f = state.feeds.find(f => f.id === item.feedId);
    const wp = (f?.via === "wp" || f?.wpRoot) ? await fetchViaWordPress(item.url) : null;
    if (wp) {
      item.fullContent = wp;
    } else {
      const html = await fetchArticleHtml(item.url, item.title);
      const body = extractArticle(html, item.url);
      if (!body || !body.textContent.trim()) throw Error("No article text found.");
      item.fullContent = body.innerHTML;
    }
    await put(item);
    // The article's body changed, so its cached search text is stale.
    searchTextCache.delete(item.id);
    // The load can take tens of seconds; the user may have opened
    // another article or closed the reader meanwhile. Only re-open the
    // article if it is still the one on screen, or the completed load
    // would yank the reader back to a stale article.
    if (state.selected === item.id) openItem(item.id);
    else if (btn) { btn.disabled = false; btn.title = "Load full article"; }
    toast("Full article loaded.");
  } catch (e) {
    if (btn) { btn.disabled = false; btn.title = "Load full article"; }
    toast(state.settings.proxyFallback
      ? "Full text unavailable — the publisher blocks direct access and the reader services could not fetch this page."
      : "Full text unavailable — showing the feed excerpt. Turn on the proxy fallback in Settings to try reader services.");
  }
}

function readerBodyHTML(x) {
  const showingFull = !!x.fullContent;
  let body = showingFull ? x.fullContent : (x.content || x.summary || "<p>No article text was included in this feed.</p>");
  // Convert plain-text Markdown locally; preserve existing HTML feeds.
  const hasHTML = body.trimStart().startsWith("<");
  if (window.RSSMarkdown && window.DOMPurify && !hasHTML && RSSMarkdown.looksLikeMarkdown(body)) {
    body = DOMPurify.sanitize(RSSMarkdown.render(body), { USE_PROFILES: { html: true } });
  }
  return { showingFull, body };
}
/* Build the reader pane for an item without changing its read state.
   openItem() marks the item read first; toggles (m, list buttons) call
   this directly so marking an item unread is not immediately undone. */
/* Text-to-speech bar (#105): shown while an article is being read
   aloud. The speed selector applies from the next spoken chunk. */
const ttsBarHTML = x => {
  const active = tts && tts.itemId === x.id;
  const rate = state.settings.ttsRate || 1;
  const opt = v => `<option value="${v}"${rate === v ? " selected" : ""}>${v}×</option>`;
  return `<div class="tts-bar" id="ttsBar"${active ? "" : " hidden"}><span>Listening</span><button type="button" data-tts="pause">${tts?.paused ? "Resume" : "Pause"}</button><button type="button" data-tts="stop">Stop</button><label>Speed <select id="ttsSpeed" aria-label="Reading speed">${opt(0.75)}${opt(1)}${opt(1.25)}${opt(1.5)}${opt(2)}</select></label></div>`;
};
/* ---------- snoozing (#113) ---------- */
/* Later today is four hours out; tomorrow and next week come back at
   9:00 AM. Saved is keep forever; snoozed is come back later — the
   two stay separate, and a snoozed article is never deleted. */
function snoozeUntil(kind) {
  const now = new Date();
  if (kind === "later") return Date.now() + 4 * 3600 * 1000;
  const d = new Date(now);
  d.setDate(d.getDate() + (kind === "tomorrow" ? 1 : 7));
  d.setHours(9, 0, 0, 0);
  return d.getTime();
}
const snoozeMenuHTML = x => {
  const until = isSnoozed(x) ? new Date(x.snoozedUntil) : null;
  const fmt = d => d.toLocaleDateString([], { weekday: "short" }) + " " + d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  const later = new Date(Date.now() + 4 * 3600 * 1000);
  const tomorrow = new Date(); tomorrow.setDate(tomorrow.getDate() + 1); tomorrow.setHours(9, 0, 0, 0);
  const week = new Date(); week.setDate(week.getDate() + 7); week.setHours(9, 0, 0, 0);
  return `<div class="snooze-menu" id="snoozeMenu" hidden><button type="button" data-snooze="later">Later today · ${esc(fmt(later))}</button><button type="button" data-snooze="tomorrow">Tomorrow · ${esc(fmt(tomorrow))}</button><button type="button" data-snooze="week">Next week · ${esc(fmt(week))}</button>${until ? `<button type="button" data-snooze="clear">Unsnooze (back now)</button>` : ""}</div>`;
};
async function snoozeItem(x, kind) {
  const until = snoozeUntil(kind);
  x.snoozedUntil = until;
  await put(x);
  renderNav();
  renderList();
  toast(`Snoozed until ${fmtDateTime(new Date(until))}.`, { label: "Undo", fn: async () => {
    x.snoozedUntil = null;
    await put(x);
    render();
  } });
}
async function unsnoozeItem(x) {
  x.snoozedUntil = null;
  await put(x);
  render();
  if (state.selected === x.id) renderReader(x);
  toast("Back in your lists.");
}
function renderReader(x) {
  // Re-rendering the same article (a save/read toggle, a tag change)
  // must not stop playback: only stop TTS when the article changes.
  if (tts?.itemId !== x.id) stopTTS();
  // Preserve podcast playback across re-renders of the same episode:
  // the audio element is rebuilt below, so its position, speed, and
  // playing state are captured first and restored after. The scroll
  // position is captured the same way, so a toggle does not jump the
  // reader back to the top.
  const oldAudio = $("#audioPlayer");
  const audioState = oldAudio ? { time: oldAudio.currentTime, playing: !oldAudio.paused, rate: oldAudio.playbackRate } : null;
  const prevScroll = $("#reader").scrollTop;
  const wasOpen = $("#reader").dataset.openId === x.id;
  const f = state.feeds.find(f => f.id === x.feedId);
  const d = date(x.published);
  const rt = readingTimeText(x);
  const { showingFull, body } = readerBodyHTML(x);
  // WordPress API items already carry the full article, and so does any
  // feed item with long content — do not offer to "load" what is there.
  /* "Full article included in feed" only when we know it: the feed was
     loaded from the site's own WordPress API, whose posts carry full
     content. Length is NOT a signal — some feeds (e.g. NASA) ship long
     excerpts padded with site boilerplate, which the old >1500-char
     guess mislabelled as full and left with no way to fetch the rest. */
  const alreadyFull = !showingFull && (
    (f?.via === "wp" && stripTags(x.content || "").length > 200) ||
    (x.fullContentIncluded && stripTags(x.content || "").length > 200)
  );
  const canFull = !showingFull && !x.fullContent && !alreadyFull;
  // The progress bar sits at the very edge of the reader (top or bottom,
  // per the setting), so it is placed before the content for top and
  // after it for bottom.
  const progTop = state.settings.progressPosition === "top";
  const barHTML = `<div id="readProgress" class="${progTop ? "top" : "bottom"}"><i></i></div>`;
  const isAudio = !!x.enclosure?.type?.startsWith("audio/");
  const canListen = "speechSynthesis" in window;
  const audioHTML = isAudio ? `<div class="audio-player"><audio id="audioPlayer" controls preload="metadata" src="${esc(x.enclosure.url)}"></audio><div class="audio-controls"><label>Speed <select id="audioSpeed" aria-label="Playback speed"><option value="0.75">0.75×</option><option value="1" selected>1×</option><option value="1.25">1.25×</option><option value="1.5">1.5×</option><option value="2">2×</option></select></label><a href="${esc(x.enclosure.url)}" target="_blank" rel="noopener">Open audio ↗</a></div></div>` : "";
  $("#reader").innerHTML = `${progTop ? barHTML : ""}<div class="reader-content"><div class="reader-top"><span>${esc(f?.title || x.feedTitle)}</span><div class="reader-actions"><button data-reader="save" title="Save (s)" aria-label="${x.saved ? "Unsave article" : "Save article"}" aria-pressed="${x.saved}">${icon(x.saved ? "star-filled" : "star")}</button><button data-reader="read" title="${x.read ? "Mark unread (m)" : "Mark read (m)"}" aria-label="${x.read ? "Mark unread" : "Mark read"}">${x.read ? "◉" : "○"}</button><button data-reader="listen" title="${canListen ? "Listen to article" : "Text-to-speech is not available in this browser"}" aria-label="Listen to article" aria-pressed="false" ${canListen ? "" : "disabled"}>${icon("speak")}</button><button data-reader="share" title="Share article" aria-label="Share article">${icon("share")}</button><button data-reader="snooze" title="Snooze article" aria-label="Snooze article" aria-haspopup="true" aria-expanded="false">${icon("clock")}</button><button data-reader="fulltext" title="${showingFull ? "Showing full article" : alreadyFull ? "Full article included in feed" : "Load full article"}" aria-label="${showingFull ? "Showing full article" : alreadyFull ? "Full article included in feed" : "Load full article"}" ${canFull ? "" : "disabled"}>${icon("doc")}</button><button data-reader="open" title="Open original (v)" aria-label="Open original">↗</button><button data-reader="close" title="Close (u / Esc)" aria-label="Close article">${icon("close")}</button></div></div>${snoozeMenuHTML(x)}${ttsBarHTML(x)}<h1>${esc(x.title)}</h1><div class="byline">${esc(x.author)} · ${esc(d ? fmtDateTime(d) : "No date")}${rt ? " · " + rt : ""}</div><div class="tags-row" id="tagsRow">${(x.tags || []).map(t => `<span class="tag-chip">${esc(t)}<button type="button" data-tag-remove="${esc(t)}" aria-label="Remove tag ${esc(t)}">${icon("close")}</button></span>`).join("")}<input id="tagInput" list="tagList" placeholder="Add a tag… (t)" aria-label="Add a tag"><datalist id="tagList">${state.tags.map(t => `<option value="${esc(t)}">`).join("")}</datalist></div>${audioHTML}<div class="reader-body" id="body"></div><div class="reader-footer"><p>${showingFull ? "Full article text, extracted from the original page." : "Content supplied by the publisher's feed."}</p></div>${highlightsSectionHTML(x)}</div>${progTop ? "" : barHTML}`;
  const bodyEl = $("#body");
  // Append the cleaned body's children, not the <body> element itself.
  // cleanHTML drops the page chrome (header/nav/footer); the leading-nav
  // strip then removes any boilerplate nav block (e.g. APOD) that was
  // a plain div/table, now that the chrome above it is gone. The strip
  // runs on a clone, so if it would gut the article the un-stripped
  // body is used instead.
  const cleaned = cleanHTML(body, x.url);
  // A content image (the article's picture) vs site chrome: logos,
  // thumbnails, icons, SVGs and WordPress theme assets are chrome.
  const isContentImg = im => {
    const src = im.getAttribute("src") || "";
    return src && !/logo|thumb|icon|\.svg$|\/themes\//i.test(src);
  };
  // Capture the article's main image before the title cut can remove
  // it: the last content image in the body. The feed often stores no
  // image and the feed content may not carry one either, so the full
  // text itself is the only source of the picture. The article
  // picture sits after the site's teaser images and before the
  // footer logo, so the last content image is it.
  let articleImgSrc = "";
  for (const im of cleaned.querySelectorAll("img")) {
    if (!isContentImg(im)) continue;
    articleImgSrc = im.getAttribute("src") || "";
  }
  // The title is the anchor for reader-service output that flattened the
  // whole page into plain blocks: drop everything before it, then strip
  // any leading nav block that remains.
  cutBeforeTitleEl(cleaned, x.title);
  const stripped = cleaned.cloneNode(true);
  const bodyToUse = stripLeadingNavEl(stripped, x.title) ? stripped : cleaned;
  // The title cut can remove a leading article picture (an image
  // paragraph has no text, so it is swept up with the chrome). If the
  // body has no picture near the top, restore the article's image
  // there. The footer logo at the bottom does not count — only the
  // first few children are checked. The feed's image is preferred;
  // when the item has none stored, the first image in the feed
  // content is the article's picture, and failing that the picture
  // captured from the full text before the cut.
  // This is the ONLY place a hero image is added (#150): the reader
  // template used to render x.image as a hero too, so any article
  // whose body carried no image got the same picture twice, back
  // to back. If the body already has a picture near the top, no
  // hero is added at all.
  const heroSrc = x.image || firstImgSrc(x.content) || articleImgSrc;
  const topImgChild = [...bodyToUse.children].slice(0, 10).find(c =>
    [...c.querySelectorAll("img")].some(isContentImg));
  if (heroSrc && !topImgChild) {
    const hero = document.createElement("p");
    hero.className = "reader-hero";
    const img = document.createElement("img");
    img.src = heroSrc;
    img.alt = "";
    img.loading = "lazy";
    hero.appendChild(img);
    bodyToUse.prepend(hero);
  }
  bodyEl.append(...bodyToUse.childNodes);
  // Highlights (#116): mark the saved passages back into the text.
  applyHighlights(bodyEl, highlightsFor(x.id));
  $("#reader").classList.add("open");
  // A fresh article starts at the top; a re-render of the same article
  // (a save/read toggle, a tag change) keeps its scroll position.
  $("#reader").dataset.openId = x.id;
  $("#reader").scrollTop = wasOpen ? prevScroll : 0;
  updateReadProgress();
  bindAudioPlayer(x);
  // Restore a playing episode across the re-render (see above): the
  // position can only be set once the audio metadata has loaded.
  if (audioState) {
    const a2 = $("#audioPlayer");
    if (a2) {
      a2.playbackRate = audioState.rate;
      const speed = $("#audioSpeed");
      if (speed) speed.value = String(audioState.rate);
      const restore = () => { try { a2.currentTime = audioState.time; } catch {} if (audioState.playing) a2.play().catch(() => {}); };
      if (a2.readyState >= 1) restore();
      else a2.addEventListener("loadedmetadata", restore, { once: true });
    }
  }
  if (history.state?.reader !== x.id) {
    try {
      if (history.state?.reader) history.replaceState({ reader: x.id }, "");
      else history.pushState({ reader: x.id }, "");
    } catch {}
  }
}
/* Wire the inline audio player for a podcast episode: the speed
   selector, and the Media Session API so the phone's lock screen and
   notification show the episode with play/pause and seek. Audio
   streams over the network and is not kept offline. */
function bindAudioPlayer(x) {
  const audio = $("#audioPlayer");
  if (!audio) return;
  const speed = $("#audioSpeed");
  if (speed) speed.onchange = () => { audio.playbackRate = Number(speed.value) || 1; };
  if ("mediaSession" in navigator) {
    try {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: x.title,
        artist: x.author || x.feedTitle,
        album: x.feedTitle
      });
      navigator.mediaSession.setActionHandler("play", () => audio.play());
      navigator.mediaSession.setActionHandler("pause", () => audio.pause());
      navigator.mediaSession.setActionHandler("seekto", d => { if (d.seekTime != null) audio.currentTime = d.seekTime; });
    } catch {}
  }
}
/* ---------- text-to-speech (#105) ---------- */
/* The Web Speech API is built into the browser: no backend, no cost.
   The article is read in sentence chunks of about 500 characters, so
   pause/resume and speed changes have somewhere to take effect, and
   one failed utterance does not lose the whole article. No sentence
   highlighting: boundary events are unreliable across browsers, so
   this version just plays the text. */
function ttsChunksFor(x) {
  const text = (x.title + ". " + plainText(x.fullContent || x.content || x.summary || "")).replace(/\s+/g, " ").trim();
  const sentences = text.match(/[^.!?]+[.!?]+["')\]]*\s*|[^.!?]+$/g) || [text];
  const chunks = [];
  let cur = "";
  for (const s of sentences) {
    if (cur && (cur + s).length > 500) { chunks.push(cur.trim()); cur = s; }
    else cur += s;
  }
  if (cur.trim()) chunks.push(cur.trim());
  return chunks.filter(Boolean);
}
function updateTTSUI() {
  const bar = $("#ttsBar");
  const btn = $('[data-reader="listen"]');
  if (btn) {
    btn.classList.toggle("listening", !!tts);
    btn.setAttribute("aria-pressed", String(!!tts));
    btn.title = tts ? "Stop listening" : "Listen to article";
  }
  if (!bar) return;
  bar.hidden = !tts;
  const pause = bar.querySelector('[data-tts="pause"]');
  if (pause) pause.textContent = tts?.paused ? "Resume" : "Pause";
}
function speakChunk() {
  if (!tts) return;
  if (tts.index >= tts.chunks.length) { stopTTS(); toast("Finished reading."); return; }
  const u = new SpeechSynthesisUtterance(tts.chunks[tts.index]);
  u.rate = state.settings.ttsRate || 1;
  u.onend = () => {
    if (!tts) return;
    // Paused when the chunk ended: do not advance; resuming replays
    // this chunk from its start rather than skipping ahead.
    if (tts.paused) return;
    tts.index++;
    speakChunk();
  };
  u.onerror = e => {
    if (!tts) return;
    if (e?.error === "canceled" || e?.error === "interrupted") return;
    stopTTS();
    toast("Text-to-speech stopped: the browser could not read this article.");
  };
  speechSynthesis.speak(u);
  updateTTSUI();
}
function startTTS(x) {
  if (!("speechSynthesis" in window)) { toast("Text-to-speech is not available in this browser."); return; }
  stopTTS();
  const chunks = ttsChunksFor(x);
  if (!chunks.length) { toast("Nothing to read in this article."); return; }
  tts = { itemId: x.id, chunks, index: 0, paused: false };
  speakChunk();
}
function pauseTTS() {
  if (!tts || tts.paused) return;
  tts.paused = true;
  try { speechSynthesis.pause(); } catch {}
  updateTTSUI();
}
function resumeTTS() {
  if (!tts || !tts.paused) return;
  tts.paused = false;
  try { speechSynthesis.resume(); } catch {}
  // If the utterance already ended while paused, resume() does
  // nothing: restart the current chunk so playback continues.
  setTimeout(() => { if (tts && !speechSynthesis.speaking && tts.index < tts.chunks.length) speakChunk(); }, 300);
  updateTTSUI();
}
function stopTTS() {
  if (!tts) return;
  tts = null;
  try { speechSynthesis.cancel(); } catch {}
  updateTTSUI();
}

/* ---------- sharing (#112) ---------- */
/* Share the original article link, not anything stored in the app.
   The system share sheet where the browser has one; otherwise copy
   the link to the clipboard, with a textarea fallback for browsers
   whose clipboard API is unavailable. */
async function shareArticle(x) {
  if (navigator.share) {
    try { await navigator.share({ title: x.title, text: x.title, url: x.url }); return; }
    catch (e) { if (e?.name === "AbortError") return; }
  }
  const copyFallback = () => {
    const ta = document.createElement("textarea");
    ta.value = x.url;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand("copy"); } catch {}
    ta.remove();
    return ok;
  };
  try {
    await navigator.clipboard.writeText(x.url);
    toast("Link copied to clipboard.");
  } catch {
    toast(copyFallback() ? "Link copied to clipboard." : "Sharing is not available in this browser. Open the original article to copy its address.");
  }
}
/* ---------- highlights and notes (#116) ---------- */
/* The article's highlights, newest first. */
const highlightsFor = itemId => state.highlights.filter(h => h.itemId === itemId).sort((a, b) => (b.created || 0) - (a.created || 0));
/* Wrap a highlight's text in the rendered article body. The body is
   rebuilt from HTML on every open, so highlights are found again by
   their text: walk the text nodes in order, track the character offset,
   and wrap the matching range by splitting nodes. Whitespace is
   collapsed on both sides first, so a selection that crossed a line
   break still matches. A highlight whose text is no longer in the
   article (the text changed after a re-fetch) is skipped, not forced. */
function markHighlightText(bodyEl, h) {
  const text = h?.text || "";
  const needle = String(text || "").replace(/\s+/g, " ").trim();
  if (!needle) return false;
  const walker = document.createTreeWalker(bodyEl, NodeFilter.SHOW_TEXT);
  const nodes = [];
  let raw = "";
  for (let n = walker.nextNode(); n; n = walker.nextNode()) { nodes.push(n); raw += n.nodeValue; }
  // Collapse runs of whitespace to one space, remembering for each
  // collapsed character the raw index it came from.
  const map = [];
  let collapsed = "";
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (/\s/.test(c)) {
      if (collapsed && !collapsed.endsWith(" ")) { collapsed += " "; map.push(i); }
    } else { collapsed += c; map.push(i); }
  }
  const start = collapsed.indexOf(needle);
  if (start < 0) return false;
  const rawStart = map[start];
  const rawEnd = map[start + needle.length - 1] + 1;
  // Collect the (node, local start, local end) pieces, then wrap them
  // last-to-first so splitting one node never moves another's offsets.
  const pieces = [];
  let offset = 0;
  for (const n of nodes) {
    const nodeEnd = offset + n.nodeValue.length;
    const s = Math.max(rawStart, offset), e = Math.min(rawEnd, nodeEnd);
    if (s < e) pieces.push([n, s - offset, e - offset]);
    offset = nodeEnd;
  }
  for (let i = pieces.length - 1; i >= 0; i--) {
    const [n, s, e] = pieces[i];
    const mid = n.splitText(s);
    mid.splitText(e - s);
    const mark = document.createElement("mark");
    mark.className = "hl";
    if (h?.id) mark.dataset.hlId = h.id;
    mid.parentNode.replaceChild(mark, mid);
    mark.appendChild(mid);
  }
  return pieces.length > 0;
}
function applyHighlights(bodyEl, highlights) {
  for (const h of highlights) markHighlightText(bodyEl, h);
}
async function saveHighlight(itemId, text, note) {
  const h = { id: id(), itemId, text: String(text || "").replace(/\s+/g, " ").trim(), note: (note || "").trim(), created: Date.now() };
  if (!h.text) return null;
  state.highlights.push(h);
  try { await hlPut(h); } catch (e) { state.highlights = state.highlights.filter(v => v.id !== h.id); toast("Could not save the highlight."); return null; }
  return h;
}
async function deleteHighlight(hlId) {
  state.highlights = state.highlights.filter(v => v.id !== hlId);
  try { await hlDelete(hlId); } catch {}
  render();
  if (state.selected) { const x = selectedItem(); if (x) renderReader(x); }
  toast("Highlight deleted.");
}
async function updateHighlightNote(hlId, note) {
  const h = state.highlights.find(v => v.id === hlId);
  if (!h) return;
  h.note = (note || "").trim();
  try { await hlPut(h); } catch {}
  if (state.selected) { const x = selectedItem(); if (x) renderReader(x); }
  renderNav();
}
/* The text the user has selected in the open article, waiting to be
   saved as a highlight, and the highlight being edited (its note). */
let pendingHighlight = null, editingHlId = null;
/* Show the floating Highlight button while there is a selection inside
   the article body (#116). It sits just above the selection so it does
   not cover the text, and hides on scroll or when the selection clears. */
function updateHlBtn() {
  const btn = $("#hlBtn");
  if (!btn || !state.selected) { if (btn) btn.hidden = true; return; }
  // Typing in a field is not a selection to highlight.
  const tag = document.activeElement?.tagName;
  if (["INPUT", "TEXTAREA", "SELECT"].includes(tag)) { btn.hidden = true; return; }
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) { btn.hidden = true; return; }
  const body = $("#body");
  if (!body || !body.contains(sel.anchorNode) || !body.contains(sel.focusNode)) { btn.hidden = true; return; }
  const text = sel.toString().replace(/\s+/g, " ").trim();
  if (!text) { btn.hidden = true; return; }
  pendingHighlight = { itemId: state.selected, text };
  const r = sel.getRangeAt(0).getBoundingClientRect();
  btn.style.left = Math.max(8, Math.min(window.innerWidth - 110, r.left + r.width / 2 - 45)) + "px";
  btn.style.top = Math.max(8, r.top - 42) + "px";
  btn.hidden = false;
}
function showHlDialog() {
  if (!pendingHighlight) return;
  editingHlId = null;
  $("#hlQuote").textContent = pendingHighlight.text;
  $("#hlNote").value = "";
  $("#hlDialog").showModal();
  $("#hlNote").focus();
}
/* Edit the note on an existing highlight, reusing the same dialog. */
function showHlNoteDialog(hlId) {
  const h = state.highlights.find(v => v.id === hlId);
  if (!h) return;
  editingHlId = hlId;
  pendingHighlight = null;
  $("#hlQuote").textContent = h.text;
  $("#hlNote").value = h.note || "";
  $("#hlDialog").showModal();
  $("#hlNote").focus();
}
async function saveHlFromDialog() {
  if (editingHlId) {
    await updateHighlightNote(editingHlId, $("#hlNote").value);
    $("#hlDialog").close();
    editingHlId = null;
    toast("Note saved.");
    return;
  }
  if (!pendingHighlight) return;
  const h = await saveHighlight(pendingHighlight.itemId, pendingHighlight.text, $("#hlNote").value);
  $("#hlDialog").close();
  $("#hlBtn").hidden = true;
  window.getSelection()?.removeAllRanges();
  pendingHighlight = null;
  if (h) {
    const x = selectedItem();
    if (x) renderReader(x);
    renderNav();
    toast("Highlight saved.");
  }
}
/* The article's highlights, listed under it: the quoted text, the note,
   and a way to jump to the passage or delete it. */
function highlightsSectionHTML(x) {
  const list = highlightsFor(x.id);
  if (!list.length) return `<div class="hl-section"><h3>Highlights</h3><p class="muted">Select text in the article to highlight it, with an optional note.</p></div>`;
  return `<div class="hl-section"><h3>Highlights (${list.length})</h3>` + list.map(h =>
    `<div class="hl-item" data-hl-id="${esc(h.id)}"><blockquote>${esc(h.text)}</blockquote>` +
    (h.note ? `<p class="hl-note">${esc(h.note)}</p>` : "") +
    `<div class="hl-actions"><button type="button" class="quiet" data-hl-note="${esc(h.id)}">${h.note ? "Edit note" : "Add note"}</button><button type="button" class="quiet" data-hl-goto="${esc(h.id)}">Show in article</button><button type="button" class="quiet" data-hl-delete="${esc(h.id)}">Delete</button></div></div>`
  ).join("") + `</div>`;
}
/* Open a highlight's article and scroll to the passage (#116). */
function scrollToHighlight(hlId) {
  const mark = document.querySelector(`mark.hl[data-hl-id="${CSS.escape(hlId)}"]`);
  if (!mark) { toast("That passage is not in the article text anymore."); return; }
  mark.scrollIntoView({ behavior: "smooth", block: "center" });
  mark.classList.add("hl-flash");
  setTimeout(() => mark.classList.remove("hl-flash"), 1200);
}
function openHighlight(hlId) {
  const h = state.highlights.find(v => v.id === hlId);
  if (!h) return;
  openItem(h.itemId);
  // The reader renders synchronously, so the mark is there to scroll to.
  requestAnimationFrame(() => scrollToHighlight(hlId));
}
function openItem(itemId) {
  const x = state.items.find(i => i.id === itemId);
  if (!x) return;
  const prevId = state.selected;
  state.selected = itemId;
  const wasUnread = !x.read;
  if (wasUnread) { x.read = true; put(x); }
  renderNav();
  // Opening an article in the Unread view removes it from that list,
  // so the whole list has to be rebuilt there. Everywhere else the
  // read state does not change membership, so only the two affected
  // rows are updated instead of rebuilding the whole list.
  if (state.view === "unread") {
    renderList();
  } else {
    const prevRow = prevId ? document.querySelector(`[data-item="${CSS.escape(prevId)}"]`) : null;
    if (prevRow) prevRow.classList.remove("selected");
    const row = document.querySelector(`[data-item="${CSS.escape(itemId)}"]`);
    if (row) {
      row.classList.add("selected");
      if (wasUnread) {
        row.classList.remove("unread");
        const readBtn = row.querySelector('[data-action="read"]');
        if (readBtn) { readBtn.textContent = "○"; readBtn.setAttribute("aria-pressed", "true"); readBtn.setAttribute("aria-label", "Mark unread: " + x.title); }
      }
    }
  }
  const row = document.querySelector(`[data-item="${CSS.escape(itemId)}"]`);
  if (row) { row.scrollIntoView({ block: "nearest" }); row.focus({ preventScroll: true }); }
  // Mark above/below act on the selected article in this list: with a
  // selection in the list, they are enabled.
  const ma = $("#markAbove"), mb = $("#markBelow");
  if (ma) ma.disabled = !row;
  if (mb) mb.disabled = !row;
  renderReader(x);
}
function closeReader() {
  stopTTS();
  const wasOpen = $("#reader").classList.contains("open") || !!state.selected;
  $("#reader").classList.remove("open");
  delete $("#reader").dataset.openId;
  state.selected = null;
  render(); // resets the reader pane to "Select an article to read"
  if (wasOpen && history.state?.reader) {
    try { history.back(); } catch {}
  }
}
function render() {
  renderNav();
  renderList();
  if (!state.selected) $("#reader").innerHTML = '<div class="reader-empty">' + icon("rss", "big") + '<h2>Nothing open yet</h2><p>Pick an article from the list to read it here.</p><small>Use j and k to move, o to open, ? for all shortcuts.</small></div>';
}

/* ---------- folders & tags ---------- */
function goTag(tag) {
  stopTTS();
  state.view = "tag"; state.tag = tag; state.feed = null; state.folder = null; state.savedSearch = null; state.selected = null;
  $("#reader").classList.remove("open");
  render();
}
async function addTagToItem(x, rawName) {
  const name = String(rawName || "").trim().replace(/\s+/g, " ").slice(0, 40);
  if (!name) return;
  x.tags = x.tags || [];
  if (x.tags.some(t => t.toLowerCase() === name.toLowerCase())) return;
  x.tags.push(name);
  if (!state.tags.some(t => t.toLowerCase() === name.toLowerCase())) {
    state.tags.push(name);
    state.tags.sort((a, b) => a.localeCompare(b));
    saveTags();
  }
  await put(x);
  render();
  renderReader(x);
  $("#tagInput")?.focus();
}
async function removeTagFromItem(x, name) {
  x.tags = (x.tags || []).filter(t => t !== name);
  await put(x);
  // A tag left on no article stops being listed (tags created in the
  // dialog but never applied stay until deleted there).
  if (!state.items.some(i => (i.tags || []).includes(name))) {
    state.tags = state.tags.filter(t => t !== name);
    saveTags();
  }
  render();
  renderReader(x);
}
function createFolder(rawName) {
  const name = String(rawName || "").trim().slice(0, 60);
  if (!name) return toast("Enter a folder name.");
  if (state.folders.some(f => f.toLowerCase() === name.toLowerCase())) return toast("That folder already exists.");
  state.folders.push(name);
  state.folders.sort((a, b) => a.localeCompare(b));
  saveFolders();
  renderOrganize();
  render();
  toast("Folder added.");
}
function createTag(rawName) {
  const name = String(rawName || "").trim().replace(/\s+/g, " ").slice(0, 40);
  if (!name) return toast("Enter a tag name.");
  if (state.tags.some(t => t.toLowerCase() === name.toLowerCase())) return toast("That tag already exists.");
  state.tags.push(name);
  state.tags.sort((a, b) => a.localeCompare(b));
  saveTags();
  renderOrganize();
  render();
  toast("Tag added.");
}
function renameFolder(oldName, rawName) {
  const name = String(rawName || "").trim().slice(0, 60);
  if (!name || name === oldName) return;
  if (state.folders.some(f => f.toLowerCase() === name.toLowerCase())) return toast("That folder already exists.");
  state.folders = state.folders.map(f => f === oldName ? name : f);
  for (const f of state.feeds) if (f.group === oldName) f.group = name;
  saveFolders();
  saveFeeds();
  toast("Folder renamed.");
}
/* Deletes use a two-step confirm inside the dialog (click Delete, then
   click Confirm delete) instead of a native confirm(), which some
   browsers dismiss without the user ever seeing it. */
function deleteFolder(name) {
  if (!pendingDelete || pendingDelete.kind !== "folder" || pendingDelete.name !== name) {
    pendingDelete = { kind: "folder", name };
    renderOrganize();
    toast("Click Delete again to remove the folder.");
    return;
  }
  pendingDelete = null;
  for (const f of state.feeds) if (f.group === name) f.group = "";
  state.folders = state.folders.filter(f => f !== name);
  saveFeeds();
  saveFolders();
  renderOrganize();
  render();
  toast("Folder deleted.");
}
async function renameTag(oldName, rawName) {
  const name = String(rawName || "").trim().replace(/\s+/g, " ").slice(0, 40);
  if (!name || name === oldName) return;
  if (state.tags.some(t => t.toLowerCase() === name.toLowerCase())) return toast("That tag already exists.");
  state.tags = state.tags.map(t => t === oldName ? name : t);
  const changed = [];
  for (const x of state.items) {
    if ((x.tags || []).includes(oldName)) {
      x.tags = x.tags.map(t => t === oldName ? name : t);
      changed.push(x);
    }
  }
  // One batched write instead of a transaction per tagged article.
  if (changed.length) await putMany(changed);
  if (state.view === "tag" && state.tag === oldName) state.tag = name;
  saveTags();
  toast("Tag renamed.");
}
async function deleteTag(name) {
  if (!pendingDelete || pendingDelete.kind !== "tag" || pendingDelete.name !== name) {
    pendingDelete = { kind: "tag", name };
    renderOrganize();
    toast("Click Delete again to remove the tag.");
    return;
  }
  pendingDelete = null;
  const changed = [];
  for (const x of state.items) {
    if ((x.tags || []).includes(name)) {
      x.tags = x.tags.filter(t => t !== name);
      changed.push(x);
    }
  }
  if (changed.length) await putMany(changed);
  state.tags = state.tags.filter(t => t !== name);
  if (state.view === "tag" && state.tag === name) goView("all");
  saveTags();
  renderOrganize();
  render();
  if (state.selected) { const x = selectedItem(); if (x) renderReader(x); }
  toast("Tag deleted.");
}
function moveFeed(feedId, folder) {
  const f = state.feeds.find(f => f.id === feedId);
  if (!f) return;
  f.group = folder;
  saveFeeds();
  syncFolders();
  renderOrganize();
  render();
  toast(folder ? `Moved to “${folder}”.` : "Moved out of its folder.");
}
/* Unsubscribing uses the same two-step confirm as folder and tag
   deletes (click once to arm, click again to confirm) instead of a
   native confirm(), which some browsers dismiss without the user ever
   seeing it. The feed's articles go with it, except ones the user
   saved — those stay in Saved, and merge back if the feed is ever
   re-added (saveItems preserves saved/read/tags/fullContent). */
function requestUnsubscribe(id) {
  const f = state.feeds.find(f => f.id === id);
  if (!f) return;
  if (!pendingDelete || pendingDelete.kind !== "feed" || pendingDelete.id !== id) {
    pendingDelete = { kind: "feed", id };
    renderNav();
    renderOrganize();
    toast(`Click again to unsubscribe from “${f.title}”.`);
    return;
  }
  unsubscribeFeed(id);
}
async function unsubscribeFeed(id) {
  const f = state.feeds.find(f => f.id === id);
  if (!f) return;
  pendingDelete = null;
  const idx = state.feeds.findIndex(x => x.id === id);
  const removed = state.items.filter(x => x.feedId === id && !x.saved);
  state.feeds = state.feeds.filter(x => x.id !== id);
  saveFeeds();
  if (removed.length) await deleteMany(removed.map(x => x.id));
  state.items = state.items.filter(x => x.feedId !== id || x.saved);
  const used = new Set();
  for (const x of state.items) for (const t of x.tags || []) used.add(t);
  if (state.tags.some(t => !used.has(t))) { state.tags = state.tags.filter(t => used.has(t)); saveTags(); }
  if (state.view === "feed" && state.feed === id) { state.view = "all"; state.feed = ""; }
  render();
  renderOrganize();
  if (state.selected) {
    const x = selectedItem();
    if (x) renderReader(x);
    else closeReader();
  }
  toast(`Unsubscribed from “${f.title}”. Saved articles were kept.`, { label: "Undo", fn: async () => {
    state.feeds.splice(idx, 0, f);
    saveFeeds();
    if (removed.length) {
      await putMany(removed);
      // Merge by id: a refresh between the unsubscribe and the Undo
      // may have re-added these articles, and concatenating would
      // duplicate them in memory.
      const byId = new Map(state.items.map(x => [x.id, x]));
      for (const x of removed) byId.set(x.id, x);
      state.items = [...byId.values()];
    }
    render();
  } });
}
async function doRename(rawName) {
  if (!orgEdit) return;
  const { kind, old } = orgEdit;
  orgEdit = null;
  if (kind === "folder") renameFolder(old, rawName);
  else if (kind === "savedSearch") renameSavedSearch(old, rawName);
  else await renameTag(old, rawName);
  renderOrganize();
  render();
  if (state.selected) { const x = selectedItem(); if (x) renderReader(x); }
}
/* Rename a saved search (#108): only the name changes, the filter
   stays as it is. */
function renameSavedSearch(id, rawName) {
  const name = (rawName || "").trim();
  const s = state.savedSearches.find(v => v.id === id);
  if (!s || !name) return;
  s.name = name;
  saveSavedSearches();
  toast(`Renamed to “${name}”.`);
}
function deleteSavedSearch(id) {
  if (!pendingDelete || pendingDelete.kind !== "savedSearch" || pendingDelete.id !== id) {
    pendingDelete = { kind: "savedSearch", id };
    renderOrganize();
    toast("Click Delete again to remove the saved search.");
    return;
  }
  pendingDelete = null;
  state.savedSearches = state.savedSearches.filter(v => v.id !== id);
  saveSavedSearches();
  if (state.view === "savedSearch" && state.savedSearch === id) goView("all");
  renderOrganize();
  render();
  toast("Saved search deleted.");
}
function renderOrganize() {
  const folderRow = name => {
    const count = state.feeds.filter(f => f.group === name).length;
    const armed = pendingDelete?.kind === "folder" && pendingDelete.name === name;
    if (orgEdit?.kind === "folder" && orgEdit.old === name) {
      return `<div class="org-row"><input id="orgEditInput" value="${esc(name)}" aria-label="Folder name"><button type="button" class="quiet" data-org-save-rename>Save</button><button type="button" class="quiet" data-org-cancel-rename>Cancel</button></div>`;
    }
    return `<div class="org-row"><span class="org-name">${esc(name)}</span><small>${count} feed${count === 1 ? "" : "s"}</small><button type="button" class="quiet" data-org-rename-folder="${esc(name)}">Rename</button><button type="button" class="quiet" data-org-delete-folder="${esc(name)}">${armed ? "Confirm delete" : "Delete"}</button></div>`;
  };
  const tagRow = name => {
    const count = state.items.filter(x => (x.tags || []).includes(name)).length;
    const armed = pendingDelete?.kind === "tag" && pendingDelete.name === name;
    if (orgEdit?.kind === "tag" && orgEdit.old === name) {
      return `<div class="org-row"><input id="orgEditInput" value="${esc(name)}" aria-label="Tag name"><button type="button" class="quiet" data-org-save-rename>Save</button><button type="button" class="quiet" data-org-cancel-rename>Cancel</button></div>`;
    }
    return `<div class="org-row"><span class="org-name">${icon("tag")} ${esc(name)}</span><small>${count} article${count === 1 ? "" : "s"}</small><button type="button" class="quiet" data-org-rename-tag="${esc(name)}">Rename</button><button type="button" class="quiet" data-org-delete-tag="${esc(name)}">${armed ? "Confirm delete" : "Delete"}</button></div>`;
  };
  const savedSearchRow = s => {
    const armed = pendingDelete?.kind === "savedSearch" && pendingDelete.id === s.id;
    if (orgEdit?.kind === "savedSearch" && orgEdit.old === s.id) {
      return `<div class="org-row"><input id="orgEditInput" value="${esc(s.name)}" aria-label="Saved search name"><button type="button" class="quiet" data-org-save-rename>Save</button><button type="button" class="quiet" data-org-cancel-rename>Cancel</button></div>`;
    }
    const desc = [s.query, s.tag ? "tag: " + s.tag : "", s.unreadOnly ? "unread only" : ""].filter(Boolean).join(" · ") || "All articles";
    return `<div class="org-row"><span class="org-name">${esc(s.name)}</span><small>${esc(desc)}</small><button type="button" class="quiet" data-org-rename-saved-search="${esc(s.id)}">Rename</button><button type="button" class="quiet" data-org-delete-saved-search="${esc(s.id)}">${armed ? "Confirm delete" : "Delete"}</button></div>`;
  };
  $("#organizeBody").innerHTML = `
    <div class="org-section"><h3>Folders</h3><p class="muted">Group your feeds. Deleting a folder keeps its feeds, ungrouped.</p>${state.folders.map(folderRow).join("") || '<p class="muted">No folders yet.</p>'}<div class="org-new"><input id="newFolder" placeholder="New folder name" aria-label="New folder name"><button type="button" class="primary" data-org-add-folder>Add</button></div></div>
    <div class="org-section"><h3>Feeds</h3><p class="muted">Move each feed into a folder, mute it, or unsubscribe from it.</p>${state.feeds.map(f => { const armed = pendingDelete?.kind === "feed" && pendingDelete.id === f.id; return `<div class="org-row"><span class="org-name">${esc(f.title)}</span><select data-org-move="${esc(f.id)}" aria-label="Folder for ${esc(f.title)}"><option value="">No folder</option>${state.folders.map(g => `<option value="${esc(g)}" ${f.group === g ? "selected" : ""}>${esc(g)}</option>`).join("")}</select><button type="button" class="quiet" data-org-mute="${esc(f.id)}">${f.muted ? "Unmute" : "Mute"}</button><button type="button" class="quiet" data-org-unsub="${esc(f.id)}">${armed ? "Confirm unsubscribe" : "Unsubscribe"}</button></div>`; }).join("") || '<p class="muted">No feeds yet.</p>'}</div>
    <div class="org-section"><h3>Tags</h3><p class="muted">Tags are applied to articles from the reader (press t). Renaming a tag updates every article that has it.</p>${state.tags.map(tagRow).join("") || '<p class="muted">No tags yet.</p>'}<div class="org-new"><input id="newTag" placeholder="New tag name" aria-label="New tag name"><button type="button" class="primary" data-org-add-tag>Add</button></div></div>
    <div class="org-section"><h3>Saved searches</h3><p class="muted">Named filters kept in the sidebar. Deleting one only removes the filter, not any articles.</p>${state.savedSearches.map(savedSearchRow).join("") || '<p class="muted">No saved searches yet.</p>'}</div>`;
}
function showOrganize() {
  orgEdit = null;
  renderOrganize();
  $("#organizeDialog").showModal();
}
function showFeed() {
  $("#feedError").textContent = "";
  $("#feedSearchInput").value = "";
  $("#feedSearchStatus").textContent = "Type an address to add it, or a name or topic to search.";
  $("#feedSearchResults").innerHTML = "";
  window.feedDiscoveryResults = [];
  $("#feedDialog").showModal();
  $("#feedSearchInput").focus();
}
/* Save a search (#108): the dialog is prefilled from the current state
   — the search box, the view (feed, folder, tag, or unread), and the
   tag — so the common case is just naming it. */
function showSaveSearch() {
  const scope = $("#saveSearchScope");
  const groups = [...new Set(state.feeds.map(f => f.group).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  scope.innerHTML = `<option value="all">All feeds</option>` +
    groups.map(g => `<option value="folder:${esc(g)}">Folder: ${esc(g)}</option>`).join("") +
    state.feeds.map(f => `<option value="feed:${esc(f.id)}">Feed: ${esc(f.title)}</option>`).join("");
  const tagSel = $("#saveSearchTag");
  tagSel.innerHTML = `<option value="">Any tag</option>` + state.tags.map(t => `<option value="${esc(t)}">${esc(t)}</option>`).join("");
  // The current view becomes the scope: a feed view scopes to that
  // feed, a folder view to that folder, a tag view to that tag, and
  // the Unread view turns on unread-only.
  let curScope = "all", curTag = "", curUnread = false;
  if (state.view === "feed" && state.feed) curScope = "feed:" + state.feed;
  else if (state.view === "folder" && state.folder) curScope = "folder:" + state.folder;
  else if (state.view === "tag" && state.tag) curTag = state.tag;
  else if (state.view === "unread") curUnread = true;
  else if (state.view === "savedSearch") {
    const s = state.savedSearches.find(v => v.id === state.savedSearch);
    if (s) { curScope = s.scope || "all"; curTag = s.tag || ""; curUnread = !!s.unreadOnly; }
  }
  scope.value = curScope;
  tagSel.value = curTag;
  $("#saveSearchUnread").checked = curUnread;
  $("#saveSearchQuery").value = state.query;
  $("#saveSearchName").value = "";
  $("#saveSearchDialog").showModal();
  $("#saveSearchName").focus();
}
function saveSearchFromDialog() {
  const name = $("#saveSearchName").value.trim();
  if (!name) { toast("Give the saved search a name."); return; }
  const s = {
    id: id(), name,
    query: $("#saveSearchQuery").value.trim(),
    scope: $("#saveSearchScope").value || "all",
    tag: $("#saveSearchTag").value || "",
    unreadOnly: $("#saveSearchUnread").checked
  };
  state.savedSearches.push(s);
  saveSavedSearches();
  $("#saveSearchDialog").close();
  render();
  goSavedSearch(s.id);
  toast(`Saved search “${name}”.`);
}
/* ---------- rules (#109) ---------- */
/* A rule in plain words, for the list: what it matches and what it does. */
function ruleDesc(r) {
  const scope = r.scope?.startsWith("feed:") ? "Feed: " + (state.feeds.find(f => f.id === r.scope.slice(5))?.title || "a feed")
    : r.scope?.startsWith("folder:") ? "Folder: " + r.scope.slice(7) : "All feeds";
  const cond = [r.keyword ? `title contains “${r.keyword}”` : "", r.author ? `author contains “${r.author}”` : ""].filter(Boolean).join(", ") || "any article";
  const act = [r.tag ? `tag “${r.tag}”` : "", r.save ? "save" : "", r.markRead ? "mark read" : ""].filter(Boolean).join(", ") || "nothing";
  return `${scope} · ${cond} → ${act}`;
}
function renderRules() {
  const editorHTML = cur => {
    const groups = [...new Set(state.feeds.map(f => f.group).filter(Boolean))].sort((a, b) => a.localeCompare(b));
    return `<div class="org-section"><label>Name<input id="ruleName" type="text" value="${esc(cur.name)}" placeholder="e.g. Save every Rethinking Hell post"></label><label>Look in<select id="ruleScope"><option value="all">All feeds</option>${groups.map(g => `<option value="folder:${esc(g)}" ${cur.scope === "folder:" + g ? "selected" : ""}>Folder: ${esc(g)}</option>`).join("")}${state.feeds.map(f => `<option value="feed:${esc(f.id)}" ${cur.scope === "feed:" + f.id ? "selected" : ""}>Feed: ${esc(f.title)}</option>`).join("")}</select></label><label>Title contains<input id="ruleKeyword" type="text" value="${esc(cur.keyword || "")}" placeholder="Optional"></label><label>Author contains<input id="ruleAuthor" type="text" value="${esc(cur.author || "")}" placeholder="Optional"></label><label>Add tag<input id="ruleTag" type="text" list="tagList" value="${esc(cur.tag || "")}" placeholder="Optional"></label><label class="setting">Save the article<input id="ruleSave" type="checkbox" ${cur.save ? "checked" : ""}></label><label class="setting">Mark the article read<input id="ruleMarkRead" type="checkbox" ${cur.markRead ? "checked" : ""}></label><div class="dialog-actions"><button type="button" class="quiet" data-rule-cancel>Cancel</button><button type="button" class="primary" data-rule-save>${ruleEdit === "new" ? "Add rule" : "Save rule"}</button></div></div>`;
  };
  const row = r => {
    const armed = pendingDelete?.kind === "rule" && pendingDelete.id === r.id;
    if (ruleEdit === r.id) return editorHTML(r);
    return `<div class="org-row"><span class="org-name">${esc(r.name)}</span><small>${esc(ruleDesc(r))}</small><button type="button" class="quiet" data-rule-toggle="${esc(r.id)}" aria-pressed="${r.enabled !== false}">${r.enabled !== false ? "On" : "Off"}</button><button type="button" class="quiet" data-rule-edit="${esc(r.id)}">Edit</button><button type="button" class="quiet" data-rule-delete="${esc(r.id)}">${armed ? "Confirm delete" : "Delete"}</button></div>`;
  };
  // The editor replaces the row being edited, or sits above the list
  // when adding a new rule; otherwise the list ends with an Add button.
  const body = state.rules.length ? state.rules.map(row).join("") : '<p class="muted">No rules yet. Rules tag, save, or mark read new articles as they arrive.</p>';
  $("#rulesBody").innerHTML = (ruleEdit === "new" ? editorHTML({ name: "", scope: "all", keyword: "", author: "", tag: "", save: false, markRead: false }) : "") + body + (ruleEdit ? "" : `<div class="org-new"><button type="button" class="primary" data-rule-add>Add a rule</button></div>`);
}
function showRules() {
  ruleEdit = null;
  pendingDelete = null;
  renderRules();
  $("#rulesDialog").showModal();
}
function saveRuleFromDialog() {
  const name = $("#ruleName")?.value.trim();
  if (!name) { toast("Give the rule a name."); return; }
  const data = {
    name,
    scope: $("#ruleScope")?.value || "all",
    keyword: $("#ruleKeyword")?.value.trim() || "",
    author: $("#ruleAuthor")?.value.trim() || "",
    tag: $("#ruleTag")?.value.trim() || "",
    save: $("#ruleSave")?.checked || false,
    markRead: $("#ruleMarkRead")?.checked || false
  };
  if (ruleEdit === "new") {
    state.rules.push({ id: id(), enabled: true, ...data });
    toast(`Rule “${name}” added. It runs on new articles at refresh.`);
  } else {
    const r = state.rules.find(v => v.id === ruleEdit);
    if (r) Object.assign(r, data);
    toast(`Rule “${name}” saved.`);
  }
  ruleEdit = null;
  saveRules();
  renderRules();
}
function deleteRule(id) {
  if (!pendingDelete || pendingDelete.kind !== "rule" || pendingDelete.id !== id) {
    pendingDelete = { kind: "rule", id };
    renderRules();
    toast("Click Delete again to remove the rule.");
    return;
  }
  pendingDelete = null;
  state.rules = state.rules.filter(v => v.id !== id);
  saveRules();
  renderRules();
  toast("Rule deleted.");
}
function download(data, name, type) {
  const u = URL.createObjectURL(new Blob([data], { type }));
  const a = document.createElement("a");
  a.href = u; a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(u), 1000);
}
const xml = s => String(s).replace(/[<>&'"]/g, c => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" }[c]));

/* ---------- OPML / settings import-export ---------- */
function exportOPML() {
  const groups = {};
  for (const f of state.feeds) (groups[f.group || ""] ||= []).push(f);
  const row = f => `<outline text="${xml(f.title)}" title="${xml(f.title)}" type="rss" xmlUrl="${xml(f.url)}" htmlUrl="${xml(f.site)}"/>`;
  const body = Object.keys(groups).sort((a, b) => (a === "" ? 1 : b === "" ? -1 : a.localeCompare(b))).map(g =>
    g ? `<outline text="${xml(g)}" title="${xml(g)}">${groups[g].map(row).join("")}</outline>` : groups[g].map(row).join("")
  ).join("");
  download(`<?xml version="1.0"?><opml version="2.0"><head><title>RSS Reader subscriptions</title></head><body>${body}</body></opml>`, "rss-reader-subscriptions.opml", "text/xml");
}
async function importOPML(file) {
  const d = new DOMParser().parseFromString(await file.text(), "text/xml");
  if (d.querySelector("parsererror") || d.documentElement.localName !== "opml") return toast("Invalid OPML file.");
  let added = 0, skipped = 0, failed = 0, done = 0;
  const jobs = [];
  const seenBatch = new Set();
  for (const o of d.querySelectorAll("outline[xmlUrl]")) {
    const rawUrl = o.getAttribute("xmlUrl");
    let url;
    try { url = normalizeFeedUrl(rawUrl); } catch { skipped++; continue; }
    if (state.feeds.some(f => sameFeedUrl(f.url, url)) || seenBatch.has(url)) { skipped++; continue; }
    seenBatch.add(url);
    const parent = o.parentElement;
    const group = parent && parent.localName === "outline" ? (parent.getAttribute("text") || parent.getAttribute("title") || "") : "";
    jobs.push(async () => {
      try {
        const loaded = await loadFeedFromUrl(url);
        const feed = {
          id: id(), url: loaded.url, title: loaded.parsed.title, site: loaded.parsed.site,
          added: new Date().toISOString(), error: "", via: loaded.via, wpRoot: loaded.wpRoot || "", group
        };
        state.feeds.push(feed);
        await saveItems(feed, loaded.parsed.items);
        added++;
      } catch (e) { failed++; }
      // Update the progress toast only every 5 feeds: rewriting it on
      // every completion makes it flicker through a large import.
      finally { done++; if (done % 5 === 0 || done === jobs.length) toast(`Importing feeds… ${done} of ${jobs.length}`); }
    });
  }
  // Cap concurrency so a large import does not fire all fetches at once.
  const pool = async (fns, n) => {
    let i = 0;
    await Promise.all(Array.from({ length: Math.min(n, fns.length) }, async () => {
      while (i < fns.length) { const fn = fns[i++]; await fn(); }
    }));
  };
  await pool(jobs, 3);
  saveFeeds();
  syncFolders();
  saveFolders();
  render();
  toast(`Imported ${added} feed${added === 1 ? "" : "s"}${skipped ? `, ${skipped} skipped (duplicate or invalid)` : ""}${failed ? `, ${failed} failed to load` : ""}.`);
}
function exportSettings() {
  download(JSON.stringify({ format: "rss-reader-settings", version: 1, settings: state.settings }, null, 2), "rss-reader-settings.json", "application/json");
}
async function importSettings(file) {
  try {
    const d = JSON.parse(await file.text());
    if (d.format !== "rss-reader-settings" || d.version !== 1 || !d.settings || typeof d.settings !== "object") throw Error("Unsupported settings file.");
    const next = validateSettings(d.settings);
    if (!Object.keys(next).length) throw Error("No valid settings found in this file.");
    state.settings = { ...state.settings, ...next };
    state.sort = state.settings.sort || "newest";
    state.filter = state.settings.filter || "all";
    local(S, state.settings);
    applySettings();
    mirrorSync();
    applyBackgroundSync();
    render();
    toast("Settings imported.");
  } catch (e) { toast(e.message); }
}
function showSettings() {
  $("#themeSelect").value = state.settings.theme;
  $("#widthSelect").value = state.settings.width;
  $("#sizeSelect").value = state.settings.size;
  $("#fontSelect").value = state.settings.readerFont || "serif";
  $("#lineHeightSelect").value = state.settings.lineHeight || "comfortable";
  $("#progressSelect").value = state.settings.progressPosition || "bottom";
  $("#cardExcerptSelect").value = state.settings.cardExcerpt || "full";
  $("#cardImageToggle").checked = state.settings.cardImage !== false;
  $("#hideDuplicatesToggle").checked = state.settings.hideDuplicates !== false;
  $("#backgroundSyncToggle").checked = !!state.settings.backgroundSync;
  $("#notifyNewToggle").checked = !!state.settings.notifyNew;
  $("#proxyToggle").checked = !!state.settings.proxyFallback;
  // App updates (#144): the running version, and the last check result
  // (an update waiting shows here as well as in the banner).
  const av = $("#appVersion");
  if (av) av.textContent = "v" + APP_VERSION;
  const st = $("#updateStatus");
  if (st) st.textContent = updateBannerShown ? "A new version is available. Reload to update." : "";
  $("#settingsDialog").showModal();
}
function showHelp() { $("#helpDialog").showModal(); }

/* ---------- keyboard shortcuts ---------- */
/* Industry-standard set (Google Reader / Inoreader / Feedly / NewsBlur):
   / search · j/k next/previous · n/p next/previous unread · o/Enter open ·
   v open original · m toggle read · s save · a mark visible read ·
   u back to list · g then a/u/s go to All/Unread/Saved · r refresh ·
   Space scroll reader · ? help · Esc close. */
function selectedItem() { return state.items.find(i => i.id === state.selected); }
function moveSelection(dir) {
  const a = visible();
  if (!a.length) return;
  const i = a.findIndex(x => x.id === state.selected);
  let n;
  if (i === -1) n = dir > 0 ? 0 : a.length - 1;
  else n = Math.min(a.length - 1, Math.max(0, i + dir));
  openItem(a[n].id);
}
function moveUnread(dir) {
  const a = visible().filter(x => !x.read);
  if (!a.length) { toast("No unread articles in this view."); return; }
  const i = a.findIndex(x => x.id === state.selected);
  let n;
  if (i === -1) n = dir > 0 ? 0 : a.length - 1;
  else n = Math.min(a.length - 1, Math.max(0, i + dir));
  openItem(a[n].id);
}
function goView(view) {
  stopTTS();
  state.view = view; state.feed = null; state.folder = null; state.tag = null; state.savedSearch = null; state.selected = null;
  $("#reader").classList.remove("open");
  render();
}
/* Open a folder as one merged list (#118): every feed in the folder,
   newest first, with the same mark-read controls as the other views. */
function goFolder(name) {
  stopTTS();
  state.view = "folder"; state.folder = name; state.feed = null; state.tag = null; state.savedSearch = null; state.selected = null;
  $("#reader").classList.remove("open");
  render();
}
/* Open a saved search (#108): the stored filter, run over the library. */
function goSavedSearch(id) {
  stopTTS();
  state.view = "savedSearch"; state.savedSearch = id; state.feed = null; state.folder = null; state.tag = null; state.selected = null;
  $("#reader").classList.remove("open");
  render();
}
async function markVisibleRead() {
  const targets = visible().filter(x => !x.read);
  if (!targets.length) { toast("Visible articles are already read."); return; }
  for (const x of targets) x.read = true;
  await putMany(targets);
  render();
  toast(`Marked ${targets.length} article${targets.length === 1 ? "" : "s"} read.`, { label: "Undo", fn: async () => {
    for (const x of targets) x.read = false;
    await putMany(targets);
    render();
  } });
}

/* Mark one feed read (#93): the unread count next to a feed is a
   button that clears that feed, with the same Undo as Mark visible read. */
async function markFeedRead(feedId) {
  const feed = state.feeds.find(f => f.id === feedId);
  const targets = state.items.filter(x => x.feedId === feedId && !x.read);
  if (!targets.length) { toast("That feed is already read."); return; }
  for (const x of targets) x.read = true;
  await putMany(targets);
  render();
  toast(`Marked ${targets.length} article${targets.length === 1 ? "" : "s"} in “${feed?.title || "feed"}” read.`, { label: "Undo", fn: async () => {
    for (const x of targets) x.read = false;
    await putMany(targets);
    render();
  } });
}

/* Mute a feed (#117): hide its articles from All and Unread without
   unsubscribing. The feed stays in the sidebar (greyed, with its
   count) and its articles are still there in its own view; saved
   articles stay in Saved. */
function toggleMute(feedId) {
  const f = state.feeds.find(f => f.id === feedId);
  if (!f) return;
  f.muted = !f.muted;
  saveFeeds();
  render();
  renderOrganize();
  toast(f.muted ? `Muted “${f.title}”. Its articles are hidden from All and Unread.` : `Unmuted “${f.title}”.`);
}

/* Mark above / below (#106): everything before or after the selected
   article in the list as it currently stands (view, filter, search,
   sort), with the same Undo as the other bulk mark-read actions. Only
   the visible list is acted on, never the whole library. */
async function markAboveBelow(which) {
  const a = visible();
  const i = a.findIndex(x => x.id === state.selected);
  if (i === -1) { toast("Select an article first."); return; }
  const targets = (which === "above" ? a.slice(0, i) : a.slice(i + 1)).filter(x => !x.read);
  if (!targets.length) { toast(which === "above" ? "Nothing above this article is unread." : "Nothing below this article is unread."); return; }
  for (const x of targets) x.read = true;
  await putMany(targets);
  render();
  toast(`Marked ${targets.length} article${targets.length === 1 ? "" : "s"} ${which} read.`, { label: "Undo", fn: async () => {
    for (const x of targets) x.read = false;
    await putMany(targets);
    render();
  } });
}

function bind() {
  document.addEventListener("click", async e => {
    // The snooze menu closes on any click outside it or its button.
    // Remember whether it was open first: the snooze button toggles
    // from that pre-click state, so it can still close the menu.
    const snoozeMenu = $("#snoozeMenu");
    const snoozeMenuWasOpen = !!(snoozeMenu && !snoozeMenu.hidden);
    if (snoozeMenuWasOpen && !e.target.closest("#snoozeMenu") && !e.target.closest('[data-reader="snooze"]')) snoozeMenu.hidden = true;
    // The mark-read menu (#146) closes on any click outside it or its button.
    const markMenu = $("#markReadMenu");
    if (markMenu && !markMenu.hidden && !e.target.closest("#markReadMenu") && !e.target.closest("#markReadMenuBtn")) {
      markMenu.hidden = true;
      $("#markReadMenuBtn")?.setAttribute("aria-expanded", "false");
    }
    const scrim = e.target.closest("#scrim");
    if (scrim) { $("#sidebar").classList.remove("open"); scrim.classList.remove("show"); return; }
    const nav = e.target.closest("[data-view]");
    if (nav) { goView(nav.dataset.view); $("#sidebar").classList.remove("open"); $("#scrim").classList.remove("show"); return; }
    const tagBtn = e.target.closest("[data-tag]");
    if (tagBtn) { goTag(tagBtn.dataset.tag); $("#sidebar").classList.remove("open"); $("#scrim").classList.remove("show"); return; }
    const ssBtn = e.target.closest("[data-saved-search]");
    if (ssBtn) { goSavedSearch(ssBtn.dataset.savedSearch); $("#sidebar").classList.remove("open"); $("#scrim").classList.remove("show"); return; }
    const folderRename = e.target.closest("[data-folder-rename]");
    if (folderRename) { orgEdit = { kind: "folder", old: folderRename.dataset.folderRename }; showOrganize(); return; }
    const folderDelete = e.target.closest("[data-folder-delete]");
    if (folderDelete) { pendingDelete = { kind: "folder", name: folderDelete.dataset.folderDelete }; showOrganize(); return; }
    const unsub = e.target.closest("[data-unsub]");
    if (unsub) { requestUnsubscribe(unsub.dataset.unsub); return; }
    const markReadBtn = e.target.closest("[data-mark-read]");
    if (markReadBtn) { markFeedRead(markReadBtn.dataset.markRead); return; }
    const muteBtn = e.target.closest("[data-mute]");
    if (muteBtn) { toggleMute(muteBtn.dataset.mute); return; }
    const folderBtn = e.target.closest("[data-folder]");
    if (folderBtn) { goFolder(folderBtn.dataset.folder); $("#sidebar").classList.remove("open"); $("#scrim").classList.remove("show"); return; }
    const feed = e.target.closest("[data-feed]");
    if (feed) {
      state.view = "feed"; state.feed = feed.dataset.feed; state.folder = null; state.tag = null; state.savedSearch = null; state.selected = null;
      render();
      $("#sidebar").classList.remove("open");
      $("#scrim").classList.remove("show");
      return;
    }
    const act = e.target.closest("[data-action]");
    if (act) {
      if (act.dataset.action === "hl-delete") { await deleteHighlight(act.dataset.id); return; }
      const x = state.items.find(i => i.id === act.dataset.id);
      if (x) {
        if (act.dataset.action === "share") { shareArticle(x); return; }
        if (act.dataset.action === "unsnooze") { await unsnoozeItem(x); return; }
        const key = act.dataset.action === "save" ? "saved" : "read";
        x[key] = !x[key];
        await put(x);
        render();
        // renderReader, not openItem: opening would mark an item read
        // again right after the user marked it unread.
        if (state.selected === x.id) renderReader(x);
      }
      return;
    }
    // A highlight row in the Highlights view (#116): open its article
    // and scroll to the passage.
    const hlRow = e.target.closest("[data-hl-open]");
    if (hlRow) { openHighlight(hlRow.dataset.hlOpen); return; }
    const hlNote = e.target.closest("[data-hl-note]");
    if (hlNote) { showHlNoteDialog(hlNote.dataset.hlNote); return; }
    const hlGoto = e.target.closest("[data-hl-goto]");
    if (hlGoto) { scrollToHighlight(hlGoto.dataset.hlGoto); return; }
    const hlDel = e.target.closest("[data-hl-delete]");
    if (hlDel) { await deleteHighlight(hlDel.dataset.hlDelete); return; }
    const tagRemove = e.target.closest("[data-tag-remove]");
    if (tagRemove && state.selected) {
      const x = selectedItem();
      if (x) removeTagFromItem(x, tagRemove.dataset.tagRemove);
      return;
    }
    const snz = e.target.closest("[data-snooze]");
    if (snz && state.selected) {
      const x = selectedItem();
      if (x) {
        if (snz.dataset.snooze === "clear") await unsnoozeItem(x);
        else await snoozeItem(x, snz.dataset.snooze);
      }
      const m = $("#snoozeMenu"); if (m) m.hidden = true;
      return;
    }
    const ttsBtn = e.target.closest("[data-tts]");
    if (ttsBtn) {
      if (ttsBtn.dataset.tts === "pause") { if (tts?.paused) resumeTTS(); else pauseTTS(); }
      if (ttsBtn.dataset.tts === "stop") stopTTS();
      return;
    }
    const ra = e.target.closest("[data-reader]");
    if (ra && state.selected) {
      const x = selectedItem();
      if (!x) return;
      if (ra.dataset.reader === "save") { x.saved = !x.saved; await put(x); openItem(x.id); return; }
      if (ra.dataset.reader === "read") { x.read = !x.read; await put(x); renderNav(); renderList(); renderReader(x); toast(x.read ? "Article marked read." : "Article marked unread."); return; }
      if (ra.dataset.reader === "listen") { if (tts?.itemId === x.id) stopTTS(); else startTTS(x); return; }
      if (ra.dataset.reader === "share") { shareArticle(x); return; }
      if (ra.dataset.reader === "snooze") { const m = $("#snoozeMenu"); if (m) { m.hidden = snoozeMenuWasOpen; ra.setAttribute("aria-expanded", String(!m.hidden)); } return; }
      if (ra.dataset.reader === "open") { window.open(x.url, "_blank", "noopener"); return; }
      if (ra.dataset.reader === "fulltext") { loadFullText(x); return; }
      if (ra.dataset.reader === "close") { closeReader(); return; }
    }
    const row = e.target.closest("[data-item]");
    if (row) { openItem(row.dataset.item); return; }
  });
  document.addEventListener("keydown", e => {
    const row = e.target.closest?.("[data-item]");
    // Only when the row itself is focused: an inner button (read/save)
    // must keep its own Enter/Space behavior.
    if (row && e.target === row && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); openItem(row.dataset.item); }
    if (e.target.id === "tagInput" && e.key === "Enter") {
      e.preventDefault();
      const x = selectedItem();
      if (x) addTagToItem(x, e.target.value);
    }
  });
  $("#home").onclick = () => { goView("all"); };
  $("#add").onclick = $("#mobileAdd").onclick = $("#firstAdd").onclick = showFeed;
  $("#feedSearchInput").addEventListener("input", scheduleFeedSearch);
  // Enter in the single box submits the form, which runs the unified
  // add logic (#157): direct add for an address, directory search
  // for words. No separate key handler.
  $("#feedSearchResults").addEventListener("click", e => {
    const f = e.target.closest("[data-discovery-filter]");
    if (f && !f.disabled) {
      discoveryFilter = f.dataset.discoveryFilter;
      renderDiscoveryResults(window.feedDiscoveryResults || []);
      return;
    }
    const b = e.target.closest("[data-discovery-add]");
    if (b) addDiscoveredFeed(Number(b.dataset.discoveryAdd));
  });
  // Folders & tags lives in Settings now: close Settings, then open the
  // manage dialog on its own.
  $("#organize").onclick = () => { $("#settingsDialog").close(); showOrganize(); };
  // Rules likewise: close Settings, then open the rules dialog.
  $("#manageRules").onclick = () => { $("#settingsDialog").close(); showRules(); };
  $("#rulesDialog").addEventListener("click", e => {
    const add = e.target.closest("[data-rule-add]");
    if (add) { ruleEdit = "new"; renderRules(); $("#ruleName")?.focus(); return; }
    const edit = e.target.closest("[data-rule-edit]");
    if (edit) { ruleEdit = edit.dataset.ruleEdit; renderRules(); $("#ruleName")?.focus(); return; }
    const save = e.target.closest("[data-rule-save]");
    if (save) { saveRuleFromDialog(); return; }
    const cancel = e.target.closest("[data-rule-cancel]");
    if (cancel) { ruleEdit = null; renderRules(); return; }
    const toggle = e.target.closest("[data-rule-toggle]");
    if (toggle) {
      const r = state.rules.find(v => v.id === toggle.dataset.ruleToggle);
      if (r) { r.enabled = r.enabled === false; saveRules(); renderRules(); toast(r.enabled !== false ? `Rule “${r.name}” on.` : `Rule “${r.name}” off.`); }
      return;
    }
    const del = e.target.closest("[data-rule-delete]");
    if (del) { deleteRule(del.dataset.ruleDelete); return; }
    if (e.target.closest("#rulesDone") || e.target.closest("#rulesClose")) $("#rulesDialog").close();
  });
  $("#organizeDialog").addEventListener("close", () => { pendingDelete = null; orgEdit = null; });
  $("#organizeDialog").addEventListener("click", async e => {
    const addFolder = e.target.closest("[data-org-add-folder]");
    if (addFolder) { createFolder($("#newFolder")?.value); return; }
    const addTag = e.target.closest("[data-org-add-tag]");
    if (addTag) { createTag($("#newTag")?.value); return; }
    const renameFolderBtn = e.target.closest("[data-org-rename-folder]");
    if (renameFolderBtn) { orgEdit = { kind: "folder", old: renameFolderBtn.dataset.orgRenameFolder }; renderOrganize(); $("#orgEditInput")?.focus(); return; }
    const renameTagBtn = e.target.closest("[data-org-rename-tag]");
    if (renameTagBtn) { orgEdit = { kind: "tag", old: renameTagBtn.dataset.orgRenameTag }; renderOrganize(); $("#orgEditInput")?.focus(); return; }
    const renameSsBtn = e.target.closest("[data-org-rename-saved-search]");
    if (renameSsBtn) { orgEdit = { kind: "savedSearch", old: renameSsBtn.dataset.orgRenameSavedSearch }; renderOrganize(); $("#orgEditInput")?.focus(); return; }
    const saveRename = e.target.closest("[data-org-save-rename]");
    if (saveRename) { await doRename($("#orgEditInput")?.value); return; }
    const cancelRename = e.target.closest("[data-org-cancel-rename]");
    if (cancelRename) { orgEdit = null; renderOrganize(); return; }
    const delFolder = e.target.closest("[data-org-delete-folder]");
    if (delFolder) { deleteFolder(delFolder.dataset.orgDeleteFolder); return; }
    const delTag = e.target.closest("[data-org-delete-tag]");
    if (delTag) { await deleteTag(delTag.dataset.orgDeleteTag); return; }
    const delSs = e.target.closest("[data-org-delete-saved-search]");
    if (delSs) { deleteSavedSearch(delSs.dataset.orgDeleteSavedSearch); return; }
    const orgUnsub = e.target.closest("[data-org-unsub]");
    if (orgUnsub) { await requestUnsubscribe(orgUnsub.dataset.orgUnsub); return; }
    const orgMute = e.target.closest("[data-org-mute]");
    if (orgMute) { toggleMute(orgMute.dataset.orgMute); return; }
    if (e.target.closest("#organizeDone") || e.target.closest("#organizeClose")) $("#organizeDialog").close();
  });
  $("#organizeDialog").addEventListener("change", e => {
    const sel = e.target.closest("[data-org-move]");
    if (sel) moveFeed(sel.dataset.orgMove, sel.value);
  });
  $("#organizeDialog").addEventListener("keydown", e => {
    if (e.key !== "Enter") return;
    if (e.target.id === "newFolder") { e.preventDefault(); createFolder(e.target.value); }
    else if (e.target.id === "newTag") { e.preventDefault(); createTag(e.target.value); }
    else if (e.target.id === "orgEditInput") { e.preventDefault(); doRename(e.target.value); }
  });
  $("#refresh").onclick = refresh;
  bindSplitters();
  $("#reader").addEventListener("scroll", updateReadProgress, { passive: true });
  // Highlights (#116): the button follows the selection in the article
  // body, and hides when the reader scrolls (its position is by
  // viewport, so a scroll would leave it in the wrong place).
  $("#reader").addEventListener("mouseup", () => setTimeout(updateHlBtn, 0));
  $("#reader").addEventListener("scroll", () => { const b = $("#hlBtn"); if (b) b.hidden = true; }, { passive: true });
  document.addEventListener("selectionchange", () => { if (state.selected) updateHlBtn(); });
  $("#hlBtn").onclick = showHlDialog;
  $("#hlForm").onsubmit = e => { e.preventDefault(); saveHlFromDialog(); };
  $("#hlDialog").addEventListener("click", e => {
    if (e.target.closest('button[value="cancel"]')) $("#hlDialog").close();
  });
  // The listening speed applies from the next spoken chunk and is
  // remembered with the other settings.
  document.addEventListener("change", e => {
    if (e.target.id === "ttsSpeed") {
      state.settings.ttsRate = Number(e.target.value) || 1;
      local(S, state.settings);
    }
  });
  window.addEventListener("resize", updateReadProgress);
  $("#settings").onclick = showSettings;
  $("#theme").onclick = () => {
    state.settings.theme = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
    local(S, state.settings);
    applySettings();
  };
  // Full-text search (#107) scans stored article bodies, so the list
  // re-render is debounced while typing instead of running per keystroke.
  $("#search").oninput = e => { state.query = e.target.value.toLowerCase(); $("#searchClear").hidden = !e.target.value; clearTimeout(searchTimer); searchTimer = setTimeout(renderList, 150); };
  $("#searchClear").onclick = () => { $("#search").value = ""; state.query = ""; $("#searchClear").hidden = true; renderList(); $("#search").focus(); };
  $("#sort").onclick = () => {
    state.sort = state.sort === "newest" ? "oldest" : "newest";
    state.settings.sort = state.sort;
    local(S, state.settings);
    $("#sort").textContent = state.sort === "newest" ? "Newest first ↓" : "Oldest first ↑";
    renderList();
  };
  $$(".filter").forEach(b => b.onclick = () => {
    $$(".filter").forEach(x => x.classList.toggle("active", x === b));
    state.filter = b.dataset.filter;
    state.settings.filter = state.filter;
    local(S, state.settings);
    renderList();
  });
  $("#markRead").onclick = markVisibleRead;
  $("#markAbove").onclick = () => markAboveBelow("above");
  $("#markBelow").onclick = () => markAboveBelow("below");
  // Mark read dropdown (#146): one button holds the three actions.
  // The menu closes after an action, on an outside click, or on Esc.
  const markMenu = $("#markReadMenu"), markBtn = $("#markReadMenuBtn");
  const closeMarkMenu = () => {
    if (markMenu) markMenu.hidden = true;
    if (markBtn) markBtn.setAttribute("aria-expanded", "false");
  };
  if (markBtn && markMenu) {
    markBtn.onclick = e => {
      e.stopPropagation();
      const open = markMenu.hidden;
      markMenu.hidden = !open;
      markBtn.setAttribute("aria-expanded", String(open));
    };
    markMenu.addEventListener("click", e => { if (e.target.closest("button")) closeMarkMenu(); });
    document.addEventListener("keydown", e => { if (e.key === "Escape") closeMarkMenu(); });
  }
  $("#saveSearchBtn").onclick = showSaveSearch;
  $("#saveSearchDialog").addEventListener("click", e => {
    if (e.target.closest('button[value="cancel"]')) $("#saveSearchDialog").close();
  });
  // The form's submit covers both the Save button and Enter in a field,
  // so a missing name keeps the dialog open instead of closing it.
  $("#saveSearchForm").onsubmit = e => {
    e.preventDefault();
    saveSearchFromDialog();
  };
  $("#importOpml").onclick = () => $("#opmlFile").click();
  $("#exportOpml").onclick = exportOPML;
  $("#opmlFile").onchange = e => { if (e.target.files[0]) importOPML(e.target.files[0]); e.target.value = ""; };
  // The X and Cancel buttons are type="button" (not submit), so the
  // Add feed button is the form's only submit button and therefore
  // the one Enter submits with. They close the dialog explicitly
  // instead of relying on method="dialog".
  $("#feedDialog").addEventListener("click", e => {
    if (e.target.closest('button[value="cancel"]')) $("#feedDialog").close();
  });
  // Unified add (#157): one box. An address is added directly
  // (loadFeedFromUrl probes /feed, /rss, … and WordPress for a bare
  // site); words run a directory search instead.
  $("#feedForm").onsubmit = async e => {
    if (e.submitter?.value === "cancel") return;
    e.preventDefault();
    clearTimeout(discoveryTimer);
    if (discoveryController) discoveryController.abort();
    const q = $("#feedSearchInput").value.trim();
    if (!q) { $("#feedSearchStatus").textContent = "Type a feed or website address, or a name or topic to search."; return; }
    if (!looksLikeAddress(q)) { searchFeeds(q); return; }
    const b = $("#saveFeed");
    b.disabled = true;
    try {
      await addFeed(q);
      $("#feedDialog").close();
    } catch (err) {
      $("#feedError").textContent = classifyError(err, /^http:/i.test(q));
      // Direct add failed: fall back to directory search, which can
      // surface the site's feeds even when a direct fetch cannot.
      // An already-subscribed feed needs no search.
      if (!/already subscribe/i.test(err.message || "")) searchFeeds(q);
    } finally { b.disabled = false; }
  };
  $("#saveSettings").onclick = () => {
    state.settings = {
      theme: $("#themeSelect").value, width: $("#widthSelect").value, size: $("#sizeSelect").value,
      readerFont: $("#fontSelect").value, lineHeight: $("#lineHeightSelect").value,
      ttsRate: state.settings.ttsRate || 1,
      hideDuplicates: $("#hideDuplicatesToggle").checked,
      proxyFallback: $("#proxyToggle").checked, progressPosition: $("#progressSelect").value,
      cardExcerpt: $("#cardExcerptSelect").value, cardImage: $("#cardImageToggle").checked,
      backgroundSync: $("#backgroundSyncToggle").checked, notifyNew: $("#notifyNewToggle").checked,
      sidebarCollapsed: state.settings.sidebarCollapsed || false,
      sidebarWidth: state.settings.sidebarWidth, listWidth: state.settings.listWidth,
      // Sort and filter are set elsewhere (the sort button, the filter
      // pills) and must survive a settings save, or a trip through
      // Settings silently resets them.
      sort: state.settings.sort || "newest",
      filter: state.settings.filter || "all"
    };
    local(S, state.settings);
    applySettings();
    mirrorSync();
    applyBackgroundSync();
    // Card options apply to the list; the progress bar's place is set
    // when an article opens, so re-render both at once.
    renderList();
    // The progress bar's place in the reader is set when an article opens;
    // re-render the open article so a changed position applies at once,
    // keeping the reader's scroll position (renderReader resets it).
    if (state.selected) {
      const x = selectedItem();
      if (x) {
        const sc = $("#reader").scrollTop;
        renderReader(x);
        $("#reader").scrollTop = sc;
        updateReadProgress();
      }
    }
  };
  $("#exportSettings").onclick = exportSettings;
  $("#importSettings").onclick = () => $("#settingsFile").click();
  $("#checkUpdates").onclick = checkForUpdates;
  $("#settingsFile").onchange = e => { if (e.target.files[0]) importSettings(e.target.files[0]); e.target.value = ""; };
  $("#menu").onclick = () => {
    const open = $("#sidebar").classList.toggle("open");
    $("#scrim").classList.toggle("show", open);
  };
  $("#sideToggle").onclick = () => {
    state.settings.sidebarCollapsed = !state.settings.sidebarCollapsed;
    local(S, state.settings);
    applySidebarCollapsed();
  };
  window.addEventListener("popstate", () => {
    stopTTS();
    if ($("#reader").classList.contains("open") || state.selected) {
      $("#reader").classList.remove("open");
      state.selected = null;
      render();
    }
  });
  // Follow the OS theme live when the user chose "System".
  matchMedia("(prefers-color-scheme: light)").addEventListener("change", () => {
    if (state.settings.theme === "system") applySettings();
  });
  document.onkeydown = e => {
    const tag = document.activeElement?.tagName;
    if (["INPUT", "SELECT", "TEXTAREA"].includes(tag) || $("dialog[open]")) return;
    // Ctrl+M marks above read, Shift+M marks below (Inoreader's
    // bindings). Checked before the modifier early-return below.
    // The key is compared case-insensitively: some keyboards and
    // automation send Shift+M as key "m" with shiftKey set.
    if (e.ctrlKey && !e.metaKey && !e.altKey && e.key.toLowerCase() === "m") { e.preventDefault(); markAboveBelow("above"); return; }
    if (e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey && e.key.toLowerCase() === "m") { e.preventDefault(); markAboveBelow("below"); return; }
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === "Escape") {
      $("#sidebar").classList.remove("open");
      $("#scrim").classList.remove("show");
      closeReader();
      return;
    }
    if (e.key === "/") { e.preventDefault(); $("#search").focus(); return; }
    if (e.key === "?") { e.preventDefault(); showHelp(); return; }
    // A focused button keeps its normal Space/Enter behavior; the
    // shortcuts below must not hijack it (or double-activate it).
    if (tag === "BUTTON") return;
    if (pendingG) {
      // Clear the old timeout first: without this, pressing "gg" leaves
      // the first timeout armed, and it clears the new pending state
      // early.
      clearTimeout(pendingG);
      pendingG = null;
      if (e.key === "a") goView("all");
      else if (e.key === "u") goView("unread");
      else if (e.key === "s") goView("saved");
      else if (e.key === "g") pendingG = setTimeout(() => { pendingG = null; }, 1200);
      return;
    }
    if (e.key === "g") { pendingG = setTimeout(() => { pendingG = null; }, 1200); return; }
    if (e.key === " ") {
      const reader = $("#reader");
      if (reader.classList.contains("open")) {
        e.preventDefault();
        reader.scrollBy({ top: (e.shiftKey ? -1 : 1) * reader.clientHeight * 0.9 });
      }
      return;
    }
    if (e.repeat && ["r", "s", "a", "m"].includes(e.key)) return;
    if (e.key === "r") { refresh(); return; }
    if (e.key === "j") { moveSelection(1); return; }
    if (e.key === "k") { moveSelection(-1); return; }
    if (e.key === "n") { moveUnread(1); return; }
    if (e.key === "p") { moveUnread(-1); return; }
    if (e.key === "o" || e.key === "Enter") {
      const a = visible();
      if (state.selected) openItem(state.selected);
      else if (a.length) openItem(a[0].id);
      return;
    }
    if (e.key === "u") { closeReader(); return; }
    if (e.key === "a") { markVisibleRead(); return; }
    const sel = selectedItem();
    if (e.key === "v" && sel) { window.open(sel.url, "_blank", "noopener"); return; }
    if (e.key === "m" && sel) {
      sel.read = !sel.read;
      put(sel);
      render();
      renderReader(sel);
      return;
    }
    if (e.key === "s" && sel) { sel.saved = !sel.saved; put(sel); render(); openItem(sel.id); return; }
    if (e.key === "t" && sel) {
      e.preventDefault(); // otherwise the "t" is typed into the input
      const inp = $("#tagInput");
      if (inp) { inp.focus(); inp.select(); }
      return;
    }
  };
}

/* ---------- app updates (#144) ----------
   The service worker is the update mechanism: a new build ships a new
   sw.js, the worker installs it and waits, and the page offers the
   reload. The worker never activates on its own, so an update never
   interrupts reading. Checks run on launch, every 30 minutes, and
   whenever the tab becomes visible again, plus on demand from Settings. */
let swReg = null, updateBannerShown = false, updateReloadPending = false;
function showUpdateBanner() {
  if (updateBannerShown) return;
  updateBannerShown = true;
  const b = $("#updateBanner");
  if (b) b.hidden = false;
  const st = $("#updateStatus");
  if (st) st.textContent = "A new version is available. Reload to update.";
}
function hideUpdateBanner() {
  updateBannerShown = false;
  const b = $("#updateBanner");
  if (b) b.hidden = true;
}
async function checkForUpdates() {
  const st = $("#updateStatus");
  if (st) st.textContent = "Checking for updates…";
  if (!swReg) {
    if (st) st.textContent = "Updates are not available in this browser.";
    return;
  }
  try { await swReg.update(); } catch {
    if (st) st.textContent = "Could not check for updates. Try again later.";
    return;
  }
  // update() resolves when the check finishes, but a new worker may
  // still be installing, so the updatefound handler reports the result
  // when it lands. If nothing is waiting after a short pause, the app
  // is current.
  setTimeout(() => {
    if (swReg.waiting) {
      showUpdateBanner();
      if (st) st.textContent = "A new version is available. Reload to update.";
    } else if (st && !updateBannerShown) {
      st.textContent = `You're up to date (v${APP_VERSION}).`;
    }
  }, 1500);
}
function initServiceWorker() {
  navigator.serviceWorker.register("./sw.js", { updateViaCache: "none" })
    .then(reg => {
      swReg = reg;
      // A worker that finishes installing while this page is open
      // means a new build is waiting.
      reg.addEventListener("updatefound", () => {
        const w = reg.installing;
        if (!w) return;
        w.addEventListener("statechange", () => {
          if (w.state === "installed" && navigator.serviceWorker.controller) showUpdateBanner();
        });
      });
      // A worker may already be waiting (installed while the page
      // was closed); offer the update now.
      if (reg.waiting && navigator.serviceWorker.controller) showUpdateBanner();
      reg.update().catch(() => {});
      setInterval(() => reg.update().catch(() => {}), 30 * 60 * 1000);
      document.addEventListener("visibilitychange", () => {
        if (!document.hidden) reg.update().catch(() => {});
      });
    })
    .catch(() => {});
  // The waiting worker takes over only when the user chooses Reload,
  // so a reload here always lands on the new build.
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (updateReloadPending) { updateReloadPending = false; location.reload(); }
  });
  const reloadBtn = $("#updateReload");
  if (reloadBtn) reloadBtn.onclick = () => {
    updateReloadPending = true;
    if (swReg?.waiting) swReg.waiting.postMessage({ type: "SKIP_WAITING" });
    // Fallback: if the worker does not take over promptly, reload
    // anyway rather than leaving the user stuck on the banner.
    setTimeout(() => { if (updateReloadPending) location.reload(); }, 5000);
  };
  const dismissBtn = $("#updateDismiss");
  if (dismissBtn) dismissBtn.onclick = hideUpdateBanner;
}

async function init() {
  loadLocal();
  // Open storage with one retry: a transient failure must not leave a
  // dead page. If it still fails, show the shell with a retry instead.
  let opened = false;
  for (let attempt = 0; attempt < 2 && !opened; attempt++) {
    try { db = await openDB(); opened = true; }
    catch (e) { if (attempt === 0) await new Promise(r => setTimeout(r, 600)); }
  }
  bind();
  applySettings();
  if (opened) {
    try {
      state.items = await dbAll();
      state.highlights = await hlAll();
      syncTags();
      saveTags();
      mirrorSync();
    } catch (e) {
      console.error(e);
      toast("Could not load your articles.");
    }
  }
  render();
  if (!opened) {
    toast("Could not open browser storage. Your articles are unavailable.", { label: "Retry", fn: () => location.reload() });
  } else {
    if (state.feedsRestored) toast("Your subscriptions were restored from a backup copy.");
    // Refresh on launch when the newest cached article is stale, so
    // the list is never silently days old.
    if (state.feeds.length) {
      const newest = state.items.reduce((m, x) => Math.max(m, dateSortKey(x) ?? 0), 0);
      if (!state.items.length || Date.now() - newest > 30 * 60 * 1000) refresh();
    }
  }
  if ("serviceWorker" in navigator && location.protocol.startsWith("http")) {
    initServiceWorker();
  }
  // Re-register the periodic sync if it was on: a browser restart or
  // a service worker update can drop the registration.
  if (state.settings.backgroundSync) applyBackgroundSync(true);
}
init();
})();
