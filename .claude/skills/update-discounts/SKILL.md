---
name: update-discounts
description: Re-verify and update the Portuguese fuel discount catalogue in data/discounts.json (Galp, Repsol, BP, Moeve/Cepsa, Prio, supermarkets, partner cards, MB WAY, etc.). Use when asked to update, refresh, check or add fuel discounts, or on a scheduled review.
---

# Update the fuel discount catalogue

All discounts live in `data/discounts.json`. The app reads it at runtime, so **you never need to touch `app.js` or `index.html`** to change a discount. The format is defined in `data/discounts.schema.json`.

## Routine

1. **Read the current file** and run `python3 scripts/validate_discounts.py`. Its warnings list the entries that are stale (not verified for more than 90 days) or expired. Start with those.

2. **Research each programme.** Prefer official sources: the brand's own site or app help pages, the partner's site (Continente, Pingo Doce, Lidl, ACP, MB WAY, NOS/COMBINA…) and its campaign terms ("regulamento"). Recent news or deal sites (Sábado, e-konomista, 4gnews, ocacapromocoes) are a fallback. Search in Portuguese, e.g. `desconto combustível <marca> <parceiro> <mês> <ano>`. Also look for **new** programmes for the big brands: GALP, REPSOL, BP, MOEVE, PRIO, SHELL, INTERMARCHÉ, AUCHAN, PINGO DOCE, LECLERC, ALVES BANDEIRA.

3. **Edit `data/discounts.json`:**
   - **Confirmed unchanged:** set `lastVerified` to today. Update `source` if you found a better one.
   - **Changed value or conditions:** update `value`, `minSpendEur`, `maxLitresPerFill`, `conditions` and `lastVerified`.
   - **Ended:** don't delete it. Set `validUntil` to the end date if you know it, and `active: false`. Inactive entries show in a collapsed "expired" list.
   - **New programme:** add an entry with a new kebab-case `id`.
   - **Time-limited campaign:** set both `validFrom` and `validUntil`. The app hides it outside that window automatically.
   - Set the top-level `lastReviewed` to today once you've gone through the whole list.

4. **Validate:** `python3 scripts/validate_discounts.py` must report `0 errors`.

5. **Commit** with a message listing what changed: added, updated (old → new value), deactivated, and re-verified with no change. Push to the working branch.

## Modelling rules

- `brands`: use the DGEG brand name, uppercased (see `data/snapshot.json` keys or the `GetMarcas` endpoint). `CEPSA` is aliased to `MOEVE` through `brandAliases`.
- `kind`:
  - `instant`: off at the pump.
  - `balance`: credited to a card or app for later; counted at face value, and the user can switch balance off.
  - `mixed`: part instant, part balance. Use `value: {type: "cpl", cents: <instant>, balanceCents: <balance>}`.
- `value.type`:
  - `cpl`: cents per litre.
  - `percent`: % of the fuel price, e.g. cashback.
  - `perMonthEur`: fixed € per month, spread over the user's litres per month.
  - `perFillEur`: fixed € per fill, spread over litres per fill. Combine with `minSpendEur`.
- `group`: discounts that **cannot be combined** share a group, and only the best one applies (e.g. COMBINA tiers, Repsol partner discounts). Ungrouped discounts stack.
- `weekendValue`: use when the value differs on Saturday/Sunday (e.g. ACP at BP). `days` limits a discount to weekdays or weekends only.
- `maxLitresPerFill`: the per-fill litre cap. The discount is pro-rated above it.
- `defaultOn`: keep `false`. The user chooses what they have.
- Occasional promos (only on campaign days) still go in, with conditions saying so. If you know the dates, set `validFrom`/`validUntil` to the campaign window.
- Business fleet cards (Galp Frota, BP Plus empresas, etc.) are out of scope. This app is for private drivers.

## Refreshing the price snapshot

`python3 scripts/make_snapshot.py` rewrites `data/snapshot.json`. It's the offline fallback and the brand list the validator checks against. Run it when the validator reports an unknown brand that really exists in DGEG, or every month or so.
