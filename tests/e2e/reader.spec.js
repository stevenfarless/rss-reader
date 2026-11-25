import { test, expect } from "@playwright/test";

test("reader loads, changes appearance, and collapses its sidebar", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("#heading")).toHaveText("All articles");
  await page.locator("#settings").click();
  await expect(page.locator("#settingsDialog")).toBeVisible();
  await expect(page.locator("#settingsDialog")).toBeFocused();
  await page.locator("#themeSelect").selectOption("oled");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "oled");
  await page.locator("#saveSettings").click();
  await expect(page.locator("#settingsDialog")).not.toBeVisible();
  await page.locator("#sideToggle").click();
  await expect(page.locator("body")).toHaveClass(/sidebar-collapsed/);
  await expect(page.locator("[data-rail-search]")).toBeVisible();
});

test("collapsing the sidebar shifts the article list and reader left without widening the list", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.addInitScript(() => {
    localStorage.setItem("rss-reader.settings.v1", JSON.stringify({ sidebarWidth: 250, listWidth: 400 }));
  });
  await page.goto("/");
  const list = page.locator(".list-pane");
  const reader = page.locator("#reader");
  const beforeList = await list.boundingBox();
  const beforeReader = await reader.boundingBox();
  await page.locator("#sideToggle").click();
  await expect(page.locator("body")).toHaveClass(/sidebar-collapsed/);
  const afterList = await list.boundingBox();
  const afterReader = await reader.boundingBox();
  expect(afterList.x).toBeLessThan(beforeList.x - 150);
  expect(afterList.width).toBeCloseTo(beforeList.width, 0);
  expect(afterReader.x).toBeLessThan(beforeReader.x - 150);
  expect(afterReader.width).toBeGreaterThan(beforeReader.width + 100);
  expect(await page.locator(".layout").evaluate(el => el.scrollWidth)).toBeLessThanOrEqual(await page.locator(".layout").evaluate(el => el.clientWidth));
});

test("the article list can be resized narrower after the sidebar collapses", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.addInitScript(() => {
    localStorage.setItem("rss-reader.settings.v1", JSON.stringify({
      sidebarWidth: 250,
      listWidth: 400
    }));
  });
  await page.goto("/");
  await page.locator("#sideToggle").click();
  await expect(page.locator("body")).toHaveClass(/sidebar-collapsed/);

  const list = page.locator(".list-pane");
  const splitter = page.locator("#splitList");
  const before = await list.evaluate(el => el.getBoundingClientRect().width);
  const handle = await splitter.boundingBox();
  expect(handle).not.toBeNull();

  await page.mouse.move(handle.x + handle.width / 2, handle.y + 300);
  await page.mouse.down();
  await page.mouse.move(handle.x + handle.width / 2 - 250, handle.y + 300, { steps: 10 });
  await page.mouse.up();

  const after = await list.evaluate(el => el.getBoundingClientRect().width);
  const reader = await page.locator("#reader").evaluate(el => el.getBoundingClientRect());
  expect(after).toBeLessThan(before - 100);
  expect(after).toBeGreaterThanOrEqual(280);
  expect(reader.width).toBeGreaterThan(320);
  expect(await list.evaluate(el => getComputedStyle(el.parentElement).gridTemplateColumns))
    .not.toContain("478px");
});

test("shortcut coaching stays disabled on mobile while remaining enabled on desktop", async ({ browser }) => {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    serviceWorkers: "block"
  });
  const page = await context.newPage();
  await page.addInitScript(() => {
    localStorage.setItem("rss-reader.settings.v1", JSON.stringify({
      shortcutCoaching: true
    }));
  });
  await page.goto("http://127.0.0.1:4173/");
  await page.locator("#mobileAdd").click();
  await expect(page.locator("#feedDialog")).toBeVisible();
  await expect(page.locator("#shortcutCoach")).not.toBeVisible();
  await page.locator("#feedDialog .x").click();

  await page.setViewportSize({ width: 1280, height: 800 });
  await page.locator("#add").click();
  await expect(page.locator("#shortcutCoach")).toContainText("Add feed");
  await expect(page.locator("#shortcutCoach")).toContainText("Shortcut: a");
  await context.close();
});

test("secondary navigation can be expanded and queue view is reachable", async ({ page }) => {
  await page.goto("/");
  await page.locator("#libraryMore summary").click();
  await expect(page.locator("#libraryMore")).toHaveAttribute("open", "");
  await page.locator('#sidebar > .nav[data-view="queue"]').click();
  await expect(page.locator("#heading")).toHaveText("Reading queue");
});

