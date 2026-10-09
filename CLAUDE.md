# PT discounted fuel price comparator

Static web app (`index.html` + `app.js`, no build step, no dependencies). It ranks Portuguese fuel brands by average pump price minus the discounts the user has switched on.

- **Prices:** fetched live in the browser from the DGEG API (`https://precoscombustiveis.dgeg.gov.pt/api/PrecoComb/PesquisarPostos`, CORS open). `data/snapshot.json` is the offline fallback (regenerate with `python3 scripts/make_snapshot.py`).
- **Discounts:** **only** in `data/discounts.json`. Schema in `data/discounts.schema.json`. To update discounts, follow `.claude/skills/update-discounts/SKILL.md`. Don't hard-code discounts in `app.js`.
- **Validate** after any change to the data: `python3 scripts/validate_discounts.py` (CI runs it too).
- **Run locally:** `python3 -m http.server`, then open http://localhost:8000. It must be served over HTTP; `file://` can't fetch the JSON.
