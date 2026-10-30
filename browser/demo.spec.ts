import { expect, test } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

test("demo works with a keyboard, explains real responses and stays within the viewport", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await page.getByRole("button", { name: "Send a request" }).focus();
  await page.keyboard.press("Enter");
  await expect(page.locator("#http-status")).toHaveText("200");
  await expect(page.locator("#content-title")).toHaveText(
    "Community noticeboard",
  );
  await expect(page.locator("#badge")).toHaveText(/MISS|HIT|COALESCED|STALE/);
  await page.getByRole("button", { name: "Send 10 at once" }).click();
  await expect(page.getByRole("status")).toContainText("10/10 successful");
  await expect(page.locator("#log tr")).toHaveCount(11);
  await page.getByLabel("Resource", { exact: true }).selectOption("timetable");
  await page.getByRole("radio", { name: "Slow", exact: false }).check();
  await page.getByRole("button", { name: "Send a request" }).click();
  await expect(page.locator("#content-title")).toHaveText(
    "Library opening hours",
  );
  await expect(page.locator("#request-path")).toHaveText(
    "GET /api/content/timetable?scenario=slow",
  );
  await page.getByText("Response body", { exact: true }).click();
  await expect(page.locator("#response-body")).toContainText(
    '"scenario": "slow"',
  );
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  for (const width of [375, 768, 1440]) {
    await page.setViewportSize({ width, height: 1000 });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
  }
  await page.setViewportSize({ width: 1440, height: 1050 });
  await page.screenshot({ path: "docs/screenshots/demo.png", fullPage: true });
});