test("reading queue persists article ordering in the local library", async ({ page }) => {
  await page.goto("/");
  await page.evaluate(async () => {
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open("rss-reader-cache");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    await new Promise((resolve, reject) => {
      const tx = db.transaction("items", "readwrite");
      tx.objectStore("items").put({
        id: "fixture-article",
        feedId: "fixture-feed",
        title: "Fixture Article",
        url: "https://example.test/article",
        published: new Date().toISOString(),
        content: "A deterministic article for browser testing.",
        summary: "A deterministic article for browser testing.",
        read: false,
        saved: false,
        queued: false,
        queueOrder: 0,
        tags: []
      });
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
    localStorage.setItem("rss-reader.feeds.v1", JSON.stringify([{
      id: "fixture-feed",
      url: "https://example.test/feed.xml",
      title: "Fixture Feed",
      site: "https://example.test/",
      added: new Date().toISOString(),
      lastAttempt: Date.now(),
      lastSuccess: Date.now(),
      error: "",
      via: "direct",
      wpRoot: "",
      group: ""
    }]));
    db.close();
  });
  await page.reload();
  await expect(page.locator("#articleList")).toContainText("Fixture Article");
  await page.locator('[data-action="queue"]').click();
  await expect(page.locator("#queueCount")).toHaveText("1");
  await page.locator('[data-item="fixture-article"]').click();
  await page.locator('#reader [data-reader="queue"]').click();
  await expect(page.locator("#queueCount")).toHaveText("0");
  await page.locator('#reader [data-reader="queue"]').click();
  await expect(page.locator("#queueCount")).toHaveText("1");
  await page.locator('#sidebar > .nav[data-view="queue"]').click();
  await expect(page.locator("#articleList")).toContainText("Fixture Article");
  await page.locator("#removeQueue").click();
  await expect(page.locator("#queueCount")).toHaveText("0");
});

test("OPML preview selects every new feed by default and supports individual selection", async ({ page }) => {
  await page.goto("/");
  await page.locator("#settings").click();
  await page.locator("#opmlFile").setInputFiles({
    name: "selection.opml",
    mimeType: "text/xml",
    buffer: Buffer.from('<?xml version="1.0"?><opml version="2.0"><body><outline text="Tech"><outline text="One" type="rss" xmlUrl="https://one.example/feed.xml"/><outline text="Two" type="rss" xmlUrl="https://two.example/feed.xml"/></outline></body></opml>')
  });
  await expect(page.locator("#opmlPreviewDialog")).toBeVisible();
  const feeds = page.locator("#opmlFeedSelection input[data-opml-feed]");
  await expect(feeds).toHaveCount(2);
  await expect(feeds.nth(0)).toBeChecked();
  await expect(feeds.nth(1)).toBeChecked();
  await page.locator("#opmlSelectNone").click();
  await expect(page.locator("#opmlPreviewConfirm")).toBeDisabled();
  await feeds.nth(1).check();
  await expect(page.locator("#opmlPreviewConfirm")).toBeEnabled();
  await expect(page.locator("#opmlPreviewConfirm")).toHaveText("Import 1 feed");
  await page.locator("#opmlPreviewCancel").click();
});

test("OPML import displays a preview before changing subscriptions", async ({ page }) => {
  await page.goto("/");
  await page.locator("#settings").click();
  await page.locator("#opmlFile").setInputFiles({
    name: "fixture.opml",
    mimeType: "text/xml",
    buffer: Buffer.from('<?xml version="1.0"?><opml version="2.0"><body><outline text="Example" title="Example"><outline text="Fixture" title="Fixture" type="rss" xmlUrl="https://example.test/feed.xml"/></outline></body></opml>')
  });
  await expect(page.locator("#opmlPreviewDialog")).toBeVisible();
  await expect(page.locator("#opmlPreviewSummary")).toContainText("1 feed entry");
  await page.locator("#opmlPreviewCancel").click();
  await expect(page.locator("#opmlPreviewDialog")).not.toBeVisible();
});

test("complete backup export produces a versioned JSON download", async ({ page }) => {
  await page.goto("/");
  await page.locator("#settings").click();
  const downloadPromise = page.waitForEvent("download");
  await page.locator("#exportBackup").click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe("rss-reader-backup.json");
});

test("shortcut coaching and statistics are available from settings", async ({ page }) => {
  await page.goto("/");
  await page.locator("#settings").click();
  await page.locator("#shortcutCoachingToggle").check();
  await page.locator("#saveSettings").click();
  await page.locator("#add").click();
  await expect(page.locator("#shortcutCoach")).toContainText("Add feed");
  await expect(page.locator("#shortcutCoach")).toContainText("Shortcut: a");
  await page.locator("#feedDialog .x").click();

  await page.locator("#settings").click();
  // Clear the previous valid suggestion, then verify an action without a
  // shortcut leaves the coach empty.
  await page.locator("#shortcutCoach").evaluate(el => {
    el.textContent = "";
    el.classList.remove("show");
  });
  await page.locator("#openStats").click();
  await expect(page.locator("#statsDialog")).toBeVisible();
  await expect(page.locator("#shortcutCoach")).toBeEmpty();
  await page.locator("#statsRange").selectOption("7");
  await expect(page.locator("#statsBody")).toContainText("the last 7 days");
});

test("adding a feed through the address form creates a subscription", async ({ page }) => {
  await page.route("**/*", async route => {
    const url = new URL(route.request().url());
    if (url.hostname === "example.test" && url.pathname === "/feed.xml") {
      await route.fulfill({
        status: 200,
        headers: { "access-control-allow-origin": "*" },
        contentType: "application/rss+xml",
        body: "<?xml version=\"1.0\"?><rss version=\"2.0\"><channel><title>Address Fixture</title><link>https://example.test/</link><description>Fixture feed</description></channel></rss>"
      });
      return;
    }
    await route.continue();
  });

  await page.goto("/");
  await page.locator("#add").click();
  await page.locator("#feedSearchInput").fill("https://example.test/feed.xml");
  await page.locator("#saveFeed").click();
  await expect(page.locator("#feeds")).toContainText("Address Fixture", { timeout: 15000 });
  await expect(page.locator("#feedDialog")).not.toBeVisible();
});

test("feed health report identifies stale subscriptions", async ({ page }) => {
  await page.goto("/");
  await page.evaluate(() => {
    localStorage.setItem("rss-reader.feeds.v1", JSON.stringify([{
      id: "stale-feed",
      url: "https://example.test/stale.xml",
      title: "Stale Fixture",
      site: "https://example.test/",
      added: new Date().toISOString(),
      lastAttempt: Date.now(),
      lastSuccess: Date.now() - 3 * 60 * 60 * 1000,
      refreshMinutes: 15,
      error: "",
      via: "direct",
      wpRoot: "",
      group: ""
    }]));
  });
  await page.reload();
  await page.locator("#settings").click();
  await page.locator("#openFeedHealth").click();
  await expect(page.locator("#feedHealthDialog")).toContainText("Stale Fixture");
  await expect(page.locator("#feedHealthDialog")).toContainText("Stale");
  await page.locator("#feedHealthDone").click();
});

test("retention cleanup preserves saved and queued articles", async ({ page }) => {
  await page.goto("/");
  await page.evaluate(async () => {
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open("rss-reader-cache");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    await new Promise((resolve, reject) => {
      const tx = db.transaction("items", "readwrite");
      const store = tx.objectStore("items");
      const base = {
        feedId: "retention-feed",
        url: "https://example.test/article",
        published: "2020-01-01T00:00:00.000Z",
        content: "Old content",
        summary: "Old content",
        read: false,
        queued: false,
        saved: false,
        tags: []
      };
      store.put({ ...base, id: "old-ordinary", title: "Old ordinary article" });
      store.put({ ...base, id: "old-saved", title: "Old saved article", saved: true });
      store.put({ ...base, id: "old-queued", title: "Old queued article", queued: true, queueOrder: 1 });
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
    localStorage.setItem("rss-reader.feeds.v1", JSON.stringify([{
      id: "retention-feed",
      url: "https://example.test/feed.xml",
      title: "Retention Fixture",
      site: "https://example.test/",
      added: new Date().toISOString(),
      lastAttempt: Date.now(),
      lastSuccess: Date.now(),
      error: "",
      via: "direct",
      wpRoot: "",
      group: ""
    }]));
    db.close();
  });
  await page.reload();
  await page.locator("#settings").click();
  await expect(page.locator("#settingsDialog")).toBeVisible();
  await page.locator("#retentionDaysSelect").selectOption("30");
  page.once("dialog", dialog => dialog.accept());
  await page.locator("#previewCleanup").scrollIntoViewIfNeeded();
  await page.locator("#previewCleanup").click();
  await page.locator("#saveSettings").click();
  const remainingIds = await page.evaluate(async () => {
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open("rss-reader-cache");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const records = await new Promise((resolve, reject) => {
      const tx = db.transaction("items", "readonly");
      const request = tx.objectStore("items").getAll();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    db.close();
    return records.map(item => item.id);
  });
  expect(remainingIds).not.toContain("old-ordinary");
  expect(remainingIds).toContain("old-saved");
  expect(remainingIds).toContain("old-queued");
});

test("invalid profile backups are rejected before changing local data", async ({ page }) => {
  await page.goto("/");
  await page.locator("#settings").click();
  await page.locator("#backupFile").setInputFiles({
    name: "broken-backup.json",
    mimeType: "application/json",
    buffer: Buffer.from('{"format":"rss-reader-backup","version":999}')
  });
  await expect(page.locator("#toast")).toContainText("Backup validation failed");
  await expect(page.locator("#settingsDialog")).toBeVisible();
});

test("narrow mobile viewport keeps the reader within the screen", async ({ browser }) => {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    serviceWorkers: "block"
  });
  const page = await context.newPage();
  await page.goto("http://127.0.0.1:4173/", { waitUntil: "domcontentloaded", timeout: 10000 });
  await expect(page.locator("#heading")).toBeVisible({ timeout: 10000 });
  const dimensions = await page.evaluate(() => ({
    viewport: document.documentElement.clientWidth,
    document: document.documentElement.scrollWidth
  }));
  expect(dimensions.document).toBeLessThanOrEqual(dimensions.viewport);
  await context.close();
});

test("service worker installs and serves the shell after network loss", async ({ browser }) => {
  const context = await browser.newContext({ serviceWorkers: "allow" });
  const page = await context.newPage();
  await page.goto("http://127.0.0.1:4173/");
  await page.evaluate(() => navigator.serviceWorker.ready.then(() => true));
  await expect(page.locator("#heading")).toHaveText("All articles");
  await context.setOffline(true);
  await page.reload();
  await expect(page.locator("#heading")).toHaveText("All articles");
  await context.setOffline(false);
  await context.close();
});

test("backup restore can replace the existing profile", async ({ page }) => {
  await page.goto("/");
  await page.evaluate(() => localStorage.setItem("rss-reader.feeds.v1", JSON.stringify([{
    id: "existing-feed",
    url: "https://existing.test/feed.xml",
    title: "Existing Feed",
    site: "https://existing.test/",
    added: new Date().toISOString(),
    lastAttempt: Date.now(),
    lastSuccess: Date.now(),
    error: "",
    via: "direct",
    wpRoot: "",
    group: ""
  }])));
  await page.reload();
  await page.locator("#settings").click();
  page.once("dialog", dialog => dialog.accept());
  await page.locator("#backupFile").setInputFiles({
    name: "replace-backup.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify({
      format: "rss-reader-backup",
      version: 1,
      profile: { feeds: [], settings: {} },
      items: [],
      highlights: []
    }))
  });
  await page.waitForFunction(() => JSON.parse(localStorage.getItem("rss-reader.feeds.v1") || "[]").length === 0);
  const restoredFeeds = await page.evaluate(() => JSON.parse(localStorage.getItem("rss-reader.feeds.v1") || "[]"));
  expect(restoredFeeds).toHaveLength(0);
});

test("backup restore can merge subscriptions without replacing the current profile", async ({ page }) => {
  await page.goto("/");
  await page.evaluate(() => localStorage.setItem("rss-reader.feeds.v1", JSON.stringify([{
    id: "existing-feed",
    url: "https://existing.test/feed.xml",
    title: "Existing Feed",
    site: "https://existing.test/",
    added: new Date().toISOString(),
    lastAttempt: Date.now(),
    lastSuccess: Date.now(),
    error: "",
    via: "direct",
    wpRoot: "",
    group: ""
  }])));
  await page.reload();
  await page.locator("#settings").click();
  let prompt = 0;
  page.on("dialog", dialog => {
    if (prompt++ === 0) dialog.dismiss();
    else dialog.accept();
  });
  await page.locator("#backupFile").setInputFiles({
    name: "merge-backup.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify({
      format: "rss-reader-backup",
      version: 1,
      profile: {
        feeds: [{
          id: "backup-feed",
          url: "https://backup.test/feed.xml",
          title: "Backup Feed",
          site: "https://backup.test/",
          added: new Date().toISOString(),
          lastAttempt: Date.now(),
          lastSuccess: Date.now(),
          error: "",
          via: "direct",
          wpRoot: "",
          group: ""
        }],
        settings: {}
      },
      items: [],
      highlights: []
    }))
  });
  await page.waitForFunction(() => {
    const feeds = JSON.parse(localStorage.getItem("rss-reader.feeds.v1") || "[]");
    return feeds.some(feed => feed.title === "Existing Feed") && feeds.some(feed => feed.title === "Backup Feed");
  });
  const restoredFeeds = await page.evaluate(() => JSON.parse(localStorage.getItem("rss-reader.feeds.v1") || "[]"));
  expect(restoredFeeds.map(feed => feed.title)).toEqual(expect.arrayContaining(["Existing Feed", "Backup Feed"]));
});
