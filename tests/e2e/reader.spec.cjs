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


async function clickReaderAction(page, action) {
  const direct = page.locator(`#reader .reader-actions > [data-reader="${action}"]`);
  if (await direct.isVisible()) return direct.click();
  await page.locator("#reader [data-reader-more]").click();
  await page.locator(`#reader .reader-overflow .menu [data-reader="${action}"]`).click();
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

  await clickReaderAction(page, "save");
  await expect(page.locator('#reader [data-reader="save"]')).toHaveAttribute("aria-pressed", "true");
  await clickReaderAction(page, "queue");
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
    <outline text="Broken feed" type="rss" xmlUrl="not-a-valid-feed-url"/>
  </body></opml>`;
  await page.locator("#opmlFile").setInputFiles({
    name: "subscriptions.opml",
    mimeType: "text/xml",
    buffer: Buffer.from(opml)
  });
  await expect(page.locator("#opmlPreviewDialog")).toBeVisible();
  await expect(page.locator("#opmlPreviewSummary")).toContainText("already subscribed");
  await expect(page.locator("#opmlPreviewSummary")).toContainText("1 invalid entries");
  await expect(page.locator("#opmlPreviewDetails")).toContainText("Broken feed");
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
  await page.reload();
  await expect(page.locator("#sidebar")).toBeVisible();
  const cacheNames = await page.evaluate(() => caches.keys());
  expect(cacheNames.some(name => name.startsWith("rss-reader-shell-v"))).toBe(true);
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

test("feed can be renamed and unsubscribed without removing unrelated subscriptions", async ({ page }) => {
  await page.goto("/");
  await addFixtureFeed(page);
  await page.locator("#feeds [data-feed-opts]").first().click();
  await page.locator('#feedMenu [data-feed-opt="rename"]').click();
  await expect(page.locator("#feedRenameDialog")).toBeVisible();
  await page.locator("#feedRenameInput").fill("Renamed fixture");
  await page.locator("#feedRenameSave").click();
  await expect(page.locator("#feeds")).toContainText("Renamed fixture");
  await page.locator("#feeds [data-unsub]").first().click();
  await page.locator("#feeds [data-unsub].armed").first().click();
  await expect(page.locator("#feeds .feed-row")).toHaveCount(0);
});

test("settings export and import restore a prior theme and reject malformed files", async ({ page }) => {
  await page.goto("/");
  await page.locator("#settings").click();
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.locator("#exportSettings").click()
  ]);
  const buffer = await fs.readFile(await download.path());
  await page.locator("#themeSelect").selectOption("oled");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "oled");
  await page.locator("#settingsFile").setInputFiles({
    name: "reader-settings.json",
    mimeType: "application/json",
    buffer
  });
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.locator("#settingsFile").setInputFiles({
    name: "invalid-settings.json",
    mimeType: "application/json",
    buffer: Buffer.from('{"format":"wrong","version":99}')
  });
  await expect(page.locator("#toast")).toContainText("Unsupported settings file");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
});

test("keyboard preset help reflects the active preset", async ({ page }) => {
  await page.goto("/");
  await page.locator("#settings").click();
  await page.locator("#shortcutPresetSelect").selectOption("feedly");
  await page.locator("#settingsDialog .x").click();
  await page.locator("#shortcutHelp").click();
  await expect(page.locator("#helpDialog")).toBeVisible();
  await expect(page.locator("#helpPresetNote")).toContainText("Feedly");
  await expect(page.locator("#helpRows")).toContainText("Save");
  await page.locator('#helpDialog button[value="cancel"]').click();
});

test("reader sanitizes rich HTML while preserving tables, code, and images", async ({ page }) => {
  const richXml = `<?xml version="1.0"?><rss version="2.0"><channel>
    <title>Rich Fixture</title><link>https://publisher.test/</link><description>Rich content</description>
    <item><title>Rich article</title><link>https://publisher.test/rich</link><guid>rich-1</guid>
      <description><![CDATA[
        <p>Safe paragraph with <strong>bold text</strong> and <em>emphasis</em>.</p>
        <table><thead><tr><th>Column</th></tr></thead><tbody><tr><td>Cell content</td></tr></tbody></table>
        <pre><code>const answer = 42;</code></pre>
        <img src="https://publisher.test/image.png" alt="Fixture image">
        <script>window.__rssReaderInjected = true;</script>
      ]]></description>
    </item>
  </channel></rss>`;
  await page.route("https://rich-feed.test/rss.xml", route => route.fulfill({
    status: 200, contentType: "application/rss+xml", headers: { "access-control-allow-origin": "*" }, body: richXml
  }));
  await page.goto("/");
  await page.locator("#add").click();
  await page.locator("#feedSearchInput").fill("https://rich-feed.test/rss.xml");
  await page.locator("#saveFeed").click();
  await expect(page.locator("#articleList [data-item]")).toHaveCount(1);
  await page.locator("#articleList [data-item]").click();
  await expect(page.locator("#body strong")).toContainText("bold text");
  await expect(page.locator("#body table td")).toContainText("Cell content");
  await expect(page.locator("#body pre code")).toContainText("const answer = 42");
  await expect(page.locator("#body img")).toHaveAttribute("alt", "Fixture image");
  await expect(page.locator("#body script")).toHaveCount(0);
  expect(await page.evaluate(() => window.__rssReaderInjected)).toBeUndefined();
});

test("full article loading succeeds and reports failures", async ({ page }) => {
  await page.goto("/");
  await addFixtureFeed(page);
  await page.route("https://publisher.test/article-one", route => route.fulfill({
    status: 200,
    contentType: "text/html",
    body: "<!doctype html><html><body><article><h1>Full article fixture</h1><p>Full article body with enough text to verify extraction and rendering.</p></article></body></html>"
  }));
  await page.locator("#articleList [data-item]").nth(1).click();
  await clickReaderAction(page, "fulltext");
  await expect(page.locator("#body")).toContainText("Full article fixture");
  await expect(page.locator('#reader .reader-actions > [data-reader="fulltext"]')).toHaveAttribute("aria-busy", "false");

  await page.reload();
  await addFixtureFeed(page);
  await page.route("https://publisher.test/article-two", route => route.abort());
  await page.route(/r\.jina\.ai/, route => route.fulfill({ status: 502, body: "unavailable" }));
  await page.route(/api\.allorigins\.win/, route => route.fulfill({ status: 502, body: "unavailable" }));
  await page.locator("#articleList [data-item]").first().click();
  await page.locator('#reader [data-reader="fulltext"]').click();
  await expect(page.locator("#toast")).toContainText("Full text unavailable");
});

test("full article loading can be cancelled while a publisher request is pending", async ({ page }) => {
  await page.goto("/");
  await addFixtureFeed(page);
  await page.route("https://publisher.test/article-one", async route => {
    await new Promise(resolve => setTimeout(resolve, 2500));
    try { await route.fulfill({ status: 200, contentType: "text/html", body: "<article><p>Late response.</p></article>" }); } catch {}
  });
  await page.locator("#articleList [data-item]").first().click();
  const fullTextButton = page.locator('#reader .reader-actions > [data-reader="fulltext"]');
  await fullTextButton.click();
  await expect(fullTextButton).toHaveAttribute("aria-busy", "true");
  await fullTextButton.click();
  await expect(fullTextButton).toHaveAttribute("aria-busy", "false");
  await expect(page.locator("#toast")).toContainText("cancelled");
});

test("highlight, note, and tag data survive reload", async ({ page }) => {
  await page.goto("/");
  await addFixtureFeed(page);
  await page.locator("#articleList [data-item]").first().click();
  await page.evaluate(() => {
    const target = document.querySelector("#body p");
    const range = document.createRange();
    range.selectNodeContents(target);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  });
  await expect(page.locator("#hlBtn")).toBeVisible();
  await page.locator("#hlBtn").click();
  await expect(page.locator("#hlDialog")).toBeVisible();
  await page.locator("#hlNote").fill("Keep this passage");
  await page.locator("#hlSave").click();
  await clickReaderAction(page, "note");
  await page.locator("#articleNoteText").fill("Article note persists");
  await page.locator("#articleNoteSave").click();
  await clickReaderAction(page, "tags");
  await page.locator("#tagInput").fill("research");
  await page.locator("#tagAddBtn").click();
  await page.reload();
  await expect(page.locator("#feeds .feed-row")).toContainText("Fixture Feed");
  await page.locator("#articleList [data-item]").first().click();
  await expect(page.locator("#reader")).toContainText("Keep this passage");
  await expect(page.locator("#reader")).toContainText("Article note persists");
  await expect(page.locator("#reader")).toContainText("research");
});

test("mobile reader dialogs and toolbar remain within the viewport", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "chromium-mobile", "Mobile viewport assertion only.");
  await page.goto("/");
  await addFixtureFeed(page);
  await page.locator("#articleList [data-item]").first().click();
  const bounds = await page.evaluate(() => {
    const viewport = document.documentElement.clientWidth;
    const toolbar = document.querySelector(".reader-actions");
    return { viewport, document: document.documentElement.scrollWidth, toolbar: toolbar?.scrollWidth || 0, toolbarClient: toolbar?.clientWidth || 0 };
  });
  expect(bounds.document).toBeLessThanOrEqual(bounds.viewport + 1);
  expect(bounds.toolbar).toBeLessThanOrEqual(bounds.toolbarClient + 1);
  await page.locator("#settings").click();
  const dialogWidth = await page.locator("#settingsDialog").evaluate(el => el.getBoundingClientRect().width);
  expect(dialogWidth).toBeLessThanOrEqual(bounds.viewport);
});

test("manual refresh fetches updated feed content immediately", async ({ page }) => {
  await page.goto("/");
  await addFixtureFeed(page);
  const updatedFeed = feedXml.replace("</channel>", `<item><title>Newly published fixture</title><link>https://publisher.test/article-three</link><guid>fixture-article-three</guid><pubDate>Mon, 23 Nov 2026 11:00:00 GMT</pubDate><description>New content.</description></item></channel>`);
  await page.route("https://feeds.test/rss.xml", route => route.fulfill({
    status: 200, contentType: "application/rss+xml", headers: { "access-control-allow-origin": "*" }, body: updatedFeed
  }));
  await page.locator("#refresh").click();
  await expect(page.locator("#articleList")).toContainText("Newly published fixture");
  await expect(page.locator("#articleList [data-item]")).toHaveCount(3);
});

test("full-text reader renders Markdown returned by the reader service", async ({ page }) => {
  await page.goto("/");
  await addFixtureFeed(page);
  await page.route("https://publisher.test/article-one", route => route.abort());
  const markdown = [
    "# Markdown full article",
    "",
    "This is a **bold paragraph** with `inline code` and a [source link](https://publisher.test/source).",
    "",
    "- First list item",
    "- Second list item",
    "",
    "```js",
    "const answer = 42;",
    "console.log(answer);",
    "```",
    "",
    "This final paragraph provides additional text so the reader service response is long enough to pass extraction checks and render as a complete article."
  ].join("\n");
  await page.route(/r\.jina\.ai/, route => route.fulfill({ status: 200, contentType: "text/plain", body: markdown }));
  await page.locator("#articleList [data-item]").first().click();
  await clickReaderAction(page, "fulltext");
  await expect(page.locator("#body h1")).toContainText("Markdown full article");
  await expect(page.locator("#body strong")).toContainText("bold paragraph");
  await expect(page.locator("#body code")).toContainText("inline code");
  await expect(page.locator("#body ul li")).toHaveCount(2);
  await expect(page.locator("#body pre code")).toContainText("const answer = 42");
});
