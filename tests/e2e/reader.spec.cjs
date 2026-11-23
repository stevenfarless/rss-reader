const { test, expect } = require("@playwright/test");
const fs = require("node:fs/promises");

const feedXml = `<?xml version="1.0"?>
<rss version="2.0"><channel>
  <title>Fixture Feed</title><link>https://publisher.test/</link>
  <description>Deterministic local test feed</description>
  <item><title>Fixture article one</title><link>https://publisher.test/article-one</link>
    <guid>fixture-article-one</guid><pubDate>Mon, 23 Nov 2026 08:00:00 GMT</pubDate>
    <description><![CDATA[<p>Fixture article body with <strong>safe markup</strong>.</p>]]></description>
  </item>
  <item><title>Fixture article two</title><link>https://publisher.test/article-two</link>
    <guid>fixture-article-two</guid><pubDate>Sun, 22 Nov 2026 08:00:00 GMT</pubDate>
    <description><![CDATA[<p>Second fixture article.</p>]]></description>
  </item>
</channel></rss>`;

async function interceptFixtureFeed(page) {
  await page.route("https://feeds.test/rss.xml", route => route.fulfill({
    status: 200,
    contentType: "application/rss+xml",
    headers: { "access-control-allow-origin": "*" },
    body: feedXml
  }));
}

async function addFixtureFeed(page) {
  await interceptFixtureFeed(page);
  await page.locator("#add").click();
  await page.locator("#feedSearchInput").fill("https://feeds.test/rss.xml");
  await page.locator("#saveFeed").click();
  await expect(page.locator("#feeds .feed-row")).toContainText("Fixture Feed");
  await expect(page.locator("#articleList [data-item]")).toHaveCount(2);
}

test("adds a deterministic feed and persists read, saved, queue, and theme state", async ({ page }) => {
  await page.goto("/");
  await addFixtureFeed(page);

  const firstArticle = page.locator("#articleList [data-item]").first();
  await firstArticle.click();
  await expect(page.locator("#reader")).toContainText("Fixture article one");

  await page.locator('#reader [data-reader="save"]').click();
  await expect(page.locator('#reader [data-reader="save"]')).toHaveAttribute("aria-pressed", "true");
  await page.locator('#reader [data-reader="queue"]').click();
  await expect(page.locator('#reader [data-reader="queue"]')).toHaveAttribute("aria-pressed", "true");

  await page.locator("#settings").click();
  await page.locator("#themeSelect").selectOption("oled");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "oled");
  await page.locator("#settingsDialog .x").click();

  await page.reload();
  await expect(page.locator("#feeds .feed-row")).toContainText("Fixture Feed");
  await page.locator("#libraryMore summary").click();
  await page.locator('#libraryMore [data-view="queue"]').click();
  await expect(page.locator("#articleList")).toContainText("Fixture article one");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "oled");
});

test("OPML import previews existing subscriptions and can be cancelled", async ({ page }) => {
  await page.goto("/");
  await addFixtureFeed(page);
  const opml = `<?xml version="1.0"?><opml version="2.0"><body>
    <outline text="News"><outline text="Fixture" type="rss" xmlUrl="https://feeds.test/rss.xml"/></outline>
    <outline text="News"><outline text="New feed" type="rss" xmlUrl="https://new-feed.test/rss.xml"/></outline>
  </body></opml>`;
  await page.locator("#opmlFile").setInputFiles({
    name: "subscriptions.opml",
    mimeType: "text/xml",
    buffer: Buffer.from(opml)
  });
  await expect(page.locator("#opmlPreviewDialog")).toBeVisible();
  await expect(page.locator("#opmlPreviewSummary")).toContainText("already subscribed");
  await page.locator('#opmlPreviewDialog button[value="cancel"]').click();
  await expect(page.locator("#opmlPreviewDialog")).not.toBeVisible();
  await expect(page.locator("#feeds .feed-row")).toHaveCount(1);
});

test("collapsed sidebar rail works on desktop and mobile sidebar remains usable", async ({ page }, testInfo) => {
  await page.goto("/");
  if (testInfo.project.name === "chromium-desktop") {
    await page.locator("#sideToggle").click();
    await expect(page.locator("body")).toHaveClass(/sidebar-collapsed/);
    await page.locator('#collapsedRail [data-view="unread"]').click();
    await expect(page.locator("#heading")).toContainText("Unread");
    await page.locator("#railSearch").click();
    await expect(page.locator("#search")).toBeFocused();
  } else {
    await page.locator("#menu").click();
    await expect(page.locator("#sidebar")).toHaveClass(/open/);
    await page.locator('#sidebar button.nav[data-view="unread"]').click();
    await expect(page.locator("#heading")).toContainText("Unread");
    const dimensions = await page.evaluate(() => ({
      viewport: document.documentElement.clientWidth,
      content: document.documentElement.scrollWidth
    }));
    expect(dimensions.content).toBeLessThanOrEqual(dimensions.viewport + 1);
  }
});

