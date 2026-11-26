import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const pwa = readFileSync(new URL("../pwa-install.js", import.meta.url), "utf8");

const settingIds = [
  "themeSelect", "widthSelect", "sizeSelect", "fontSelect", "lineHeightSelect",
  "progressSelect", "mobileBarSelect", "shortcutPresetSelect", "cardExcerptSelect",
  "cardImageToggle", "toolbarOrderList", "hideDuplicatesToggle",
  "shortcutCoachingToggle", "shortcutBarToggle", "globalRefreshMinutesSelect",
  "retentionDaysSelect", "retentionCountSelect", "backgroundSyncToggle",
  "notifyNewToggle", "exportBackup", "importBackup", "exportAnnotationsJSON",
  "exportAnnotationsMarkdown", "previewCleanup", "exportSettings", "importSettings",
  "importOpml", "exportOpml", "checkUpdates", "openFeedHealth", "openStats",
  "organize", "manageRules", "saveSettings"
];

test("settings are organized into five non-empty categories", () => {
  for (const [id, heading] of [
    ["appearance", "Appearance"], ["reading", "Reading"],
    ["feeds", "Feeds and updates"], ["data", "Data and privacy"],
    ["application", "Application"]
  ]) {
    const pattern = new RegExp('<section class="settings-section" id="settings-' + id +
      '"[\\s\\S]*?<h3[^>]*>' + heading + '<\\/h3>[\\s\\S]*?<\\/section>');
    assert.match(html, pattern, "missing or empty category: " + heading);
  }
});

test("every existing settings control remains available exactly once", () => {
  for (const id of settingIds) {
    assert.equal((html.match(new RegExp('id="' + id + '"', "g")) || []).length, 1,
      "expected one #" + id + " control");
  }
});

test("install guidance is anchored inside Application settings", () => {
  assert.match(html, /data-settings-install-anchor/);
  assert.match(pwa, /data-settings-install-anchor/);
  assert.match(pwa, /installAnchor\.append\(button\)/);
});

test("settings modal retains its labelled dialog and Done action", () => {
  assert.match(html, /<dialog id="settingsDialog" aria-labelledby="settingsDialogTitle">/);
  assert.match(html, /id="saveSettings" class="primary">Done/);
});
