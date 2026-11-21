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
