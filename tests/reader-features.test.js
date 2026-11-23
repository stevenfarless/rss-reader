import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
const app = readFileSync(new URL("../app.js", import.meta.url), "utf8");
const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const css = readFileSync(new URL("../styles.css", import.meta.url), "utf8");
test("full article loading and per-feed mode", () => {
  assert.match(app, /loadingFullTextIds/);
  assert.match(app, /fulltext-active/);
  assert.match(app, /book-open/);
  assert.match(app, /Always fetch/);
  assert.match(app, /Use RSS text/);
  assert.match(css, /reader-spinner/);
});
test("folder hierarchy styling", () => {
  assert.match(app, /nested-feed/);
  assert.match(css, /folder-feeds \.feed-row-wrap\.nested-feed/);
  assert.match(css, /folder-head \.folder-open/);
});
test("single-row reader header and overflow menu", () => {
  assert.match(app, /setupReaderToolbarOverflow/);
  assert.match(app, /data-reader-more/);
  assert.match(css, /text-overflow:ellipsis/);
  assert.match(css, /flex-wrap:nowrap/);
});
test("Vim-like navigation is optional and persistent", () => {
  assert.match(html, /<option value="vim">Vim<\/option>/);
  assert.match(app, /handleVimNavigation/);
  assert.match(app, /vimPane/);
  assert.match(app, /shortcutPreset\(\) === "vim"/);
  assert.match(html, /id="shortcutHelp"/);
  assert.match(app, /shortcutHelp.*showHelp/);
  assert.match(css, /vim-navigation-enabled/);
});

test("Vim is a keyboard shortcut preset", () => {
  const utils = readFileSync(new URL("../utils.js", import.meta.url), "utf8");
  assert.match(utils, /PRESETS\.vim = \{ name: "Vim"/);
  assert.match(html, /id="shortcutPresetSelect"[^]*<option value="vim">Vim<\/option>/);
  assert.doesNotMatch(html, /vimNavigationToggle/);
});


test("disclosure chevrons animate from their accessible expanded state", () => {
  assert.ok(app.includes('class="folder-chevron" aria-hidden="true">▾</span>'));
  assert.ok(app.includes('aria-expanded="${!collapsed}"'));
  assert.ok(app.includes('saveCollapsedFolders();'));
  assert.ok(app.includes('renderNav();'));
  assert.ok(app.includes('setAttribute("aria-expanded", String(!collapsed))'));
  assert.ok(html.includes('class="disclosure-chevron" aria-hidden="true">▾</span>'));
  assert.ok(app.includes('querySelector(".disclosure-label").textContent'));
  assert.ok(css.includes("transition: transform .2s"));
  assert.ok(css.includes('[aria-expanded="true"] > .disclosure-chevron'));
  assert.ok(css.includes('.folder-toggle[aria-expanded="false"] .folder-chevron'));
  assert.ok(css.includes("@media(prefers-reduced-motion:reduce){*{transition:none!important;animation:none!important}}"));
});


test("mobile bottom reading progress stays on the viewport edge", () => {
  assert.ok(css.includes("#readProgress.bottom{position:fixed;left:0;right:0;bottom:env(safe-area-inset-bottom);margin:0;z-index:31}"));
  assert.ok(!css.includes("#readProgress.bottom{bottom:calc(56px + env(safe-area-inset-bottom))}"));
  assert.ok(css.includes("body:not(.mobile-bar-top) .reader-actions{position:fixed;left:0;right:0;bottom:0;z-index:30"));
});

test("OLED and pure white themes are selectable",()=>{assert.match(html,/option value="oled"/);assert.match(html,/option value="white"/);assert.match(css,/data-theme=oled[^]*--bg:#000000/);assert.match(css,/data-theme=white[^]*--bg:#ffffff/)});
test("sidebar secondary navigation and compact rail are present",()=>{assert.match(html,/id="libraryMore"/);assert.match(html,/id="collapsedRail"/);assert.match(css,/folder-head\.collapsed/)});
test("feed refresh diagnostics retain success and failure history",()=>{assert.match(app,/consecutiveFailures/);assert.match(app,/lastSuccess/);assert.match(app,/lastAttempt/)});
test("folder list header omits repeated folder subtitle",()=>{assert.match(app,/state\.view === "folder" \? ""/)});

test("complete backup validates and restores all application stores",()=>{assert.match(app,/function validateBackup\(/);assert.match(app,/BACKUP_STORES = \["items", "sync", "highlights"\]/);assert.match(app,/function restorePendingBackup\(/);assert.match(html,/id="backupRestoreMode"/)});
test("OPML import previews duplicates before mutation",()=>{assert.match(app,/async function previewOPML\(/);assert.match(app,/repeated/);assert.match(html,/id="opmlPreviewConfirm"/)});
test("reading queue is separate from saved and read state",()=>{assert.match(app,/async function toggleQueue\(/);assert.match(app,/queueOrder/);assert.match(app,/state.view === "queue"/);assert.match(html,/data-view="queue"/)});
test("annotations can be exported as JSON and Markdown",()=>{assert.match(app,/function exportAnnotations\(/);assert.match(html,/id="exportAnnotationsJson"/);assert.match(html,/id="exportAnnotationsMarkdown"/)});

test("secondary library views remain grouped and the rail includes next unread",()=>{assert.match(html,/id="libraryMore"[^]*data-view="queue"[^]*data-view="saved"/);assert.match(html,/id="railNextUnread"/);assert.match(app,/collapsedRail \[data-view\]/)});
test("cleanup preview and reading activity controls are available",()=>{assert.match(html,/id="cleanupPreview"/);assert.match(html,/id="statsRange"/);assert.match(app,/function updateStorageEstimate\(/);assert.match(app,/function updateReadingStats\(/)});
test("modal pointer focus decoration is suppressed while keyboard focus remains styled",()=>{assert.match(css,/dialog :focus:not\(:focus-visible\)/);assert.match(css,/:focus-visible/)});
