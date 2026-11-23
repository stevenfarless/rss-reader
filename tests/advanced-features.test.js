import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  migrateBackupDocument,
  mergeBackupDocument,
  getRetentionCandidates,
  getFeedRefreshInterval,
  isFeedRefreshDue,
  getFeedBackoffMinutes,
  getFeedHealthState,
  getOpmlFolderPath,
  selectAnnotationEntries,
  getShortcutForAction,
  shouldShowShortcutCoach,
  calculateReadingActivity
} = require("../utils.js");

const backup = overrides => ({
  format: "rss-reader-backup",
  version: 1,
  createdAt: "2026-11-23T10:00:00.000Z",
  localStorage: { "rss-reader.feeds.v1": "[]" },
  indexedDB: { items: [], sync: [], highlights: [] },
  ...overrides
});

test("backup migration fills stores omitted by the previous schema", () => {
  const migrated = migrateBackupDocument({
    format: "rss-reader-backup",
    version: 0,
    localStorage: { "rss-reader.feeds.v1": "[]" },
    indexedDB: { items: [{ id: "article-1" }] }
  });
  assert.equal(migrated.version, 1);
  assert.deepEqual(migrated.indexedDB.sync, []);
  assert.deepEqual(migrated.indexedDB.highlights, []);
  assert.equal(migrated.indexedDB.items.length, 1);
});

test("backup validation rejects corrupt, duplicate, and unsupported data", () => {
  assert.throws(() => migrateBackupDocument(backup({
    localStorage: { "rss-reader.settings.v1": "{" }
  })), /invalid JSON/);
  assert.throws(() => migrateBackupDocument(backup({
    indexedDB: { items: [{ id: "x" }, { id: "x" }], sync: [], highlights: [] }
  })), /duplicate article IDs/);
  assert.throws(() => migrateBackupDocument(backup({ version: 99 })), /Unsupported backup version/);
});

test("backup merge keeps current conflicts and imports new records", () => {
  const current = {
    localStorage: {
      "rss-reader.settings.v1": JSON.stringify({ theme: "oled", fontSize: 18 }),
      "rss-reader.feeds.v1": JSON.stringify([{ id: "old", url: "https://feeds.test/a", title: "Current" }])
    },
    indexedDB: {
      items: [{ id: "article-1", title: "Current article" }],
      sync: [{ key: "feeds", value: "current" }],
      highlights: []
    }
  };
  const incoming = backup({
    localStorage: {
      "rss-reader.settings.v1": JSON.stringify({ theme: "dark", density: "compact" }),
      "rss-reader.feeds.v1": JSON.stringify([
        { id: "new", url: "https://feeds.test/a", title: "Backup duplicate" },
        { id: "other", url: "https://feeds.test/b", title: "New feed" }
      ])
    },
    indexedDB: {
      items: [{ id: "article-1", title: "Backup article" }, { id: "article-2", title: "New article" }],
      sync: [{ key: "feeds", value: "backup" }, { key: "settings", value: "backup" }],
      highlights: []
    }
  });
  const merged = mergeBackupDocument(current, incoming);
  assert.deepEqual(JSON.parse(merged.localStorage["rss-reader.settings.v1"]), {
    theme: "oled", density: "compact", fontSize: 18
  });
  const feeds = JSON.parse(merged.localStorage["rss-reader.feeds.v1"]);
  assert.equal(feeds.length, 2);
  assert.equal(feeds.find(x => x.url.endsWith("/a")).title, "Current");
  assert.equal(merged.indexedDB.items.find(x => x.id === "article-1").title, "Current article");
  assert.ok(merged.conflicts.total >= 3);
});

test("retention uses a strict age boundary and protects saved, queued, highlighted, and annotated articles", () => {
  const now = Date.UTC(2026, 10, 23);
  const published = days => new Date(now - days * 86400000).toISOString();
  const items = [
    { id: "old", published: published(31) },
    { id: "boundary", published: published(30) },
    { id: "recent", published: published(29) },
    { id: "saved", published: published(90), saved: true },
    { id: "queued", published: published(90), queued: true },
    { id: "highlight", published: published(90) },
    { id: "note", published: published(90) },
    { id: "snoozed", published: published(90), snoozeUntil: now + 1000 },
    { id: "pinned", published: published(90), pinned: true },
    { id: "invalid", published: "unknown" }
  ];
  const protectedIds = new Set(["highlight", "note"]);
  assert.deepEqual(getRetentionCandidates(items, 30, protectedIds, now).map(x => x.id), ["old"]);
  assert.deepEqual(getRetentionCandidates(items, 0, protectedIds, now), []);
});