test("service worker installs and the reader shell can start offline", async ({ page, context }, testInfo) => {
  test.skip(testInfo.project.name === "chromium-mobile", "Service-worker offline startup is covered on desktop Chromium.");
  await page.goto("/");
  await page.evaluate(async () => {
    if (!("serviceWorker" in navigator)) throw new Error("Service workers unavailable");
    await navigator.serviceWorker.ready;
  });
  await page.reload();
  await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);
  await context.setOffline(true);
  await page.reload();
  await expect(page.locator("#sidebar")).toBeVisible();
  await context.setOffline(false);
});

test("shortcut coaching follows the active preset and respects suppression", async ({ page }, testInfo) => {
  await page.goto("/");
  await page.locator("#refresh").click();
  if (testInfo.project.name === "chromium-mobile") {
    await expect(page.locator("#shortcutCoach")).toBeHidden();
    return;
  }
  await expect(page.locator("#shortcutCoach")).toBeVisible();
  await expect(page.locator("#shortcutCoachText")).toContainText("Refresh all feeds");
  await expect(page.locator("#shortcutCoachText")).toContainText("r");
  await page.locator("#shortcutCoachNever").click();
  await expect(page.locator("#shortcutCoach")).toBeHidden();
  await page.locator("#refresh").click();
  await expect(page.locator("#shortcutCoach")).toBeHidden();
});

test("queue supports reordering, selection, and bulk read/remove actions", async ({ page }) => {
  await page.goto("/");
  await addFixtureFeed(page);
  const cards = page.locator("#articleList [data-item]");
  await cards.nth(0).locator('[data-action="queue"]').click();
  await cards.nth(1).locator('[data-action="queue"]').click();
  await page.locator("#libraryMore summary").click();
  await page.locator('#libraryMore [data-view="queue"]').click();
  await expect(page.locator("#articleList [data-queue-select]")).toHaveCount(2);
  await page.locator("#articleList [data-action='queue-up']").last().click();
  await page.locator('#queueBulkBar [data-queue-bulk="select-all"]').click();
  await expect(page.locator("#queueBulkBar")).toContainText("2 selected");
  await page.locator('#queueBulkBar [data-queue-bulk="read"]').click();
  await expect(page.locator("#articleList [data-action='read'][aria-pressed='true']")).toHaveCount(2);
  await page.locator('#queueBulkBar [data-queue-bulk="select-all"]').click();
  await page.locator('#queueBulkBar [data-queue-bulk="remove"]').click();
  await expect(page.locator("#queueCount")).toHaveText("0");
  await expect(page.locator("#articleList")).toContainText("No articles");
});

test("complete backup can be exported, previewed, and restored", async ({ page }) => {
  await page.goto("/");
  await addFixtureFeed(page);
  await page.locator("#settings").click();
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.locator("#exportBackup").click()
  ]);
  const buffer = await fs.readFile(await download.path());
  await page.locator("#backupFile").setInputFiles({
    name: "reader-backup.json",
    mimeType: "application/json",
    buffer
  });
  await expect(page.locator("#backupRestoreDialog")).toBeVisible();
  await expect(page.locator("#backupRestoreSummary")).toContainText("2 articles");
  await page.locator("#backupRestoreMode").selectOption("merge");
  await page.locator("#backupRestoreConfirm").click();
  await expect(page.locator("#feeds .feed-row")).toContainText("Fixture Feed");
});

test("annotation export selection dialog handles an empty library safely", async ({ page }) => {
  await page.goto("/");
  await page.locator("#settings").click();
  await page.locator("#selectAnnotations").click();
  await expect(page.locator("#annotationExportDialog")).toBeVisible();
  await expect(page.locator("#annotationExportList")).toContainText("no highlights or notes");
  await page.locator('#annotationExportDialog button[value="cancel"]').click();
  await expect(page.locator("#annotationExportDialog")).not.toBeVisible();
});

test("nested OPML folder hierarchy is previewed and imported", async ({ page }) => {
  await page.goto("/");
  await page.route("https://nested-feed.test/rss.xml", route => route.fulfill({
    status: 200,
    contentType: "application/rss+xml",
    headers: { "access-control-allow-origin": "*" },
    body: feedXml
  }));
  const opml = `<?xml version="1.0"?><opml version="2.0"><body>
    <outline text="Technology"><outline text="Local"><outline text="Nested feed" type="rss" xmlUrl="https://nested-feed.test/rss.xml"/></outline></outline>
  </body></opml>`;
  await page.locator("#opmlFile").setInputFiles({
    name: "nested.opml",
    mimeType: "text/xml",
    buffer: Buffer.from(opml)
  });
  await expect(page.locator("#opmlPreviewDialog")).toBeVisible();
  await expect(page.locator("#opmlPreviewDetails")).toContainText("Technology / Local");
  await page.locator("#opmlPreviewConfirm").click();
  await expect(page.locator("#feeds")).toContainText("Technology / Local");
  await expect(page.locator("#feeds")).toContainText("Fixture Feed");
});
