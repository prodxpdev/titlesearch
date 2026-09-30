import { expect, type Page } from "@playwright/test";

export async function signIn(page: Page): Promise<void> {
  await page.goto("/#/search");
  const code = await (await page.request.get("/__e2e/login-code")).text();
  await page.getByLabel("Sign-in code").fill(code);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByLabel("Name ideas")).toBeVisible();
}

export async function runMockupSearch(page: Page): Promise<void> {
  await page.getByLabel("Name ideas").fill("fieldloom\ncrewcadence\ndispatchwell\nrouteline");
  await page
    .getByLabel("What are you building?")
    .fill("Scheduling and dispatch software for small field-service contractors");
  await page.getByRole("button", { name: "Run search" }).click();
  await expect(page.getByText("Checked 24 domains.")).toBeVisible();
}

export function lot(page: Page, domain: string) {
  return page.locator(".lot", { has: page.locator(`a[href="#/domain/${domain}"]`) });
}
