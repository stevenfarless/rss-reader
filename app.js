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
   WordPress API (which returns full content), or via the opt-in proxy. */

const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const K = "rss-reader.feeds.v1", S = "rss-reader.settings.v1", DB = "rss-reader-cache";
const PROXY_API = "https://api.rss2json.com/v1/api.json?rss_url=";
const ALLORIGINS = "https://api.allorigins.win/raw?url=";
const FETCH_TIMEOUT_MS = 15000;
const MAX_ITEMS_PER_FEED = 200;

const state = {
  feeds: [], items: [], view: "all", feed: null, filter: "all",
  sort: "newest", query: "", selected: null,
  settings: { theme: "dark", width: "comfortable", size: "normal", proxyFallback: false }
};
let db, timer, pendingG = null, refreshAt = 0;

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

function toast(s) {
  const e = $("#toast");
  e.textContent = s;
  e.classList.add("show");
  clearTimeout(timer);
  timer = setTimeout(() => e.classList.remove("show"), 3200);
}
function local(k, v) {
  try { localStorage.setItem(k, JSON.stringify(v)); }
  catch (e) { toast("Browser storage is full."); }
}
function loadLocal() {
  try { state.feeds = JSON.parse(localStorage.getItem(K) || "[]"); } catch {}
  try { state.settings = { ...state.settings, ...JSON.parse(localStorage.getItem(S) || "{}") }; } catch {}
}
function saveFeeds() { local(K, state.feeds); }

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
  document.documentElement.dataset.width = state.settings.width;
  document.documentElement.dataset.size = state.settings.size;
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
function classifyError(e) {
  if (e && e.name === "AbortError") return "Timed out after " + (FETCH_TIMEOUT_MS / 1000) + "s. The publisher did not respond in time.";
  const msg = String((e && e.message) || e || "");
  if (/Failed to fetch|NetworkError|Load failed|Network request failed/i.test(msg)) {
    return "Could not be reached from this browser. This usually means the publisher does not allow cross-origin requests (CORS), or the address uses http: on a secure page.";
  }
  if (/^HTTP \d+/.test(msg)) return "The publisher answered with " + msg + ".";
  if (/No feed link found/i.test(msg)) return msg;
  if (/not a supported/i.test(msg)) return msg;
  return msg || "Could not load this feed.";
}

