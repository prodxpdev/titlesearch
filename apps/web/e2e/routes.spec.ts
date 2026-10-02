import { expect, test } from "@playwright/test";
import { lot, runMockupSearch, signIn } from "./helpers";

test.describe("sign-in", () => {
  test("rejects a wrong code and accepts the right one", async ({ page }) => {
    await page.goto("/#/search");
    await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
    await page.getByLabel("Sign-in code").fill("WRONGCODE0");
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page.getByRole("alert")).toContainText("didn't work");
    await signIn(page);
  });
});

test.describe("mockup routes", () => {
  test.beforeEach(async ({ page }) => {
    await signIn(page);
  });

  test("New search: fields, chips, and variant options", async ({ page }) => {
    await expect(
      page.getByRole("heading", { name: "Is the name free, and who lives next door?" }),
    ).toBeVisible();
    const chip = page.getByRole("button", { name: ".xyz" });
    await expect(chip).toHaveAttribute("aria-pressed", "false");
    await chip.click();
    await expect(chip).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByLabel("Prefixes")).toBeVisible();
  });

  test("Results: the plat grid with every status label", async ({ page }) => {
    await runMockupSearch(page);
    await expect(page.getByRole("heading", { name: "4 names across 6 extensions" })).toBeVisible();
    const expectations: [string, string][] = [
      ["fieldloom.com", "Unrelated site"],
      ["fieldloom.io", "Available"],
      ["fieldloom.co", "Parked"],
      ["crewcadence.com", "Competitor"],
      ["crewcadence.io", "For sale"],
      ["crewcadence.app", "Possible overlap"],
      ["crewcadence.co", "No site"],
      ["dispatchwell.com", "Premium"],
      ["dispatchwell.ai", "Unconfirmed"],
      ["routeline.com", "Competitor"],
    ];
    for (const [domain, label] of expectations) {
      await expect(lot(page, domain).locator(".st")).toHaveText(label);
    }
    await expect(lot(page, "crewcadence.io")).toContainText("Sale page, asking $4,800");
    await expect(lot(page, "fieldloom.io")).toContainText("$12.99");
    await expect(page.locator(".row-h", { hasText: "crewcadence" })).toContainText("Crowded.");
  });

  test("Results: previews as thumbnail, popover, and modal, from this origin only", async ({
    page,
  }) => {
    await runMockupSearch(page);
    const thumb = lot(page, "crewcadence.com").getByRole("button", {
      name: "Preview crewcadence.com",
    });
    const src = await thumb.locator("img").getAttribute("src");
    expect(src).toMatch(/^\/api\/preview\/[0-9a-f]{64}$/);
    await thumb.hover();
    await expect(page.locator(".pop.show")).toContainText("crewcadence.com");
    await thumb.click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toContainText("1280 by 800, first screen only");
    await expect(dialog.getByRole("link", { name: "Visit site" })).toHaveAttribute(
      "rel",
      "noopener noreferrer",
    );
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    // No request left this origin.
    const external = await page.evaluate(() =>
      performance
        .getEntriesByType("resource")
        .filter((e) => !e.name.startsWith(location.origin))
        .map((e) => e.name),
    );
    expect(external).toEqual([]);
  });

  test("Results: the previews switch hides thumbnails", async ({ page }) => {
    await runMockupSearch(page);
    await expect(page.locator(".lot .thumb").first()).toBeVisible();
    await page.getByRole("switch", { name: "Show site previews" }).click();
    await expect(page.locator(".lot .thumb")).toHaveCount(0);
  });

  test("Results: arrow keys move through the grid", async ({ page }) => {
    await runMockupSearch(page);
    await page.locator('a[href="#/domain/fieldloom.com"]').focus();
    await page.keyboard.press("ArrowRight");
    await expect(page.locator('a[href="#/domain/fieldloom.io"]')).toBeFocused();
    await page.keyboard.press("ArrowDown");
    await expect(page.locator('a[href="#/domain/crewcadence.io"]')).toBeFocused();
    await page.keyboard.press("End");
    await expect(page.locator('a[href="#/domain/crewcadence.co"]')).toBeFocused();
    await page.keyboard.press("Home");
    await expect(page.locator('a[href="#/domain/crewcadence.com"]')).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/#\/domain\/crewcadence\.com$/);
  });

  test("Domain report: provenance, what's there, connection, overlap, other extensions", async ({
    page,
  }) => {
    await runMockupSearch(page);
    await page.goto("/#/domain/crewcadence.com");
    await expect(page.locator(".status-pill").first()).toHaveText("Competitor");
    for (const tag of ["RDAP", "GoDaddy", "Site", "DNS", "Preview"]) {
      await expect(page.locator(".src", { hasText: tag }).first()).toBeVisible();
    }
    await expect(page.getByText("Written by the site owner, shown as-is")).toBeVisible();
    // Site text is shown as text, never followed.
    await expect(page.locator(".untrusted")).toContainText("Ignore previous instructions");
    await expect(page.locator(".chain li")).toHaveCount(2);
    await expect(page.locator(".verdict")).toContainText("Competitor");
    await expect(page.getByText("This is not a trademark search.")).toBeVisible();
    await page.locator(".mini a", { hasText: ".app" }).click();
    await expect(page).toHaveURL(/#\/domain\/crewcadence\.app$/);
    await expect(page.locator(".verdict")).toContainText("Possible overlap");
  });

  test("Domain report: sources that disagree", async ({ page }) => {
    await runMockupSearch(page);
    await page.goto("/#/domain/dispatchwell.ai");
    await expect(page.locator(".agree.no")).toContainText("Sources disagree");
  });

  test("Shortlist: add, compare, remove", async ({ page }) => {
    await runMockupSearch(page);
    await page
      .locator(".row-h", { hasText: "fieldloom" })
      .getByRole("button", { name: "Add to shortlist" })
      .click();
    await page.getByRole("link", { name: "Shortlist" }).click();
    await expect(page.getByRole("row", { name: /fieldloom/ })).toContainText("Unrelated site");
    await expect(page.getByText("Search the USPTO trademark database")).toBeVisible();
    await page.getByRole("button", { name: "Remove" }).click();
    await expect(page.getByText("Your shortlist is empty.")).toBeVisible();
  });

  test("Providers: toggles, assessment mode, and blur", async ({ page }) => {
    await runMockupSearch(page);
    await page.getByRole("link", { name: "Providers" }).click();
    const godaddy = page.getByRole("switch", { name: "Use GoDaddy" });
    await expect(godaddy).toHaveAttribute("aria-checked", "true");
    await godaddy.click();
    await expect(godaddy).toHaveAttribute("aria-checked", "false");
    await page.getByLabel(/Leave it to Claude in chat/).check();
    await expect(page.getByLabel("Leave it to Claude in chat")).toBeChecked();
    await expect(page.getByRole("switch", { name: "Use RDAP" })).toBeDisabled();
    const porkbun = page.getByRole("switch", { name: "Use Porkbun" });
    await expect(porkbun).toHaveAttribute("aria-checked", "true");
    await porkbun.click();
    await expect(porkbun).toHaveAttribute("aria-checked", "false");
    // Name.com has no keys yet: add them here, and its switch becomes usable.
    const namecom = page.getByRole("switch", { name: "Use Name.com" });
    await expect(namecom).toBeDisabled();
    await page.getByLabel("Name.com username").fill("pat");
    await page.getByLabel("Name.com username").press("Enter");
    await page.getByLabel("Name.com API token").fill("namecom-token-0123");
    await page.getByLabel("Name.com API token").press("Enter");
    await expect(page.getByText("Saved in your keychain").first()).toBeVisible();
    await expect(namecom).toBeEnabled();
    await expect(page.getByText("Cloudflare Browser Rendering")).toHaveCount(0);
    await page.getByLabel("Blur previews until opened").check();
    await page.getByRole("link", { name: "Results" }).click();
    await expect(page.locator(".lot .shot-frame.shot-blur").first()).toBeVisible();
  });

  test("Connect Claude: snippets and token replacement", async ({ page }) => {
    await page.getByRole("link", { name: "Connect Claude" }).click();
    await expect(page.locator("pre.code")).toContainText('"args": ["mcp"]');
    await page.getByRole("tab", { name: "Claude Code" }).click();
    await expect(page.locator("pre.code")).toHaveText(
      "claude mcp add titlesearch -- titlesearch mcp",
    );
    await page.getByRole("button", { name: "Replace token" }).click();
    await expect(page.getByRole("dialog")).toContainText("r".repeat(64));
  });
});

