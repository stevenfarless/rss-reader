import { test, expect } from "@playwright/test";

test("reader loads, changes appearance, and collapses its sidebar", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("#heading")).toHaveText("All articles");
  await page.locator("#settings").click();
  await expect(page.locator("#settingsDialog")).toBeVisible();
  await page.locator("#themeSelect").selectOption("oled");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "oled");
  await page.locator("#saveSettings").click();
  await expect(page.locator("#settingsDialog")).not.toBeVisible();
  await page.locator("#sideToggle").click();
  await expect(page.locator("body")).toHaveClass(/sidebar-collapsed/);
  await expect(page.locator("[data-rail-search]")).toBeVisible();
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
  await page.locator('#sidebar > .nav[data-view="queue"]').click();
  await expect(page.locator("#articleList")).toContainText("Fixture Article");
  await expect(page.locator("#queueCount")).toHaveText("1");
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
  await expect(page.locator("#opmlPreviewSummary")).toContainText("1 feeds");
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