/* ---------- fetching ---------- */
async function fetchWithTimeout(url, opts = {}) {
  const r = await fetch(url, { ...opts, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
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
  const u = new URL(raw);
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
  const r = await fetchWithTimeout(base + "?per_page=20&_embed&orderby=date&order=desc", {
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
  const url = normalizeFeedUrl(new URL(raw).href);
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
      summary: x.summary || "", content: x.content || "",
      fullContent: old?.fullContent || "",
      author: x.author || "",
      published: date(x.date) ? date(x.date).toISOString() : null,
      image: x.image || old?.image || "",
      enclosure: x.enclosure || old?.enclosure || null,
      read: old?.read || false, saved: old?.saved || false
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
  const results = await Promise.all(state.feeds.map(f => refreshFeed(f)));
  const ok = results.filter(Boolean).length;
  const failed = state.feeds.filter((f, i) => !results[i]).map(f => f.title);
  saveFeeds();
  render();
  toast(ok === state.feeds.length
    ? `Refreshed ${ok} of ${state.feeds.length} feeds.`
    : `Refreshed ${ok} of ${state.feeds.length} feeds. Failed: ${failed.join(", ")}.`);
}

/* ---------- list / render ---------- */
function visible() {
  let a = state.items.filter(x =>
    state.view === "unread" ? !x.read
    : state.view === "saved" ? x.saved
    : state.view === "feed" ? x.feedId === state.feed : true);
  if (state.filter === "today") {
    a = a.filter(x => { const d = date(x.published); return d && d.toDateString() === new Date().toDateString(); });
  }
  if (state.filter === "week") {
    a = a.filter(x => { const d = date(x.published); return d && (Date.now() - d.getTime() < 7 * 864e5); });
  }
  if (state.query) {
    const q = state.query.toLowerCase();
    a = a.filter(x => [x.title, x.summary, x.author, x.feedTitle].join(" ").toLowerCase().includes(q));
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
    const label = g ? `<div class="feed-group">${esc(g)}</div>` : "";
    return label + groups[g].map(f => {
      const unreadCount = state.items.filter(x => x.feedId === f.id && !x.read).length;
      const err = f.error ? ` feed-error" title="${esc(f.error)}` : "";
      return `<button class="feed-row${state.feed === f.id ? " active" : ""}${err}" data-feed="${esc(f.id)}" ${state.feed === f.id ? 'aria-current="true"' : ""}><span class="feed-dot"></span><span class="feed-name">${esc(f.title)}</span>${f.error ? '<span class="feed-err" aria-hidden="true">!</span>' : ""}<small>${unreadCount || ""}</small></button>`;
    }).join("");
  }).join("") : '<p class="muted">Your feeds will appear here.</p>';
}
function renderList() {
  const a = visible();
  const titles = { all: "All articles", unread: "Unread", saved: "Saved", feed: state.feeds.find(f => f.id === state.feed)?.title || "Feed" };
  $("#heading").textContent = titles[state.view];
  $("#mobileTitle").textContent = titles[state.view];
  $("#subtitle").textContent = state.view === "saved" ? "Articles you have kept for later."
    : state.view === "unread" ? "Stories you have not read yet."
    : "Your subscriptions, gathered in one place.";
  $("#articleList").innerHTML = a.length ? a.map(x => {
    const d = date(x.published);
    return `<article class="article ${x.read ? "" : "unread"} ${x.id === state.selected ? "selected" : ""}" data-item="${esc(x.id)}" tabindex="0" role="button" aria-label="${esc(x.title)}"><div class="article-meta"><span>${esc(x.feedTitle)}</span><span>·</span><time>${esc(d ? d.toLocaleDateString() : "No date")}</time></div><h2>${esc(x.title)}</h2><p>${esc((x.summary || "").replace(/<[^>]*>/g, " ").slice(0, 210))}</p><div class="article-bottom"><span>${esc(x.author)}</span><span class="article-actions"><button data-action="read" data-id="${esc(x.id)}" title="Toggle read (m)" aria-label="Toggle read" aria-pressed="${x.read}">${x.read ? "○" : "●"}</button><button data-action="save" data-id="${esc(x.id)}" title="Save (s)" aria-label="Save article" aria-pressed="${x.saved}">${x.saved ? "★" : "☆"}</button></span></div></article>`;
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
    if (n.tagName === "IMG" && !n.getAttribute("src")) n.remove();
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
  try {
    const r = await fetchWithTimeout(url, {
      headers: { Accept: "text/html,application/xhtml+xml,*/*" }, cache: "no-store"
    });
    if (!r.ok) throw Error("HTTP " + r.status);
    const text = await r.text();
    if (!/<(article|main|body|div|p)[\s>]/i.test(text)) throw Error("Not an article page.");
    return text;
  } catch (e) {
    if (!state.settings.proxyFallback) throw e;
    const r = await fetchWithTimeout(ALLORIGINS + encodeURIComponent(url), { cache: "no-store" });
    if (!r.ok) throw Error("HTTP " + r.status);
    const text = await r.text();
    if (!/<(article|main|body|div|p)[\s>]/i.test(text)) throw Error("Not an article page.");
    return text;
  }
}
async function loadFullText(item) {
  const btn = $('[data-reader="fulltext"]');
  if (btn) { btn.disabled = true; btn.textContent = "Loading…"; }
  try {
    const html = await fetchArticleHtml(item.url);
    const body = extractArticle(html, item.url);
    if (!body || !body.textContent.trim()) throw Error("No article text found.");
    item.fullContent = body.innerHTML;
    await put(item);
    openItem(item.id, true);
    toast("Full article loaded.");
  } catch (e) {
    if (btn) { btn.disabled = false; btn.textContent = "Load full article"; }
    toast("Full text unavailable — showing the feed excerpt.");
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
  const alreadyFull = !showingFull && (f?.via === "wp" || stripTags(x.content || "").length > 1500);
  const canFull = !showingFull && !x.fullContent && !alreadyFull;
  $("#reader").innerHTML = `<div class="reader-content"><div class="reader-top"><span>${esc(f?.title || x.feedTitle)}</span><div class="reader-actions"><button data-reader="save" title="Save (s)" aria-label="Save article" aria-pressed="${x.saved}">${x.saved ? "★" : "☆"}</button><button data-reader="read" title="${x.read ? "Mark unread (m)" : "Mark read (m)"}" aria-label="${x.read ? "Mark unread" : "Mark read"}">${x.read ? "◉" : "○"}</button><button data-reader="open" title="Open original (v)" aria-label="Open original">↗</button><button data-reader="close" title="Close (u / Esc)" aria-label="Close article">×</button></div></div><h1>${esc(x.title)}</h1><div class="byline">${esc(x.author)} · ${esc(d ? d.toLocaleString() : "No date")}</div>${x.image && !showingFull ? `<p class="reader-hero"><img src="${esc(x.image)}" alt=""></p>` : ""}<div class="reader-body" id="body"></div><div class="reader-footer"><button class="quiet" data-reader="fulltext" ${canFull ? "" : "disabled"}>${showingFull ? "Showing full article" : alreadyFull ? "Full article included in feed" : x.fullContent ? "Show full article" : "Load full article"}</button><a href="${esc(x.url)}" target="_blank" rel="noopener noreferrer">Open original article ↗</a><p>${showingFull ? "Full article text, extracted from the original page." : "Content supplied by the publisher's feed."}${x.enclosure?.type?.startsWith("audio/") ? ` <a href="${esc(x.enclosure.url)}">Listen to audio</a>` : ""}</p></div></div>`;
  const bodyEl = $("#body");
  bodyEl.append(cleanHTML(body, x.url));
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
  let added = 0, skipped = 0, failed = 0;
  const jobs = [];
  for (const o of d.querySelectorAll("outline[xmlUrl]")) {
    const rawUrl = o.getAttribute("xmlUrl");
    let url;
    try { url = normalizeFeedUrl(rawUrl); } catch { skipped++; continue; }
    if (state.feeds.some(f => sameFeedUrl(f.url, url))) { skipped++; continue; }
    const parent = o.parentElement;
    const group = parent && parent.localName === "outline" ? (parent.getAttribute("text") || parent.getAttribute("title") || "") : "";
    jobs.push((async () => {
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
    })());
  }
  await Promise.all(jobs);
  saveFeeds();
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
  state.view = view; state.feed = null; state.selected = null;
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
    const feed = e.target.closest("[data-feed]");
    if (feed) {
      state.view = "feed"; state.feed = feed.dataset.feed; state.selected = null;
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
    if (row && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); openItem(row.dataset.item); }
  });
  $("#home").onclick = () => { goView("all"); };
  $("#add").onclick = $("#mobileAdd").onclick = $("#firstAdd").onclick = showFeed;
  $("#refresh").onclick = refresh;
  $("#settings").onclick = showSettings;
  $("#theme").onclick = () => {
    state.settings.theme = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
    local(S, state.settings);
    applySettings();
  };
  $("#search").oninput = e => { state.query = e.target.value.toLowerCase(); renderList(); };
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
      $("#feedError").textContent = classifyError(err);
    } finally { b.disabled = false; }
  };
  $("#saveSettings").onclick = () => {
    state.settings = {
      theme: $("#themeSelect").value, width: $("#widthSelect").value, size: $("#sizeSelect").value,
      proxyFallback: $("#proxyToggle").checked
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
    if (pendingG) {
      const g = pendingG; pendingG = null;
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
  };
}

async function init() {
  loadLocal();
  try {
    db = await openDB();
    state.items = await dbAll();
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
