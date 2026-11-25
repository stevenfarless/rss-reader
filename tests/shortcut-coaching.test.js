import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  PRESETS,
  findShortcutForAction,
  isShortcutCoachPointerEvent,
  canShowShortcutCoach
} = require("../utils.js");

test("shortcut lookup follows the active preset instead of a duplicate mapping", () => {
  assert.equal(findShortcutForAction("inoreader", "save"), "s");
  assert.equal(findShortcutForAction("feedly", "save"), "s");
  assert.equal(findShortcutForAction("inoreader", "folderToggle"), "Shift+x");
  assert.equal(findShortcutForAction("feedbin", "folderToggle"), "e");
  assert.equal(findShortcutForAction("inoreader", "toggleRead"), "m");
  assert.equal(findShortcutForAction("unknown", "save"), null);
  assert.equal(findShortcutForAction("inoreader", "notAnAction"), null);
  assert.equal(findShortcutForAction("inoreader", "save"), Object.entries(PRESETS.inoreader.keys).find(([, action]) => action === "save")[0]);
});

test("coaching accepts trusted mouse and pen activations", () => {
  const activation = { type: "mouse", at: 1000, isTrusted: true };
  assert.equal(isShortcutCoachPointerEvent({ isTrusted: true, detail: 1 }, activation, 1100), true);
  assert.equal(isShortcutCoachPointerEvent({ isTrusted: true, detail: 1 }, { ...activation, type: "pen" }, 1100), true);
});

test("coaching excludes touch, keyboard, synthetic, stale, and invalid activations", () => {
  const event = { isTrusted: true, detail: 1 };
  const base = { type: "mouse", at: 1000, isTrusted: true };
  assert.equal(isShortcutCoachPointerEvent(event, { ...base, type: "touch" }, 1100), false);
  assert.equal(isShortcutCoachPointerEvent({ isTrusted: true, detail: 0 }, base, 1100), false);
  assert.equal(isShortcutCoachPointerEvent({ isTrusted: false, detail: 1 }, base, 1100), false);
  assert.equal(isShortcutCoachPointerEvent(event, { ...base, isTrusted: false }, 1100), false);
  assert.equal(isShortcutCoachPointerEvent(event, base, 2201), false);
  assert.equal(isShortcutCoachPointerEvent(event, { ...base, at: 1200 }, 1100), false);
  assert.equal(isShortcutCoachPointerEvent(event, null, 1100), false);
});

test("coaching cooldown deduplicates actions and limits overall notification frequency", () => {
  const lastShown = new Map([["save", 1000]]);
  assert.equal(canShowShortcutCoach("save", lastShown, 1000, 2000), false);
  assert.equal(canShowShortcutCoach("read", lastShown, 1000, 2000), false);
  assert.equal(canShowShortcutCoach("read", lastShown, 1000, 4000), true);
  assert.equal(canShowShortcutCoach("save", lastShown, 1000, 62000), true);
  assert.equal(canShowShortcutCoach("", lastShown, 1000, 62000), false);
});

test("app wires coaching to pointer-originated clicks and the persisted setting", async () => {
  const { readFile } = await import("node:fs/promises");
  const app = await readFile(new URL("../app.js", import.meta.url), "utf8");
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
  assert.match(app, /pointerdown[\s\S]*pointerActivation/);
  assert.match(app, /click", e => coachShortcut\(e\)/);
  assert.match(app, /isShortcutCoachPointerEvent\(e, pointerActivation\)/);
  assert.match(app, /findShortcutForAction\(presetName, action\)/);
  assert.match(app, /canShowShortcutCoach\(action, coachLastShown/);
  assert.match(app, /shortcut-coach-suppressed\.v1/);
  assert.match(html, /id="shortcutCoachingToggle"/);\n  assert.match(html, /id="shortcutCoach"[^>]*aria-live="polite"/);\n  assert.match(app, /const el = \$\("#shortcutCoach"\)/);\n  assert.doesNotMatch(app, /function showShortcutCoach[\\s\\S]*?\$\("#toast"\)/);
});
