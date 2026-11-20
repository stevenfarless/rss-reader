/* Pure helpers shared by the reader and its tests. No DOM, no state:
   these functions are deterministic and safe to import in Node. Loaded
   as a classic script before app.js, so app.js uses the same globals. */
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
    // Only the scheme and host are case-insensitive: URL paths are
    // case-sensitive, so /Feed.xml and /feed.xml are different feeds.
    const norm = u => (u.protocol + "//" + u.hostname.replace(/^www\./, "").toLowerCase() + u.pathname.replace(/\/$/, "") + u.search);
    return norm(na) === norm(nb);
  } catch { return a === b; }
}
/* Canonical article URL (#115): the strict duplicate definition. The
   same story at the same address is one article, even when feeds carry
   it with different tracking parameters, a fragment, or a www prefix.
   A different address is a different article, even with the same title. */
const TRACKING_PARAMS = /^(utm_|fbclid|gclid|mc_cid|mc_eid)/i;
const canonicalUrl = u => {
  try {
    const p = new URL(u);
    p.hash = "";
    p.hostname = p.hostname.replace(/^www\./, "").toLowerCase();
    [...p.searchParams.keys()].forEach(k => { if (TRACKING_PARAMS.test(k)) p.searchParams.delete(k); });
    p.searchParams.sort();
    p.pathname = p.pathname.replace(/\/+$/, "") || "/";
    return p.href;
  } catch { return String(u || ""); }
};
function dedupeItems(a) {
  const seen = new Set();
  return a.filter(x => {
    // The canonical URL is stored at save time; older items predate
    // the field and fall back to computing it.
    const k = x.canonical || canonicalUrl(x.url);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}
/* Shorten text to n characters at a word boundary, with an ellipsis. */
const snippet = (s, n) => {
  s = String(s || "");
  if (s.length <= n) return s;
  const cut = s.slice(0, n).replace(/\s+\S*$/, "");
  return (cut || s.slice(0, n)) + "…";
};
/* Rules (#109): a rule matches when its scope (all feeds, one folder,
   or one feed) matches and every condition it sets (title keyword,
   author) matches. */
function ruleMatches(rule, feed, item) {
  if (!rule.enabled) return false;
  if (rule.scope?.startsWith("feed:")) { if (feed.id !== rule.scope.slice(5)) return false; }
  else if (rule.scope?.startsWith("folder:")) { if ((feed.group || "") !== rule.scope.slice(7)) return false; }
  if (rule.keyword && !(item.title || "").toLowerCase().includes(rule.keyword.toLowerCase())) return false;
  if (rule.author && !(item.author || "").toLowerCase().includes(rule.author.toLowerCase())) return false;
  return true;
}
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
  let cut = s.length;
  for (const m of NAV_MARKERS) {
    const i = s.indexOf(m);
    if (i >= 0 && i < cut) cut = i;
  }
  s = s.slice(0, cut).trim();
  // The navigation cut leaves a leading run of header tokens
  // ("APOD Astronomy Picture of the Day"); drop them.
  const lead = s.match(/^(?:[A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,4}\s+){1,3}(?=[A-Z])/);
  if (lead && s.length > lead[0].length + 20) s = s.slice(lead[0].length).trim();
  return s;
};

/* Move a feed within the sidebar list (#182): reorder it, or move it
   into another folder (or out to Ungrouped). `target` is either
   { kind: "row", feedId, before } (drop on a feed row, joining that
   feed's folder) or { kind: "folder", group } (drop on a folder head
   or container: append at the end of that folder; "" is Ungrouped).
   Mutates the array in place and returns the moved feed, or null when
   the dragged feed is unknown. Dropping a feed on itself is a no-op. */
function moveFeedInList(feeds, draggedId, target) {
  const from = feeds.findIndex(f => f.id === draggedId);
  if (from < 0) return null;
  const [feed] = feeds.splice(from, 1);
  if (target.kind === "row") {
    const to = feeds.findIndex(f => f.id === target.feedId);
    if (to < 0) { feeds.splice(from, 0, feed); return feed; }
    feed.group = typeof feeds[to].group === "string" ? feeds[to].group : "";
    feeds.splice(target.before ? to : to + 1, 0, feed);
  } else {
    feed.group = typeof target.group === "string" ? target.group : "";
    let at = feeds.length;
    for (let i = feeds.length - 1; i >= 0; i--) {
      if ((feeds[i].group || "") === feed.group) { at = i + 1; break; }
    }
    feeds.splice(at, 0, feed);
  }
  return feed;
}

/* Whether the article author is already shown as the feed title, so
   the card should not repeat it in the bottom row. */
function authorIsFeedTitle(author, feedTitle) {
  const a = (author || "").trim().toLowerCase();
  const t = (feedTitle || "").trim().toLowerCase();
  return !!a && a === t;
}

/* The named folders a set of feeds belongs to, sorted; ungrouped ("")
   is not a folder and is left out. */
function namedFolderNames(feeds) {
  return [...new Set(feeds.map(f => f.group).filter(g => typeof g === "string" && g))].sort((a, b) => a.localeCompare(b));
}
/* Cycle a feed's own sort (#183): use global, then newest, then
   oldest, then back to global. */
function nextFeedSort(current) {
  return !current || current === "global" ? "newest" : current === "newest" ? "oldest" : "global";
}

/* Normalize a stored reader-toolbar button order (#197): keep known
   keys in their stored order, drop unknown keys, and append any keys
   the stored order is missing (so a new button still appears). */
function normalizeToolbarOrder(stored, keys, fallback) {
  const list = Array.isArray(stored) ? stored.filter(k => keys.includes(k)) : [];
  const base = list.length ? list : [...fallback];
  const missing = keys.filter(k => !base.includes(k));
  return [...base, ...missing];
}

/* Whether every named folder is collapsed, so the collapse/expand-all
   toggle should offer "expand all". False when there are no folders. */
function allFoldersCollapsed(names, collapsed) {
  return names.length > 0 && names.every(n => collapsed.has(n));
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = { normalizeFeedUrl, sameFeedUrl, canonicalUrl, dedupeItems, snippet, ruleMatches, cleanSummary, moveFeedInList, namedFolderNames, allFoldersCollapsed, authorIsFeedTitle, normalizeToolbarOrder, nextFeedSort };
}
