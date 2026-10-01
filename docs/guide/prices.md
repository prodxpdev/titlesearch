# Prices

Availability comes from registries (RDAP and WHOIS) and from GoDaddy, which confirms availability but returns no prices. Prices and premium status come only from registrars you connect: Porkbun (the default) or Name.com. Without one, results say "No price from this source", never an estimate.

## Porkbun

Set `PORKBUN_API_KEY` and `PORKBUN_SECRET_API_KEY`. Porkbun keys can't be limited to read-only use, so we recommend a **sandbox key** (prefixed `pk1_sb_`), created at porkbun.com/account/api. Porkbun says sandbox availability and prices match production, while purchases are only simulated, so the key can't buy anything. If you use a live key, restrict it to your IP address.

## Name.com

Set `NAMECOM_USERNAME` and `NAMECOM_TOKEN`. Name.com tokens can't be scoped, so create one just for Titlesearch.

Titlesearch only ever calls each registrar's availability check; it can't register or buy a domain. Prices are first-year prices in US dollars, and they can change. See [ADR 17](/decisions/0017-price-sources) for the details.