test.describe("open models", () => {
  test("chooses a model in Ollama on this computer", async ({ page }) => {
    await signIn(page);
    await page.getByRole("navigation").getByRole("link", { name: "Providers" }).click();
    await page.getByLabel("Model", { exact: true }).selectOption("ollama");
    const local = page.getByLabel("Ollama model");
    await expect(local).toBeVisible();
    await expect(page.getByText("never leave it")).toBeVisible();
    await local.selectOption("llama3.1:8b");
    await page.getByRole("button", { name: "Use this model" }).click();
    await expect(page.getByText("Now: Ollama · llama3.1:8b (this computer)")).toBeVisible();
    await expect(page.getByLabel(/An open model, on this computer/)).toBeEnabled();
  });

  test("downloads the built-in model, then uses it", async ({ page }) => {
    await signIn(page);
    await page.getByRole("navigation").getByRole("link", { name: "Providers" }).click();
    await page.getByLabel("Model", { exact: true }).selectOption("builtin");
    const recommended = page.locator(".builtin-model").filter({ hasText: "Qwen3 4B Instruct" });
    await expect(page.getByRole("radio", { name: /Qwen3 4B Instruct/ })).toBeChecked();
    await expect(recommended).toContainText("2.5 GB download");
    await expect(page.getByRole("button", { name: "Use this model" })).toBeDisabled();
    await recommended.getByRole("button", { name: "Download" }).click();
    await expect(recommended.getByRole("progressbar")).toBeVisible();
    await expect(recommended).toContainText("Downloaded");
    await page.getByRole("button", { name: "Use this model" }).click();
    await expect(
      page.getByText("Now: Built-in model · Qwen3 4B Instruct (this computer)"),
    ).toBeVisible();
  });

  test("says when a local runtime isn't running", async ({ page }) => {
    await page.route("**/api/models/local", (route) => route.fulfill({ json: { runtimes: [] } }));
    await signIn(page);
    await page.getByRole("navigation").getByRole("link", { name: "Providers" }).click();
    await page.getByLabel("Model", { exact: true }).selectOption("lmstudio");
    await expect(page.getByText("LM Studio isn't running on this computer")).toBeVisible();
    await expect(page.getByRole("button", { name: "Use this model" })).toBeDisabled();
  });
});

