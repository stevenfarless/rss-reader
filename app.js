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
const KF = "rss-reader.folders.v1", KT = "rss-reader.tags.v1";
const PROXY_API = "https://api.rss2json.com/v1/api.json?rss_url=";
const ALLORIGINS = "https://api.allorigins.win/raw?url=";
const JINA = "https://r.jina.ai/";
const FETCH_TIMEOUT_MS = 15000;
const PROXY_TIMEOUT_MS = 30000;
const MAX_ITEMS_PER_FEED = 200;

const state = {
  feeds: [], items: [], view: "all", feed: null, filter: "all",
  sort: "newest", query: "", selected: null, tag: null,
  folders: [], tags: [],
  settings: { theme: "dark", width: "comfortable", size: "normal", proxyFallback: false, sidebarCollapsed: false }
};
let db, timer, pendingG = null, refreshAt = 0, orgEdit = null, pendingDelete = null;

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
/* Shorten text for list cards: cut at a word boundary and add an
   ellipsis, instead of slicing mid-word. */
const snippet = (s, n) => {
  s = (s || "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
  if (s.length <= n) return s;
  const cut = s.slice(0, n).replace(/\s+\S*$/, "");
  return (cut || s.slice(0, n)) + "…";
};
/* Byline timestamp without seconds ("11/16/2026 · 11:00 AM"). */
const fmtDateTime = d => d.toLocaleDateString() + " · " + d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
/* Strip publisher boilerplate out of summaries before they reach the
   list. Hacker News descriptions are "Article URL: … Comments URL: …
   Points: N # Comments: M"; some feeds (e.g. NASA APOD via WordPress)
   ship site navigation in the summary, which is cut at the first nav
   marker with the leading header tokens dropped. */
const NAV_MARKERS = ["Today's APOD", "Archive Submissions", "Previous APOD"];
const cleanSummary = s => {
  // Curly apostrophes/quotes (e.g. "Today’s APOD" from a decoded
  // excerpt) must be normalized before the marker match below.
  s = (s || "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").replace(/[\u2018\u2019]/g, "'").replace(/[\u201C\u201D]/g, '"').trim();
  const hn = s.match(/Article URL:.*?Points:\s*(\d+)\s*# Comments:\s*(\d+)/i);
  if (hn) return `${hn[1]} points · ${hn[2]} comments`;
  const cutAt = NAV_MARKERS.map(m => s.indexOf(m)).filter(i => i > 0);
  if (cutAt.length) {
    s = s.slice(0, Math.min(...cutAt)).trim();
    s = s.replace(/^(?:(?:APOD|Science)\b[\s·:–-]*)+/i, "").replace(/^APOD:\s*/i, "").trim();
  }
  return s;
};
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

function toast(s) {
  const e = $("#toast");
  e.textContent = s;
  e.classList.add("show");
  clearTimeout(timer);
  // Long messages stay up longer so they can actually be read.
  timer = setTimeout(() => e.classList.remove("show"), Math.min(9000, 3200 + Math.max(0, s.length - 60) * 30));
}
function local(k, v) {
  try { localStorage.setItem(k, JSON.stringify(v)); }
  catch (e) { toast("Browser storage is full."); }
}
function loadLocal() {
  try { state.feeds = JSON.parse(localStorage.getItem(K) || "[]"); } catch {}
  try { state.settings = { ...state.settings, ...JSON.parse(localStorage.getItem(S) || "{}") }; } catch {}
  try { state.folders = JSON.parse(localStorage.getItem(KF) || "[]"); } catch {}
  try { state.tags = JSON.parse(localStorage.getItem(KT) || "[]"); } catch {}
  syncFolders();
}
function saveFeeds() { local(K, state.feeds); }
function saveFolders() { local(KF, state.folders); }
function saveTags() { local(KT, state.tags); }
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
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => {
      const d = r.result;
      if (!d.objectStoreNames.contains("items")) d.createObjectStore("items", { keyPath: "id" });
    };
    r.onsuccess = () => {
      r.result.onclose = () => { db = null; };
      res(r.result);
    };
    r.onerror = () => rej(r.error);
  });
}
function runTx(mode, op) {
  return new Promise((resolve, reject) => {
    let retries = 0;
    const attempt = () => {
      if (!db) {
        openDB().then(ndb => { db = ndb; attempt(); }).catch(reject);
        return;
      }
      let req;
      try {
        req = op(db.transaction("items", mode).objectStore("items"));
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
  applySidebarCollapsed();
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
  btn.textContent = collapsed ? "›" : "‹";
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
function normalizeFeedUrl(raw) {
  let s = String(raw || "").trim();
  // Accept a bare address ("example.com/feed", "example.com") — assume https.
  if (!/^[a-z][a-z0-9+.-]*:/i.test(s)) s = "https://" + s;
  const u = new URL(s);
  if (u.protocol === "http:") u.protocol = "https:";
  return u.href;
}
function sameFeedUrl(a, b) {
  try {
    const na = new URL(a), nb = new URL(b);
    const norm = u => (u.protocol + "//" + u.hostname.replace(/^www\./, "") + u.pathname.replace(/\/$/, "") + u.search).toLowerCase();
    return norm(na) === norm(nb);
  } catch { return a === b; }
}

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
function itemImage(n) {
  const thumb = childEl(n, "thumbnail");
  if (thumb && thumb.getAttribute("url")) return thumb.getAttribute("url");
  const media = childEl(n, "content");
  if (media && media.getAttribute("url") && /^image\//.test(media.getAttribute("type") || "")) return media.getAttribute("url");
  const enc = childEl(n, "enclosure");
  if (enc && enc.getAttribute("url") && /^image\//.test(enc.getAttribute("type") || "")) return enc.getAttribute("url");
  return "";
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
      const content = childText(n, "encoded") || childText(n, "content") || childText(n, "description") || childText(n, "summary");
      const summary = childText(n, "summary") || childText(n, "description") || content;
      return {
        title: childText(n, "title") || "(untitled)",
        url: link || guid || url,
        guid,
        summary, content,
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
async function loadWordPressFeed(origin) {
  const base = origin.replace(/\/$/, "") + "/wp-json/wp/v2/posts";
  const r = await fetchWithTimeout(base + "?per_page=100&_embed&orderby=date&order=desc", {
    headers: { Accept: "application/json" }, cache: "no-store"
  });
  if (!r.ok) throw Error("HTTP " + r.status);
  const posts = await r.json();
  if (!Array.isArray(posts)) throw Error("Unexpected WordPress API response.");
  let siteTitle = host(origin), siteUrl = origin;
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
  return {
    title: siteTitle, site: siteUrl,
    items: posts.map(p => ({
      title: plainText(p.title?.rendered) || "(untitled)",
      url: p.link || origin,
      guid: (typeof p.guid === "string" ? p.guid : p.guid?.rendered) || p.link || "",
      summary: plainText(p.excerpt?.rendered) || "",
      content: p.content?.rendered || "",
      author: p._embedded?.author?.[0]?.name || "",
      date: p.date || p.modified || "",
      image: p._embedded?.["wp:featuredmedia"]?.[0]?.source_url || "",
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
      image: x.thumbnail || x.enclosure?.link || "",
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
async function loadFeedFromUrl(rawUrl) {
  const url = normalizeFeedUrl(rawUrl);
  let directError = null;
  try {
    const found = await discover(url);
    return { parsed: parseFeed(found.text, found.url), via: "feed", url: found.url, wpRoot: "" };
  } catch (e) { directError = e; }
  const origin = new URL(url).origin;
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

async function addFeed(raw) {
  const url = normalizeFeedUrl(raw);
  if (state.feeds.some(f => sameFeedUrl(f.url, url))) throw Error("You already subscribe to this feed.");
  const loaded = await loadFeedFromUrl(url);
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
  render();
  toast("Feed added" + (loaded.via === "feed" ? "." : loaded.via === "wp" ? " (via the site's WordPress API)." : " (via the proxy fallback)."));
}

async function saveItems(feed, items) {
  const seen = new Set();
  for (const x of items) {
    const link = x.url || feed.url;
    const key = feed.id + "|" + (x.guid || link);
    seen.add(key);
    const old = state.items.find(i => i.id === key)
      || state.items.find(i => i.feedId === feed.id && i.url === link);
    const item = {
      id: key, feedId: feed.id, feedTitle: feed.title,
      title: x.title, url: link, guid: x.guid || "",
      summary: cleanSummary(x.summary || ""), content: x.content || "",
      fullContent: old?.fullContent || "",
      author: x.author || "",
      published: date(x.date) ? date(x.date).toISOString() : null,
      image: x.image || old?.image || "",
      enclosure: x.enclosure || old?.enclosure || null,
      read: old?.read || false, saved: old?.saved || false,
      tags: old?.tags || []
    };
    await put(item);
  }
  // Prune items no longer in the feed, unless the user saved them or read them.
  // Cap each feed at MAX_ITEMS_PER_FEED newest items.
  const mine = state.items.filter(i => i.feedId === feed.id);
  for (const old of mine) {
    if (!seen.has(old.id) && !old.saved && !old.read) await dbDelete(old.id);
  }
  state.items = await dbAll();
  const fresh = state.items.filter(i => i.feedId === feed.id)
    .sort((a, b) => (dateSortKey(b) ?? -1) - (dateSortKey(a) ?? -1));
  for (const extra of fresh.slice(MAX_ITEMS_PER_FEED)) {
    if (!extra.saved) await dbDelete(extra.id);
  }
  state.items = await dbAll();
}

async function refreshFeed(f) {
  try {
    let loaded;
    if (f.via === "wp" && f.wpRoot) {
      loaded = { parsed: await loadWordPressFeed(f.wpRoot), via: "wp", url: f.url, wpRoot: f.wpRoot };
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
  if (!state.feeds.length) { showFeed(); return; }
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
function visible() {
  let a = state.items.filter(x =>
    state.view === "unread" ? !x.read
    : state.view === "saved" ? x.saved
    : state.view === "feed" ? x.feedId === state.feed
    : state.view === "tag" ? (x.tags || []).includes(state.tag)
    : true);
  if (state.filter === "today") {
    a = a.filter(x => { const d = date(x.published); return d && d.toDateString() === new Date().toDateString(); });
  }
  if (state.filter === "week") {
    a = a.filter(x => { const d = date(x.published); return d && (Date.now() - d.getTime() < 7 * 864e5); });
  }
  if (state.query) {
    const q = state.query.toLowerCase();
    a = a.filter(x => [x.title, x.summary, x.author, x.feedTitle, (x.tags || []).join(" ")].join(" ").toLowerCase().includes(q));
  }
  const newest = state.sort === "newest";
  return a.sort((x, y) => {
    const dx = dateSortKey(x), dy = dateSortKey(y);
    if (dx === null && dy === null) return 0;
    if (dx === null) return 1; // dateless items always last
    if (dy === null) return -1;
    return (dy - dx) * (newest ? 1 : -1);
  });
}
function renderNav() {
  const unread = state.items.filter(x => !x.read).length;
  $("#allCount").textContent = state.items.length;
  $("#unreadCount").textContent = unread;
  $("#savedCount").textContent = state.items.filter(x => x.saved).length;
  $$(".nav").forEach(b => {
    b.classList.toggle("active", b.dataset.view === state.view && state.view !== "feed");
    if (b.dataset.view === state.view && state.view !== "feed") b.setAttribute("aria-current", "true");
    else b.removeAttribute("aria-current");
  });
  const groups = {};
  for (const f of state.feeds) (groups[f.group || ""] ||= []).push(f);
  const groupNames = Object.keys(groups).sort((a, b) => (a === "" ? 1 : b === "" ? -1 : a.localeCompare(b)));
  $("#feeds").innerHTML = state.feeds.length ? groupNames.map(g => {
    // Ungrouped feeds render last, after the folders; label them so they
    // are not misread as belonging to the folder above them.
    const label = g ? `<div class="folder-head"><span class="feed-group">${esc(g)}</span><span class="folder-actions"><button type="button" data-folder-rename="${esc(g)}" title="Rename folder" aria-label="Rename folder ${esc(g)}">✎</button><button type="button" data-folder-delete="${esc(g)}" title="Delete folder" aria-label="Delete folder ${esc(g)}">×</button></span></div>` : (groupNames.length > 1 ? `<div class="feed-group">Ungrouped</div>` : "");
    return label + groups[g].map(f => {
      const unreadCount = state.items.filter(x => x.feedId === f.id && !x.read).length;
      const err = f.error ? ` feed-error" title="${esc(f.error)}` : "";
      const armed = pendingDelete?.kind === "feed" && pendingDelete.id === f.id;
      return `<div class="feed-row-wrap"><button class="feed-row${state.feed === f.id ? " active" : ""}${err}" data-feed="${esc(f.id)}" ${state.feed === f.id ? 'aria-current="true"' : ""}><span class="feed-dot"></span><span class="feed-name">${esc(f.title)}</span>${f.error ? '<span class="feed-err" aria-hidden="true">!</span>' : ""}<small>${unreadCount || ""}</small></button><button type="button" class="feed-unsub${armed ? " armed" : ""}" data-unsub="${esc(f.id)}" title="${armed ? "Click again to unsubscribe" : `Unsubscribe from ${esc(f.title)}`}" aria-label="${armed ? `Click again to unsubscribe from ${esc(f.title)}` : `Unsubscribe from ${esc(f.title)}`}">×</button></div>`;
    }).join("");
  }).join("") : '<p class="muted">Your feeds will appear here.</p>';
  const tagCounts = {};
  for (const x of state.items) for (const t of x.tags || []) tagCounts[t] = (tagCounts[t] || 0) + 1;
  $("#tags").innerHTML = state.tags.length ? state.tags.map(t =>
    `<button class="nav tag-row${state.view === "tag" && state.tag === t ? " active" : ""}" data-tag="${esc(t)}" ${state.view === "tag" && state.tag === t ? 'aria-current="true"' : ""}>🏷 ${esc(t)}<span>${tagCounts[t] || 0}</span></button>`
  ).join("") : '<p class="muted">Tag articles from the reader to find them here.</p>';
}
function renderList() {
  const a = visible();
  const titles = { all: "All articles", unread: "Unread", saved: "Saved", feed: state.feeds.find(f => f.id === state.feed)?.title || "Feed", tag: state.tag ? "Tag: " + state.tag : "Tag" };
  $("#heading").textContent = titles[state.view];
  $("#mobileTitle").textContent = titles[state.view];
  $("#subtitle").textContent = state.view === "saved" ? "Articles you have kept for later."
    : state.view === "unread" ? "Stories you have not read yet."
    : state.view === "tag" ? `Articles tagged “${state.tag}”.`
    : "Your subscriptions, gathered in one place.";
  $("#articleList").innerHTML = a.length ? a.map(x => {
    const d = date(x.published);
    return `<article class="article ${x.read ? "" : "unread"} ${x.id === state.selected ? "selected" : ""}" data-item="${esc(x.id)}" tabindex="0"><div class="article-meta"><span>${esc(feedTitleFor(x))}</span><span>·</span><time>${esc(d ? d.toLocaleDateString() : "No date")}</time></div><h2>${esc(x.title)}</h2><p>${esc(snippet(cleanSummary(x.summary), 210))}</p><div class="article-bottom"><span>${esc(x.author)}</span><span class="article-actions"><button data-action="read" data-id="${esc(x.id)}" title="Toggle read (m)" aria-label="${x.read ? "Mark unread" : "Mark read"}: ${esc(x.title)}" aria-pressed="${x.read}">${x.read ? "○" : "●"}</button><button data-action="save" data-id="${esc(x.id)}" title="Save (s)" aria-label="${x.saved ? "Unsave" : "Save"}: ${esc(x.title)}" aria-pressed="${x.saved}">${x.saved ? "★" : "☆"}</button></span></div></article>`;
  }).join("") : '<div class="empty"><div class="empty-mark">R</div><h2>Nothing to show.</h2><p>Add a feed or change the current filter.</p><button class="primary" id="emptyAdd">Add a feed</button></div>';
  const b = $("#emptyAdd");
  if (b) b.onclick = showFeed;
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
function cleanHTML(html, base) {
  const doc = new DOMParser().parseFromString(html, "text/html");
  doc.querySelectorAll("script,style,iframe,object,embed,form,link,meta,noscript").forEach(n => n.remove());
  doc.querySelectorAll("*").forEach(n => {
    ["href", "src", "poster"].forEach(name => resolveAttr(n, name, base));
    resolveSrcset(n, base);
    [...n.attributes].forEach(a => {
      if (/^on/i.test(a.name)) { n.removeAttribute(a.name); return; }
      if ((a.name === "href" || a.name === "src") && !/^(https?:|mailto:|#|data:image\/)/i.test(a.value)) n.removeAttribute(a.name);
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

/* Lightweight full-article extraction (no library): prefer <article>/<main>,
   otherwise the block with the most paragraph text; drop nav/chrome. */
function extractArticle(html, base) {
  const doc = new DOMParser().parseFromString(html, "text/html");
  doc.querySelectorAll("script,style,nav,aside,header,footer,form,noscript,.share,.social,.related,.comments,#comments").forEach(n => n.remove());
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
async function fetchArticleHtml(url) {
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
  try {
    const r = await fetchWithTimeout(JINA + url, {
      headers: { Accept: "text/plain" }, cache: "no-store"
    }, PROXY_TIMEOUT_MS);
    if (!r.ok) throw Error("HTTP " + r.status);
    const md = await r.text();
    if (/RateLimitTriggeredError/i.test(md)) throw Error("Reader service rate-limited.");
    const html = markdownToHTML(md);
    if (stripTags(html).length < 200) throw Error("No article text found.");
    return html;
  } catch {}
  // Generic proxy (returns the raw page HTML). Slow and flaky per site.
  try {
    const r = await fetchWithTimeout(ALLORIGINS + encodeURIComponent(url), { cache: "no-store" }, PROXY_TIMEOUT_MS);
    if (!r.ok) throw Error("HTTP " + r.status);
    const text = await r.text();
    if (!/<(article|main|body|div|p)[\s>]/i.test(text)) throw Error("Not an article page.");
    return text;
  } catch (e) { throw directErr || e; }
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
  if (btn) { btn.disabled = true; btn.textContent = "Loading…"; }
  try {
    // The site's own WordPress API first — but only for sites we know
    // are WordPress (their feed loaded via the WP API). Asking every
    // other publisher's origin for /wp-json/ can only 404.
    const f = state.feeds.find(f => f.id === item.feedId);
    const wp = (f?.via === "wp" || f?.wpRoot) ? await fetchViaWordPress(item.url) : null;
    if (wp) {
      item.fullContent = wp;
    } else {
      const html = await fetchArticleHtml(item.url);
      const body = extractArticle(html, item.url);
      if (!body || !body.textContent.trim()) throw Error("No article text found.");
      item.fullContent = body.innerHTML;
    }
    await put(item);
    openItem(item.id);
    toast("Full article loaded.");
  } catch (e) {
    if (btn) { btn.disabled = false; btn.textContent = "Load full article"; }
    toast(state.settings.proxyFallback
      ? "Full text unavailable — the publisher blocks direct access and the reader services could not fetch this page."
      : "Full text unavailable — showing the feed excerpt. Turn on the proxy fallback in Settings to try reader services.");
  }
}

function readerBodyHTML(x) {
  const showingFull = !!x.fullContent;
  const body = showingFull ? x.fullContent : (x.content || x.summary || "<p>No article text was included in this feed.</p>");
  return { showingFull, body };
}
/* Build the reader pane for an item without changing its read state.
   openItem() marks the item read first; toggles (m, list buttons) call
   this directly so marking an item unread is not immediately undone. */
function renderReader(x) {
  const f = state.feeds.find(f => f.id === x.feedId);
  const d = date(x.published);
  const { showingFull, body } = readerBodyHTML(x);
  // WordPress API items already carry the full article, and so does any
  // feed item with long content — do not offer to "load" what is there.
  /* "Full article included in feed" only when we know it: the feed was
     loaded from the site's own WordPress API, whose posts carry full
     content. Length is NOT a signal — some feeds (e.g. NASA) ship long
     excerpts padded with site boilerplate, which the old >1500-char
     guess mislabelled as full and left with no way to fetch the rest. */
  const alreadyFull = !showingFull && f?.via === "wp" && stripTags(x.content || "").length > 200;
  const canFull = !showingFull && !x.fullContent && !alreadyFull;
  $("#reader").innerHTML = `<div class="reader-content"><div class="reader-top"><span>${esc(f?.title || x.feedTitle)}</span><div class="reader-actions"><button data-reader="save" title="Save (s)" aria-label="${x.saved ? "Unsave article" : "Save article"}" aria-pressed="${x.saved}">${x.saved ? "★" : "☆"}</button><button data-reader="read" title="${x.read ? "Mark unread (m)" : "Mark read (m)"}" aria-label="${x.read ? "Mark unread" : "Mark read"}">${x.read ? "◉" : "○"}</button><button data-reader="open" title="Open original (v)" aria-label="Open original">↗</button><button data-reader="close" title="Close (u / Esc)" aria-label="Close article">×</button></div></div><h1>${esc(x.title)}</h1><div class="byline">${esc(x.author)} · ${esc(d ? fmtDateTime(d) : "No date")}</div><div class="tags-row" id="tagsRow">${(x.tags || []).map(t => `<span class="tag-chip">${esc(t)}<button type="button" data-tag-remove="${esc(t)}" aria-label="Remove tag ${esc(t)}">×</button></span>`).join("")}<input id="tagInput" list="tagList" placeholder="Add a tag… (t)" aria-label="Add a tag"><datalist id="tagList">${state.tags.map(t => `<option value="${esc(t)}">`).join("")}</datalist></div>${x.image && !showingFull ? `<p class="reader-hero"><img src="${esc(x.image)}" alt=""></p>` : ""}<div class="reader-body" id="body"></div><div class="reader-footer"><button class="quiet" data-reader="fulltext" ${canFull ? "" : "disabled"}>${showingFull ? "Showing full article" : alreadyFull ? "Full article included in feed" : "Load full article"}</button><a href="${esc(x.url)}" target="_blank" rel="noopener noreferrer">Open original article ↗</a><p>${showingFull ? "Full article text, extracted from the original page." : "Content supplied by the publisher's feed."}${x.enclosure?.type?.startsWith("audio/") ? ` <a href="${esc(x.enclosure.url)}">Listen to audio</a>` : ""}</p></div></div>`;
  const bodyEl = $("#body");
  // Append the cleaned body's children, not the <body> element itself.
  bodyEl.append(...cleanHTML(body, x.url).childNodes);
  $("#reader").classList.add("open");
  if (history.state?.reader !== x.id) {
    try {
      if (history.state?.reader) history.replaceState({ reader: x.id }, "");
      else history.pushState({ reader: x.id }, "");
    } catch {}
  }
}
function openItem(itemId) {
  const x = state.items.find(i => i.id === itemId);
  if (!x) return;
  state.selected = itemId;
  if (!x.read) { x.read = true; put(x); }
  renderNav();
  renderList();
  const row = document.querySelector(`[data-item="${CSS.escape(itemId)}"]`);
  if (row) { row.scrollIntoView({ block: "nearest" }); row.focus({ preventScroll: true }); }
  renderReader(x);
}
function closeReader() {
  const wasOpen = $("#reader").classList.contains("open") || !!state.selected;
  $("#reader").classList.remove("open");
  state.selected = null;
  render(); // resets the reader pane to "Select an article to read"
  if (wasOpen && history.state?.reader) {
    try { history.back(); } catch {}
  }
}
function render() {
  renderNav();
  renderList();
  if (!state.selected) $("#reader").innerHTML = '<div class="reader-empty"><span>✳</span><p>Select an article to read.</p><small>Use j and k to move, o to open, ? for all shortcuts.</small></div>';
}

/* ---------- folders & tags ---------- */
function goTag(tag) {
  state.view = "tag"; state.tag = tag; state.feed = null; state.selected = null;
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
  for (const x of state.items) {
    if ((x.tags || []).includes(oldName)) {
      x.tags = x.tags.map(t => t === oldName ? name : t);
      await put(x);
    }
  }
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
  for (const x of state.items) {
    if ((x.tags || []).includes(name)) {
      x.tags = x.tags.filter(t => t !== name);
      await put(x);
    }
  }
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
  state.feeds = state.feeds.filter(x => x.id !== id);
  saveFeeds();
  for (const x of state.items.filter(x => x.feedId === id && !x.saved)) await dbDelete(x.id);
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
  toast(`Unsubscribed from “${f.title}”. Saved articles were kept.`);
}
async function doRename(rawName) {
  if (!orgEdit) return;
  const { kind, old } = orgEdit;
  orgEdit = null;
  if (kind === "folder") renameFolder(old, rawName);
  else await renameTag(old, rawName);
  renderOrganize();
  render();
  if (state.selected) { const x = selectedItem(); if (x) renderReader(x); }
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
    return `<div class="org-row"><span class="org-name">🏷 ${esc(name)}</span><small>${count} article${count === 1 ? "" : "s"}</small><button type="button" class="quiet" data-org-rename-tag="${esc(name)}">Rename</button><button type="button" class="quiet" data-org-delete-tag="${esc(name)}">${armed ? "Confirm delete" : "Delete"}</button></div>`;
  };
  $("#organizeBody").innerHTML = `
    <div class="org-section"><h3>Folders</h3><p class="muted">Group your feeds. Deleting a folder keeps its feeds, ungrouped.</p>${state.folders.map(folderRow).join("") || '<p class="muted">No folders yet.</p>'}<div class="org-new"><input id="newFolder" placeholder="New folder name" aria-label="New folder name"><button type="button" class="primary" data-org-add-folder>Add</button></div></div>
    <div class="org-section"><h3>Feeds</h3><p class="muted">Move each feed into a folder, or unsubscribe from it.</p>${state.feeds.map(f => { const armed = pendingDelete?.kind === "feed" && pendingDelete.id === f.id; return `<div class="org-row"><span class="org-name">${esc(f.title)}</span><select data-org-move="${esc(f.id)}" aria-label="Folder for ${esc(f.title)}"><option value="">No folder</option>${state.folders.map(g => `<option value="${esc(g)}" ${f.group === g ? "selected" : ""}>${esc(g)}</option>`).join("")}</select><button type="button" class="quiet" data-org-unsub="${esc(f.id)}">${armed ? "Confirm unsubscribe" : "Unsubscribe"}</button></div>`; }).join("") || '<p class="muted">No feeds yet.</p>'}</div>
    <div class="org-section"><h3>Tags</h3><p class="muted">Tags are applied to articles from the reader (press t). Renaming a tag updates every article that has it.</p>${state.tags.map(tagRow).join("") || '<p class="muted">No tags yet.</p>'}<div class="org-new"><input id="newTag" placeholder="New tag name" aria-label="New tag name"><button type="button" class="primary" data-org-add-tag>Add</button></div></div>`;
}
function showOrganize() {
  orgEdit = null;
  renderOrganize();
  $("#organizeDialog").showModal();
}
function showFeed() {
  $("#feedError").textContent = "";
  $("#feedUrl").value = "";
  $("#feedDialog").showModal();
  $("#feedUrl").focus();
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
      finally { done++; toast(`Importing feeds… ${done} of ${jobs.length}`); }
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
    if (d.format !== "rss-reader-settings" || d.version !== 1) throw Error("Unsupported settings file.");
    state.settings = { ...state.settings, ...d.settings };
    local(S, state.settings);
    applySettings();
    toast("Settings imported.");
  } catch (e) { toast(e.message); }
}
function showSettings() {
  $("#themeSelect").value = state.settings.theme;
  $("#widthSelect").value = state.settings.width;
  $("#sizeSelect").value = state.settings.size;
  $("#proxyToggle").checked = !!state.settings.proxyFallback;
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
  state.view = view; state.feed = null; state.tag = null; state.selected = null;
  $("#reader").classList.remove("open");
  render();
}
async function markVisibleRead() {
  for (const x of visible()) { x.read = true; await put(x); }
  render();
  toast("Visible articles marked read.");
}

function bind() {
  document.addEventListener("click", async e => {
    const scrim = e.target.closest("#scrim");
    if (scrim) { $("#sidebar").classList.remove("open"); scrim.classList.remove("show"); return; }
    const nav = e.target.closest("[data-view]");
    if (nav) { goView(nav.dataset.view); $("#sidebar").classList.remove("open"); $("#scrim").classList.remove("show"); return; }
    const tagBtn = e.target.closest("[data-tag]");
    if (tagBtn) { goTag(tagBtn.dataset.tag); $("#sidebar").classList.remove("open"); $("#scrim").classList.remove("show"); return; }
    const folderRename = e.target.closest("[data-folder-rename]");
    if (folderRename) { orgEdit = { kind: "folder", old: folderRename.dataset.folderRename }; showOrganize(); return; }
    const folderDelete = e.target.closest("[data-folder-delete]");
    if (folderDelete) { pendingDelete = { kind: "folder", name: folderDelete.dataset.folderDelete }; showOrganize(); return; }
    const unsub = e.target.closest("[data-unsub]");
    if (unsub) { requestUnsubscribe(unsub.dataset.unsub); return; }
    const feed = e.target.closest("[data-feed]");
    if (feed) {
      state.view = "feed"; state.feed = feed.dataset.feed; state.tag = null; state.selected = null;
      render();
      $("#sidebar").classList.remove("open");
      $("#scrim").classList.remove("show");
      return;
    }
    const act = e.target.closest("[data-action]");
    if (act) {
      const x = state.items.find(i => i.id === act.dataset.id);
      if (x) {
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
    const tagRemove = e.target.closest("[data-tag-remove]");
    if (tagRemove && state.selected) {
      const x = selectedItem();
      if (x) removeTagFromItem(x, tagRemove.dataset.tagRemove);
      return;
    }
    const ra = e.target.closest("[data-reader]");
    if (ra && state.selected) {
      const x = selectedItem();
      if (!x) return;
      if (ra.dataset.reader === "save") { x.saved = !x.saved; await put(x); openItem(x.id); return; }
      if (ra.dataset.reader === "read") { x.read = !x.read; await put(x); renderNav(); renderList(); renderReader(x); toast(x.read ? "Article marked read." : "Article marked unread."); return; }
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
  $("#organize").onclick = showOrganize;
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
    const saveRename = e.target.closest("[data-org-save-rename]");
    if (saveRename) { await doRename($("#orgEditInput")?.value); return; }
    const cancelRename = e.target.closest("[data-org-cancel-rename]");
    if (cancelRename) { orgEdit = null; renderOrganize(); return; }
    const delFolder = e.target.closest("[data-org-delete-folder]");
    if (delFolder) { deleteFolder(delFolder.dataset.orgDeleteFolder); return; }
    const delTag = e.target.closest("[data-org-delete-tag]");
    if (delTag) { await deleteTag(delTag.dataset.orgDeleteTag); return; }
    const orgUnsub = e.target.closest("[data-org-unsub]");
    if (orgUnsub) { await requestUnsubscribe(orgUnsub.dataset.orgUnsub); return; }
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
  $("#settings").onclick = showSettings;
  $("#theme").onclick = () => {
    state.settings.theme = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
    local(S, state.settings);
    applySettings();
  };
  $("#search").oninput = e => { state.query = e.target.value.toLowerCase(); $("#searchClear").hidden = !e.target.value; renderList(); };
  $("#searchClear").onclick = () => { $("#search").value = ""; state.query = ""; $("#searchClear").hidden = true; renderList(); $("#search").focus(); };
  $("#sort").onclick = () => {
    state.sort = state.sort === "newest" ? "oldest" : "newest";
    $("#sort").textContent = state.sort === "newest" ? "Newest first ↓" : "Oldest first ↑";
    renderList();
  };
  $$(".filter").forEach(b => b.onclick = () => {
    $$(".filter").forEach(x => x.classList.toggle("active", x === b));
    state.filter = b.dataset.filter;
    renderList();
  });
  $("#markRead").onclick = markVisibleRead;
  $("#importOpml").onclick = () => $("#opmlFile").click();
  $("#exportOpml").onclick = exportOPML;
  $("#opmlFile").onchange = e => { if (e.target.files[0]) importOPML(e.target.files[0]); e.target.value = ""; };
  $("#feedForm").onsubmit = async e => {
    if (e.submitter?.value === "cancel") return;
    e.preventDefault();
    const b = $("#saveFeed");
    b.disabled = true;
    try {
      await addFeed($("#feedUrl").value.trim());
      $("#feedDialog").close();
    } catch (err) {
      $("#feedError").textContent = classifyError(err, /^http:/i.test($("#feedUrl").value.trim()));
    } finally { b.disabled = false; }
  };
  $("#saveSettings").onclick = () => {
    state.settings = {
      theme: $("#themeSelect").value, width: $("#widthSelect").value, size: $("#sizeSelect").value,
      proxyFallback: $("#proxyToggle").checked,
      sidebarCollapsed: state.settings.sidebarCollapsed || false
    };
    local(S, state.settings);
    applySettings();
  };
  $("#exportSettings").onclick = exportSettings;
  $("#importSettings").onclick = () => $("#settingsFile").click();
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
    if ($("#reader").classList.contains("open") || state.selected) {
      $("#reader").classList.remove("open");
      state.selected = null;
      render();
    }
  });
  document.onkeydown = e => {
    const tag = document.activeElement?.tagName;
    if (["INPUT", "SELECT", "TEXTAREA"].includes(tag) || $("dialog[open]")) return;
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

async function init() {
  loadLocal();
  try {
    db = await openDB();
    state.items = await dbAll();
    syncTags();
    saveTags();
    bind();
    applySettings();
    render();
    if (state.feeds.length && !state.items.length) refresh();
  } catch (e) {
    console.error(e);
    toast("Could not open browser storage.");
  }
  if ("serviceWorker" in navigator && location.protocol.startsWith("http")) {
    navigator.serviceWorker.register("./sw.js").catch(() => {});
  }
}
init();
})();
