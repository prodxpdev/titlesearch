# Reading the results

Every domain gets one status. Each fact shown carries a tag naming its source (RDAP, GoDaddy, Porkbun, DNS, Site, Preview, or Assessment), so you can see where it came from.

| Status | Meaning |
|---|---|
| **Available** | A registrar confirmed you can register it at a standard price. |
| **Premium** | A registrar confirmed you can register it, at a premium price. |
| **Not registered** | The registry has no record of it, but no registrar was asked. It may still be reserved, blocked, or premium, so it isn't "Available". Price unknown. |
| **Competitor** | Registered, and the site sells something that competes with your description. |
| **Possible overlap** | Registered, and the site is close enough to yours to look at. |
| **Unrelated site** | Registered, and the site does something else. |
| **Taken** | Registered, with a site that hasn't been judged against a description. |
| **Parked** | Registered, showing a parking page. |
| **For sale** | Registered, and the owner is selling it. An asking price is shown only when the page states one. |
| **No site** | Registered, with nothing served. |
| **Unconfirmed** | The sources disagree, for example a registry record alongside a registrar listing it for resale. Every source's answer is shown. |
| **Couldn't check** | No source could answer this time. |

## Market overlap

When you describe what you're building, Titlesearch compares each taken domain's site with it. On your own computer that's done by Claude through your Anthropic API key, or by Claude in chat. The verdict comes with two to four plain reasons. Site text is treated as third-party data: it's never followed as instructions, and a verdict that doesn't validate is left as "Taken", never guessed.

## Previews

Taken domains get a screenshot, taken in an isolated browser that can only reach public addresses. Hover over or focus a thumbnail for a larger view; click it for the full image. When screenshots are off or fail, you see the site's own share image if it has one, labeled as such. "Blur previews until opened" on the Providers page hides them until you choose to look.

## Names from your description

With "Names from your description" on, Titlesearch adds names suggested from what you're building, each marked "Suggested" with its reason. They're checked like any other name.