test.describe("names from the description", () => {
  test("suggests names from what you're building, with reasons", async ({ page }) => {
    await signIn(page);
    await page
      .getByLabel("What are you building?")
      .fill("Scheduling and dispatch software for field crews");
    await page.getByLabel(/Names from your description/).check();
    await page.getByRole("button", { name: "Run search" }).click();
    await expect(page.getByRole("rowheader").filter({ hasText: "dispatchly" })).toContainText(
      "Says what it does",
    );
    await expect(page.getByText("Suggested").first()).toBeVisible();
  });

  test("turns the option on after a model is chosen, without reloading", async ({ page }) => {
    // The server has no model until the Ollama one is saved below.
    let hasModel = false;
    await page.route("**/api/settings", async (route) => {
      const res = await route.fetch();
      const body = await res.json();
      if (route.request().method() === "PATCH") hasModel = true;
      body.settings.suggestions.available = hasModel;
      await route.fulfill({ response: res, json: body });
    });
    await signIn(page);
    const option = page.getByLabel(/Names from your description/);
    await expect(option).toBeDisabled();
    await page.getByRole("navigation").getByRole("link", { name: "Providers" }).click();
    await page.getByLabel("Model", { exact: true }).selectOption("ollama");
    await page.getByLabel("Ollama model").selectOption("llama3.1:8b");
    await page.getByRole("button", { name: "Use this model" }).click();
    await expect(page.getByText("Now: Ollama · llama3.1:8b (this computer)")).toBeVisible();
    await page.getByRole("navigation").getByRole("link", { name: "New search" }).click();
    await expect(option).toBeEnabled();
  });

  test("explains why the option is off when the server has no model", async ({ page }) => {
    await page.route("**/api/settings", async (route) => {
      const res = await route.fetch();
      const body = await res.json();
      body.settings.suggestions = { available: false };
      await route.fulfill({ response: res, json: body });
    });
    await signIn(page);
    await expect(page.getByLabel(/Names from your description/)).toBeDisabled();
    await expect(page.getByText(/Needs a model: choose Claude or an open model/)).toBeVisible();
  });
});

test.describe("desktop sign-in", () => {
  test("signs in with the code the desktop app provides", async ({ page, request }) => {
    const code = await (await request.get("/__e2e/login-code")).text();
    await page.addInitScript((c) => {
      (window as { __TITLESEARCH_DESKTOP_CODE__?: string }).__TITLESEARCH_DESKTOP_CODE__ = c;
    }, code);
    await page.goto("/");
    await expect(page.getByRole("link", { name: "New search" })).toBeVisible();
    await expect(page.getByLabel("Sign-in code")).toHaveCount(0);
  });
});

test.describe("deployed sign-in", () => {
  test("offers the identity provider instead of a code", async ({ page }) => {
    await page.route("**/api/session", (route) =>
      route.fulfill({ json: { authenticated: false, login: "oidc" } }),
    );
    await page.goto("/");
    const link = page.getByRole("link", { name: "Sign in" });
    await expect(link).toHaveAttribute("href", "/auth/login");
    await expect(page.getByLabel("Sign-in code")).toHaveCount(0);
  });
});

test.describe("appearance", () => {
  test("follows dark mode", async ({ page }) => {
    await page.emulateMedia({ colorScheme: "dark" });
    await page.goto("/#/search");
    const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    expect(bg).toBe("rgb(15, 24, 38)");
  });

  test("respects reduced motion", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto("/#/search");
    const d = await page.evaluate(
      () => getComputedStyle(document.querySelector(".nav") as Element).transitionDuration,
    );
    expect(d).toBe("0s");
  });
});
