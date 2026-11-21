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
  assert.match(html, /id="vimNavigationToggle"/);
  assert.match(app, /handleVimNavigation/);
  assert.match(app, /vimPane/);
  assert.match(css, /vim-navigation-enabled/);
});
