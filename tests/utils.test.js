"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { normalizeFeedUrl, sameFeedUrl, canonicalUrl, dedupeItems, snippet, ruleMatches, cleanSummary, moveFeedInList } = require("../utils.js");

test("normalizeFeedUrl adds https to a bare address and upgrades http", () => {
  assert.equal(normalizeFeedUrl("example.com/feed"), "https://example.com/feed");
  assert.equal(normalizeFeedUrl("http://example.com/feed"), "https://example.com/feed");
  assert.equal(normalizeFeedUrl("https://example.com/feed"), "https://example.com/feed");
});

test("sameFeedUrl ignores www and a trailing slash, but not path case", () => {
  assert.equal(sameFeedUrl("https://www.example.com/feed/", "https://example.com/feed"), true);
  assert.equal(sameFeedUrl("https://example.com/Feed.xml", "https://example.com/feed.xml"), false);
  assert.equal(sameFeedUrl("https://example.com/feed", "https://other.com/feed"), false);
});

test("canonicalUrl strips tracking params, fragments, and www, and sorts the rest", () => {
  assert.equal(canonicalUrl("https://www.example.com/a/?utm_source=x&b=2#frag"), "https://example.com/a?b=2");
  assert.equal(canonicalUrl("https://example.com/a/?fbclid=1&gclid=2"), "https://example.com/a");
  assert.equal(canonicalUrl("https://example.com/a/?z=1&a=2"), "https://example.com/a?a=2&z=1");
  assert.equal(canonicalUrl("https://example.com/a/"), "https://example.com/a");
});

test("dedupeItems collapses the same canonical URL and keeps the first", () => {
  const a = { url: "https://example.com/a/?utm_source=x" };
  const b = { url: "https://example.com/a/" };
  const c = { url: "https://example.com/b/" };
  assert.deepEqual(dedupeItems([a, b, c]), [a, c]);
  // A stored canonical value is used instead of re-parsing the URL.
  const d = { url: "https://example.com/a/?utm_source=x", canonical: "https://example.com/a" };
  assert.deepEqual(dedupeItems([d, b]), [d]);
});

test("snippet shortens at a word boundary and leaves short text alone", () => {
  assert.equal(snippet("short", 10), "short");
  assert.equal(snippet("one two three four", 10), "one two…");
});

test("ruleMatches respects scope, keyword, and author, and requires enabled", () => {
  const feed = { id: "f1", group: "Space" };
  const item = { title: "NASA Launches Rover", author: "Jane Doe" };
  const base = { enabled: true, scope: "all", keyword: "NASA", author: "" };
  assert.equal(ruleMatches(base, feed, item), true);
  assert.equal(ruleMatches({ ...base, enabled: false }, feed, item), false);
  assert.equal(ruleMatches({ ...base, keyword: "nasa" }, feed, item), true);
  assert.equal(ruleMatches({ ...base, keyword: "Mars" }, feed, item), false);
  assert.equal(ruleMatches({ ...base, author: "jane" }, feed, item), true);
  assert.equal(ruleMatches({ ...base, author: "John" }, feed, item), false);
  assert.equal(ruleMatches({ ...base, scope: "feed:f1" }, feed, item), true);
  assert.equal(ruleMatches({ ...base, scope: "feed:f2" }, feed, item), false);
  assert.equal(ruleMatches({ ...base, scope: "folder:Space" }, feed, item), true);
  assert.equal(ruleMatches({ ...base, scope: "folder:Other" }, feed, item), false);
});

test("cleanSummary strips Hacker News boilerplate and APOD navigation", () => {
  assert.equal(cleanSummary("Article URL: https://example.com/ · Comments URL: https://news.ycombinator.com/item?id=1 · Points: 42 # Comments: 7"), "42 points · 7 comments");
  assert.equal(cleanSummary("A real summary. Today's APOD Archive Submissions Previous APOD"), "A real summary.");
  assert.equal(cleanSummary("A plain summary."), "A plain summary.");
});

test("moveFeedInList reorders within a folder", () => {
  const feeds = [{ id: "a", group: "Space" }, { id: "b", group: "Space" }, { id: "c", group: "Space" }];
  moveFeedInList(feeds, "a", { kind: "row", feedId: "c", before: false });
  assert.deepEqual(feeds.map(f => f.id), ["b", "c", "a"]);
  moveFeedInList(feeds, "a", { kind: "row", feedId: "b", before: true });
  assert.deepEqual(feeds.map(f => f.id), ["a", "b", "c"]);
});

test("moveFeedInList moves a feed into another folder at a row", () => {
  const feeds = [{ id: "a", group: "Space" }, { id: "b", group: "" }, { id: "c", group: "" }];
  const moved = moveFeedInList(feeds, "a", { kind: "row", feedId: "c", before: true });
  assert.equal(moved.group, "");
  assert.deepEqual(feeds.map(f => f.id), ["b", "a", "c"]);
});

test("moveFeedInList appends to a folder on a folder drop", () => {
  const feeds = [{ id: "a", group: "" }, { id: "b", group: "Space" }, { id: "c", group: "Space" }];
  moveFeedInList(feeds, "a", { kind: "folder", group: "Space" });
  assert.deepEqual(feeds.map(f => [f.id, f.group]), [["b", "Space"], ["c", "Space"], ["a", "Space"]]);
  moveFeedInList(feeds, "b", { kind: "folder", group: "" });
  assert.deepEqual(feeds.map(f => [f.id, f.group]), [["c", "Space"], ["a", "Space"], ["b", ""]]);
});

test("moveFeedInList is a no-op for an unknown feed or a drop on itself", () => {
  const feeds = [{ id: "a", group: "Space" }, { id: "b", group: "Space" }];
  assert.equal(moveFeedInList(feeds, "z", { kind: "row", feedId: "b", before: true }), null);
  assert.deepEqual(feeds.map(f => f.id), ["a", "b"]);
  const moved = moveFeedInList(feeds, "a", { kind: "row", feedId: "a", before: true });
  assert.equal(moved.id, "a");
  assert.deepEqual(feeds.map(f => f.id), ["a", "b"]);
});

test("moveFeedInList never stores a non-string group", () => {
  const feeds = [{ id: "a", group: "Space" }, { id: "b", group: { name: "Space" } }, { id: "c", group: "" }];
  const moved = moveFeedInList(feeds, "a", { kind: "row", feedId: "b", before: true });
  assert.equal(moved.group, "");
  assert.equal(typeof moved.group, "string");
  const moved2 = moveFeedInList(feeds, "c", { kind: "folder", group: { name: "Space" } });
  assert.equal(moved2.group, "");
  assert.equal(typeof moved2.group, "string");
});

test("no duplicate top-level function declarations in the app source", () => {
  // Two functions with the same name silently shadow each other: the
  // drag handler once called the organize dialog's moveFeed(feedId,
  // folder) instead of the drag one, storing the whole drop-target
  // object as the feed's folder ("[object Object]").
  const fs = require("node:fs");
  const path = require("node:path");
  for (const file of ["app.js", "utils.js"]) {
    const src = fs.readFileSync(path.join(__dirname, "..", file), "utf8");
    const names = [...src.matchAll(/^function ([A-Za-z0-9_]+)\(/gm)].map(m => m[1]);
    const seen = new Set();
    for (const name of names) {
      assert.ok(!seen.has(name), `${file} declares function ${name} more than once`);
      seen.add(name);
    }
  }
});
