# 16. The web UI

- Status: accepted
- Date: 2026-09-30

## Context

`docs/design/titlesearch-mockups.html` is the source of truth for screens, copy, and states. The UI is served by `titlesearch serve` and, later, by the desktop shell and deployed instances.

## Decisions

### Built to the mockup

- **The mockup's CSS is used verbatim** in `apps/web/src/styles.css`: every token, status color, dark-mode rule, and component class. Additions sit in a clearly marked block at the end: styles for the labels the mockup doesn't draw, real images in the preview frames, the sign-in form, and a progress bar. The file is excluded from Biome, so the vendored design stays byte-for-byte.
- **Screens and copy follow the mockup:** New search, Results (the plat grid), Domain report, Shortlist, Providers, and Connect Claude, on the same hash routes.
- **Status labels** are exactly the updated brief's list, mapped as it specifies. `Taken`, `Not registered`, and `Couldn't check` use the neutral style, and `Unconfirmed` is only for sources that disagree.

### Real data, honestly labeled

- **Prices:** when no source returns a price, the lot says "No price from this source", never a blank or an estimate.
- **Provenance:** every figure on the domain report carries a tag: RDAP, WHOIS, GoDaddy, Site, DNS, or Preview.
- **Site text** appears only in the mockup's "Text from the site" block, as text.
- **Deterministic reasons for parked and for-sale domains** are labeled "From parking and sale signals, not a judgment". Classifier judgments name their model.
- **Row verdicts** ("Viable", "Crowded", "Taken") and their notes are computed from the results, not written by a model.

### Nothing third-party loads in the UI (invariant 8)

- **Fonts are self-hosted** through `@fontsource`, not Google Fonts. The mockup links Google Fonts; the app can't.
- **Preview images come only from `/api/preview/:hash`,** with `referrerPolicy="no-referrer"`. There are no iframes or hotlinked images.
- **The server's CSP enforces this:** same-origin scripts, styles, fonts, images, and requests; no frames.
- **"Visit site" is an explicit link** with `rel="noopener noreferrer"` and the mockup's warning that the site will see the user's IP address.

The UI has one network module, `apps/web/src/api.ts`, which calls only relative `/api/` paths. It's the one exemption from the global-`fetch` lint rule (ADR 3).

### Sign-in and secrets

The UI signs in with the one-time code `serve` prints (ADR 15); the session cookie is `HttpOnly`, so scripts never see it. The Providers screen never takes an API key: in `serve` mode it shows whether one is set and tells the user to set `ANTHROPIC_API_KEY` where they run the server. Keychain storage comes with the desktop app. "Replace token" shows the new token once.

### Accessibility

- **The plat grid is an ARIA grid** on the mockup's CSS grid. Arrow keys, Home, and End move a roving focus between lots, and Enter opens the report. `biome.json` scopes off the two a11y rules that expect `<table>` elements for that one file.
- **Previews** open on hover or keyboard focus, and the modal is a native `<dialog>` (Escape closes it).
- **Color, dark mode, and motion:** the contrast and dark mode come from the mockup's tokens, including `prefers-color-scheme`, and reduced motion from its `prefers-reduced-motion` rule. The end-to-end suite checks dark mode and reduced motion.

### State

- The current search and its results are kept in `sessionStorage`.
- The shortlist, the previews switch, and "Blur previews until opened" are kept in `localStorage`.
- Every storage call is wrapped, so blocked storage just means no persistence.
- Settings changes apply immediately and roll back if the server refuses. The end-to-end suite caught the controlled-radio lag that motivated this.

### End-to-end tests

- **The harness:** `apps/web/e2e/server.ts` runs the real Hono app and the built UI under Bun, with providers, probe, and classifier stubbed to the mockup's sample data, and with real WebP previews. It exposes a test-only login-code endpoint.
- **The suite:** Playwright drives the installed Chrome (`channel: "chrome"`), so there's no browser download. It covers:
  - every mockup route, every status label, and keyboard navigation;
  - previews (thumbnail, popover, modal), and a check that no request left the origin;
  - blur, the previews switch, settings, token replacement, dark mode, and reduced motion.
- **CI:** the Bun job builds the UI and runs the suite.

## Verified

- A live `serve` run searched the mockup's four sample names across six extensions with real providers and real screenshots, and was compared screen by screen with the mockup.
- That comparison found a popover that outlived navigation. It now closes on route changes.