test("feed scheduling inherits global intervals and applies bounded backoff", () => {
  const now = 1000;
  assert.equal(getFeedRefreshInterval({ refreshIntervalMinutes: 15 }, { refreshIntervalMinutes: 60 }), 15);
  assert.equal(getFeedRefreshInterval({ refreshIntervalMinutes: 0 }, { refreshIntervalMinutes: 30 }), 30);
  assert.equal(getFeedRefreshInterval({}, {}), 60);
  assert.equal(isFeedRefreshDue({ nextRefreshAt: now }, now), true);
  assert.equal(isFeedRefreshDue({ nextRefreshAt: now + 1 }, now), false);
  assert.equal(getFeedBackoffMinutes({ consecutiveFailures: 3 }, { refreshIntervalMinutes: 60 }), 480);
  assert.equal(getFeedBackoffMinutes({ consecutiveFailures: 12 }, { refreshIntervalMinutes: 60 }), 480);
});

test("feed health separates repeated failures, stale success, and recent success", () => {
  const now = 10_000_000_000;
  assert.equal(getFeedHealthState({ error: "timeout" }, now), "failing");
  assert.equal(getFeedHealthState({ lastError: "previous timeout", lastSuccess: now }, now), "healthy");
  assert.equal(getFeedHealthState({ consecutiveFailures: 2 }, now), "failing");
  assert.equal(getFeedHealthState({}, now), "stale");
  assert.equal(getFeedHealthState({ lastSuccess: now - 48 * 60 * 60 * 1000 }, now), "healthy");
  assert.equal(getFeedHealthState({ lastSuccess: now - 48 * 60 * 60 * 1000 - 1 }, now), "stale");
});

test("OPML folder paths preserve nested hierarchy", () => {
  assert.equal(getOpmlFolderPath(["World", "Technology", "Open source"]), "World / Technology / Open source");
  assert.equal(getOpmlFolderPath([" World ", "", "Local"]), "World / Local");
  assert.equal(getOpmlFolderPath([]), "");
});

test("annotation export selection retains only chosen highlights and notes", () => {
  const highlights = [{ id: "h1", itemId: "a", text: "one" }, { id: "h2", itemId: "b", text: "two" }];
  const notes = [{ itemId: "a", note: "note a" }, { itemId: "b", note: "note b" }];
  const selected = selectAnnotationEntries(highlights, notes, ["highlight:h2", "note:a"]);
  assert.deepEqual(selected.highlights.map(x => x.id), ["h2"]);
  assert.deepEqual(selected.notes.map(x => x.itemId), ["a"]);
  assert.equal(selectAnnotationEntries(highlights, notes).highlights.length, 2);
});

test("shortcut lookup uses the selected preset's bindings", () => {
  const inoreaderSave = getShortcutForAction("inoreader", ["save"]);
  assert.equal(inoreaderSave.action, "save");
  assert.ok(inoreaderSave.key);
  const minifluxPrefs = getShortcutForAction("miniflux", ["goPrefs"]);
  assert.equal(minifluxPrefs.key, "g s");
  assert.equal(getShortcutForAction("inoreader", ["queue"]), null);
});

test("shortcut coaching ignores keyboard, touch-only, disabled, dismissed, and cooldown cases", () => {
  const base = { trusted: true, detail: 1, pointerFine: true, enabled: true, action: "save", now: 100_000, lastShownAt: 0, cooldownSeconds: 60 };
  assert.equal(shouldShowShortcutCoach(base), true);
  assert.equal(shouldShowShortcutCoach({ ...base, trusted: false }), false);
  assert.equal(shouldShowShortcutCoach({ ...base, detail: 0 }), false);
  assert.equal(shouldShowShortcutCoach({ ...base, pointerFine: false }), false);
  assert.equal(shouldShowShortcutCoach({ ...base, enabled: false }), false);
  assert.equal(shouldShowShortcutCoach({ ...base, dismissed: ["save"] }), false);
  assert.equal(shouldShowShortcutCoach({ ...base, lastShownAt: 90_000 }), false);
});

test("reading activity uses local calendar days across midnight and daylight-saving changes", () => {
  const items = [
    { id: "before-midnight", feedId: "a", readAt: Date.UTC(2026, 2, 8, 7, 59) },
    { id: "after-midnight", feedId: "a", readAt: Date.UTC(2026, 2, 8, 8, 1) },
    { id: "after-dst-jump", feedId: "b", readAt: Date.UTC(2026, 2, 8, 10, 30) },
    { id: "future", feedId: "b", readAt: Date.UTC(2026, 2, 8, 12, 0) },
    { id: "legacy", feedId: "c", read: true }
  ];
  const now = Date.UTC(2026, 2, 8, 11, 0);
  const stats = calculateReadingActivity(items, 2, now, "America/Los_Angeles");
  assert.equal(stats.startKey, "2026-03-07");
  assert.equal(stats.todayKey, "2026-03-08");
  assert.deepEqual(stats.byDay, { "2026-03-07": 1, "2026-03-08": 2 });
  assert.equal(stats.total, 3);
  assert.equal(stats.activeDays, 2);
  assert.equal(stats.streak, 2);
  assert.equal(stats.mostActiveFeedId, "a");
  const oneDay = calculateReadingActivity(items, 1, now, "America/Los_Angeles");
  assert.deepEqual(oneDay.byDay, { "2026-03-08": 2 });
});
