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

test("adding a deterministic feed persists its article and supports the reading queue", async ({ page }) => {
  await page.route("https://example.test/feed.xml", route => route.fulfill({
    status: 200,
    contentType: "application/rss+xml",
    body: "<?xml version=\"1.0\"?><rss version=\"2.0\"><channel><title>Fixture Feed</title><link>https://example.test/</link><description>Local fixture</description><item><title>Fixture Article</title><link>https://example.test/article</link><guid>fixture-1</guid><pubDate>Mon, 24 Nov 2025 12:00:00 GMT</pubDate><description>A deterministic article for browser testing.</description></item></channel></rss>"
  }));
  await page.goto("/");
  await page.locator("#add").click();
  await page.locator("#feedSearchInput").fill("https://example.test/feed.xml");
  await page.locator("#saveFeed").click();
  await expect(page.locator("#articleList")).toContainText("Fixture Article", { timeout: 15000 });
  await page.locator('[data-action="queue"]').click();
  await page.locator('[data-view="queue"]').first().click();
  await expect(page.locator("#articleList")).toContainText("Fixture Article");
  await expect(page.locator("#queueCount")).toHaveText("1");
});

test("complete backup export produces a versioned JSON download", async ({ page }) => {
  await page.goto("/");
  await page.locator("#settings").click();
  const downloadPromise = page.waitForEvent("download");
  await page.locator("#exportBackup").click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe("rss-reader-backup.json");
});
