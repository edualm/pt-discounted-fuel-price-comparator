# PT discounted fuel price comparator

Which fuel brand in Portugal is actually cheapest **for you**, once the discounts you can use are taken off?

The app takes the average (or median) pump price of each brand across every station in Portugal, live from the official DGEG price database. It then subtracts the discounts you tick and ranks the brands by the price you'd really pay.

## Run it

```sh
python3 -m http.server
# open http://localhost:8000
```

Any static host works, e.g. GitHub Pages: Settings → Pages → deploy from the branch root. There's no build step and nothing to install.

## How it works

- **Prices:** `app.js` calls `https://precoscombustiveis.dgeg.gov.pt/api/PrecoComb/PesquisarPostos?idsTiposComb=<fuel>`, which returns every station with its brand and price. These prices already include the government's temporary ISP discount. If DGEG can't be reached, the app falls back to `data/snapshot.json`.
- **Discounts:** `data/discounts.json`. Each entry has:
  - the brands it applies to;
  - its value: c/L, %, € per month or € per fill;
  - whether it's instant or balance (credit for later);
  - its conditions, any caps or minimum spend, and validity dates;
  - a source link and the date it was last verified.

  Discounts in the same `group` can't be combined, so only the best one counts. Values are editable in the UI, and your choices are saved in your browser.
- **Settings:** fuel type, litres per fill or per month (for caps, minimum spends and €-based discounts), weekday or weekend, average or median, minimum stations per brand, and whether balance discounts count.

## Keeping the discounts up to date

Discounts change all the time. To update them, edit `data/discounts.json` (no code changes needed) and run:

```sh
python3 scripts/validate_discounts.py
```

The validator also runs in CI. It fails on malformed entries and warns about entries not verified in 90 days or that have expired.

The full routine, written so an AI agent can follow it, is in [`.claude/skills/update-discounts/SKILL.md`](.claude/skills/update-discounts/SKILL.md). In Claude Code, ask *"update the fuel discounts"*.

To refresh the offline price snapshot: `python3 scripts/make_snapshot.py`.

## Caveats

- National averages hide regional differences, and your nearest station may differ.
- Discount terms come from brand pages and news articles, so always confirm in the brand's app.
- Balance discounts are counted at face value, even though some can only be spent in a specific store.
