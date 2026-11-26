import { test, expect } from "@playwright/test";

test("settings categories and install guidance are available on desktop and mobile", async ({ page }) => {
  for (const viewport of [{ width: 1280, height: 900 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(viewport);
    await page.goto("/");
    await page.locator("#settings").click();

    const dialog = page.locator("#settingsDialog");
    await expect(dialog).toBeVisible();
    for (const id of ["appearance", "reading", "feeds", "data", "application"]) {
      await expect(page.locator("#settings-" + id)).toBeVisible();
    }
    await expect(page.locator("#installAppSetting")).toBeVisible();
    await expect(page.locator("#themeSelect")).toBeVisible();
    await expect(page.locator("#backgroundSyncToggle")).toBeVisible();
    await expect(page.locator("#exportBackup")).toBeVisible();

    const bounds = await dialog.boundingBox();
    expect(bounds).not.toBeNull();
    expect(bounds.x).toBeGreaterThanOrEqual(0);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(viewport.width + 1);

    await page.keyboard.press("Escape");
    await expect(dialog).not.toBeVisible();
  }
});
