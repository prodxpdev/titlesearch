// The README demo: a search with a market description and suggested names,
// a preview, the domain report, and the shortlist. Paced for viewers.

import { fileURLToPath } from "node:url";
import { expect, type Page, test } from "@playwright/test";
import { lot, signIn } from "../e2e/helpers";

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Stills for the website, from the same run as the GIF. */
const shot = (page: Page, name: string) =>
  page.screenshot({
    path: fileURLToPath(new URL(`../../../docs/public/screens/${name}.jpg`, import.meta.url)),
    type: "jpeg",
    quality: 82,
  });

test("demo", async ({ page }) => {
  await signIn(page);
  await pause(800);

  await page.getByLabel("Name ideas").pressSequentially("fieldloom\ndispatchwell", { delay: 60 });
  await page
    .getByLabel("What are you building?")
    .pressSequentially("Scheduling and dispatch software for small field-service contractors", {
      delay: 25,
    });
  await pause(400);
  await page.getByLabel(/Names from your description/).check();
  await pause(900);
  await page.getByRole("button", { name: "Run search" }).click();
  await expect(page.getByText("Says what it does").first()).toBeVisible();
  await pause(2200);
  await shot(page, "results");

  const taken = lot(page, "fieldloom.com");
  await taken.locator(".shot-frame").first().hover();
  await pause(1800);
  await page.mouse.move(0, 0);
  await pause(400);

  await page.locator('a[href="#/domain/fieldloom.com"]').first().click();
  await pause(2600);
  await shot(page, "report");
  await page.mouse.wheel(0, 500);
  await pause(1800);

  await page.getByRole("navigation").getByRole("link", { name: "Results" }).click();
  await pause(700);
  await page.getByRole("button", { name: "Add to shortlist" }).nth(2).click();
  await pause(500);
  await page.getByRole("navigation").getByRole("link", { name: "Shortlist" }).click();
  await pause(2500);
});
