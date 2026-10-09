"use strict";

const DGEG_API = "https://precoscombustiveis.dgeg.gov.pt/api/PrecoComb";
const STORAGE_KEY = "ptfuel.v1";
const STALE_DAYS = 90;
const FUELS = [
  ["3201", "Gasolina simples 95"],
  ["3205", "Gasolina especial 95"],
  ["3400", "Gasolina 98"],
  ["2101", "Gasóleo simples"],
  ["2105", "Gasóleo especial"],
  ["1120", "GPL Auto"],
];
// Value field each discount value type exposes for editing, and its unit label.
const VALUE_FIELD = { cpl: ["cents", "c/L"], percent: ["pct", "%"], perMonthEur: ["eur", "€/month"], perFillEur: ["eur", "€/fill"] };

const today = new Date().toISOString().slice(0, 10);
const isWeekend = [0, 6].includes(new Date().getDay());

const state = {
  settings: { fuelId: "3201", litresPerFill: 45, litresPerMonth: 180, day: isWeekend ? "weekend" : "weekday",
              stat: "mean", minStations: 10, countBalance: true },
  enabled: {},    // discount id -> bool
  overrides: {},  // "id.field" -> number
  catalog: null,
  prices: {},     // fuelId -> { source: "live"|"snapshot", updated, prices: {rawBrand: [..]} }
  snapshot: null,
};

// ---------- persistence ----------
function load() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
    Object.assign(state.settings, saved.settings || {});
    Object.assign(state.enabled, saved.enabled || {});
    Object.assign(state.overrides, saved.overrides || {});
  } catch (_) { /* storage unavailable: use defaults */ }
}
function save() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ settings: state.settings, enabled: state.enabled, overrides: state.overrides }));
  } catch (_) { /* ignore */ }
}

// ---------- data ----------
const parsePrice = (s) => parseFloat(String(s).replace("€", "").trim().replace(",", "."));

async function fetchJson(url, timeoutMs = 60000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { signal: ctrl.signal });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.json();
  } finally { clearTimeout(t); }
}

async function fetchLivePrices(fuelId) {
  const body = await fetchJson(`${DGEG_API}/PesquisarPostos?idsTiposComb=${fuelId}&qtdPorPagina=10000&pagina=1`);
  if (!body.status || !Array.isArray(body.resultado)) throw new Error(body.mensagem || "unexpected response");
  const prices = {};
  let updated = "";
  for (const st of body.resultado) {
    const brand = (st.Marca || "").trim().toUpperCase();
    const p = parsePrice(st.Preco);
    if (!brand || !isFinite(p)) continue;
    (prices[brand] ||= []).push(p);
    if (st.DataAtualizacao > updated) updated = st.DataAtualizacao;
  }
  if (!Object.keys(prices).length) throw new Error("no stations returned");
  return { source: "live", updated, prices };
}

async function getPrices(fuelId) {
  if (state.prices[fuelId]) return state.prices[fuelId];
  try {
    state.prices[fuelId] = await fetchLivePrices(fuelId);
  } catch (e) {
    console.warn("Live DGEG fetch failed, using snapshot:", e);
    state.snapshot ||= await fetchJson("data/snapshot.json");
    const f = state.snapshot.fuels[fuelId];
    state.prices[fuelId] = { source: "snapshot", updated: f.latestUpdate, generatedAt: state.snapshot.generatedAt, prices: f.prices, error: String(e.message || e) };
  }
  return state.prices[fuelId];
}

function normaliseBrand(raw) {
  const b = raw.trim().toUpperCase();
  return (state.catalog.brandAliases || {})[b] || b;
}

function brandStats(rawPrices) {
  const byBrand = {};
  for (const [raw, list] of Object.entries(rawPrices)) (byBrand[normaliseBrand(raw)] ||= []).push(...list);
  return Object.entries(byBrand).map(([brand, list]) => {
    const sorted = [...list].sort((a, b) => a - b);
    const mid = sorted.length >> 1;
    return {
      brand,
      count: sorted.length,
      mean: sorted.reduce((a, b) => a + b, 0) / sorted.length,
      median: sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2,
      min: sorted[0],
    };
  });
}

// ---------- discounts ----------
function availability(d) {
  if (!d.active) return "inactive";
  if (d.validUntil && d.validUntil < today) return "expired";
  if (d.validFrom && d.validFrom > today) return "upcoming";
  return "ok";
}

function valueWithOverrides(d) {
  const s = state.settings;
  const base = s.day === "weekend" && d.weekendValue ? d.weekendValue : d.value;
  if (base !== d.value) return base; // overrides edit the main value only
  const v = { ...base };
  for (const k of Object.keys(v)) {
    const o = state.overrides[`${d.id}.${k}`];
    if (k !== "type" && typeof o === "number" && isFinite(o)) v[k] = o;
  }
  return v;
}

// Returns {inst, bal, total, note} in cents per litre for a given pump price.
function discountCpl(d, price) {
  const s = state.settings;
  const zero = (note) => ({ inst: 0, bal: 0, total: 0, note });
  if (availability(d) !== "ok") return zero(availability(d));
  if (d.days && d.days !== s.day) return zero(`${d.days}s only`);
  const spend = price * s.litresPerFill;
  if (d.minSpendEur && spend < d.minSpendEur) return zero(`needs ≥ ${d.minSpendEur} € per fill`);

  const v = valueWithOverrides(d);
  let c;
  switch (v.type) {
    case "cpl": c = v.cents; break;
    case "percent": c = price * v.pct; break; // € × % = cents
    case "perMonthEur": c = (v.eur * 100) / Math.max(1, s.litresPerMonth); break;
    case "perFillEur": c = (v.eur * 100) / Math.max(1, s.litresPerFill); break;
    default: c = 0;
  }
  let inst = d.kind === "balance" ? 0 : c;
  let bal = d.kind === "balance" ? c : d.kind === "mixed" ? (v.balanceCents || 0) : 0;
  let note = "";
  if (d.maxLitresPerFill && s.litresPerFill > d.maxLitresPerFill) {
    const f = d.maxLitresPerFill / s.litresPerFill;
    inst *= f; bal *= f;
    note = `capped at ${d.maxLitresPerFill} L`;
  }
  return { inst, bal, total: inst + (s.countBalance ? bal : 0), note };
}

// Best discount per group (ungrouped discounts stack), summed. Returns {cents, applied[]}.
function brandDiscount(brand, price) {
  const best = {};
  for (const d of state.catalog.discounts) {
    if (!state.enabled[d.id] || !d.brands.includes(brand)) continue;
    const r = discountCpl(d, price);
    const key = d.group || `__${d.id}`;
    if (!best[key] || r.total > best[key].r.total) best[key] = { d, r };
  }
  const applied = Object.values(best).filter((x) => x.r.total > 0);
  const cents = Math.min(price * 100, applied.reduce((a, x) => a + x.r.total, 0));
  return { cents, applied };
}

// ---------- rendering ----------
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const eur = (n, dp = 3) => n.toFixed(dp).replace(".", ",");
const daysSince = (date) => Math.round((Date.parse(today) - Date.parse(date)) / 86400000);

function renderControls() {
  const s = state.settings;
  $("fuel").innerHTML = FUELS.map(([id, name]) => `<option value="${id}">${esc(name)}</option>`).join("");
  for (const k of ["fuel", "litresPerFill", "litresPerMonth", "day", "stat", "minStations"]) {
    const key = k === "fuel" ? "fuelId" : k;
    const el = $(k);
    el.value = s[key];
    el.addEventListener("change", () => {
      s[key] = el.type === "number" ? Math.max(1, Number(el.value) || 1) : el.value;
      save();
      update();
    });
  }
  $("countBalance").checked = s.countBalance;
  $("countBalance").addEventListener("change", (e) => { s.countBalance = e.target.checked; save(); update(); });
}

function discountItem(d, live) {
  const v = d.value;
  const [field, unit] = VALUE_FIELD[v.type];
  const val = (f) => state.overrides[`${d.id}.${f}`] ?? v[f];
  const input = (f, label) => `<label>${label}<input type="number" min="0" step="any" data-id="${esc(d.id)}" data-field="${f}" value="${val(f)}" ${live ? "" : "disabled"}></label>`;
  let valueHtml = v.type === "cpl" && d.kind === "mixed"
    ? `${input("cents", "")} c/L instant + ${input("balanceCents", "")} c/L balance`
    : `${input(field, "")} ${unit}`;
  if (d.weekendValue) valueHtml += ` <span class="muted">(weekends: ${esc(describeValue(d.weekendValue))})</span>`;
  if (d.minSpendEur) valueHtml += ` <span class="muted">min ${d.minSpendEur} €</span>`;
  const stale = daysSince(d.lastVerified) > STALE_DAYS;
  const avail = availability(d);
  return `<div class="disc">
    <input type="checkbox" id="d-${esc(d.id)}" data-id="${esc(d.id)}" ${state.enabled[d.id] ? "checked" : ""} ${live ? "" : "disabled"}>
    <label class="name" for="d-${esc(d.id)}">${esc(d.name)} <span class="badge ${d.kind}">${d.kind}</span>${d.group ? ` <span class="badge group" title="Only the best discount in this group applies">pick one</span>` : ""}</label>
    <div class="val">${valueHtml}</div>
    <div class="meta">${esc(d.conditions)} <a href="${esc(d.source)}" target="_blank" rel="noopener">source</a> · verified ${esc(d.lastVerified)}</div>
    ${stale && live ? `<div class="note">Not verified for ${daysSince(d.lastVerified)} days; may be out of date.</div>` : ""}
    ${avail !== "ok" ? `<div class="note">${avail}${d.validUntil ? ` (until ${esc(d.validUntil)})` : ""}${d.validFrom && avail === "upcoming" ? ` (from ${esc(d.validFrom)})` : ""}</div>` : ""}
  </div>`;
}

function describeValue(v) {
  switch (v.type) {
    case "cpl": return `${v.cents}${v.balanceCents ? ` + ${v.balanceCents}` : ""} c/L`;
    case "percent": return `${v.pct}%`;
    case "perMonthEur": return `${v.eur} €/month`;
    case "perFillEur": return `${v.eur} €/fill`;
  }
  return "";
}

function renderDiscounts() {
  const all = state.catalog.discounts;
  const live = all.filter((d) => ["ok", "upcoming"].includes(availability(d)));
  const dead = all.filter((d) => !live.includes(d));
  const byBrand = (list) => {
    const groups = {};
    for (const d of list) (groups[d.brands.join(" / ")] ||= []).push(d);
    return Object.entries(groups).map(([b, ds]) =>
      `<div class="brand-block"><h3>${esc(b)}</h3>${ds.map((d) => discountItem(d, live.includes(d))).join("")}</div>`).join("");
  };
  $("discounts").innerHTML = byBrand(live);
  $("inactive").innerHTML = byBrand(dead);
  $("inactiveWrap").hidden = dead.length === 0;
  const reviewedAgo = daysSince(state.catalog.lastReviewed);
  $("catalogWarn").innerHTML = reviewedAgo > 30
    ? `<div class="warnbox">The discount list was last reviewed ${reviewedAgo} days ago (${esc(state.catalog.lastReviewed)}). Values may have changed.</div>` : "";

  $("discounts").addEventListener("change", (e) => {
    const t = e.target, id = t.dataset.id;
    if (!id) return;
    if (t.type === "checkbox") {
      state.enabled[id] = t.checked;
      const d = all.find((x) => x.id === id);
      if (t.checked && d.group) {
        // Same group = alternatives: untick the others.
        for (const o of all) if (o.group === d.group && o.id !== id && state.enabled[o.id]) {
          state.enabled[o.id] = false;
          const box = $(`d-${o.id}`);
          if (box) box.checked = false;
        }
      }
    } else {
      const n = Number(t.value);
      const key = `${id}.${t.dataset.field}`;
      if (t.value === "" || !isFinite(n)) delete state.overrides[key]; else state.overrides[key] = n;
    }
    save();
    renderTable();
  });
}

function renderStatus(data) {
  const el = $("status");
  if (data.source === "live") {
    el.className = "status";
    el.textContent = `Live prices from DGEG · latest station update ${data.updated} · fetched ${new Date().toLocaleTimeString()}`;
  } else {
    el.className = "status offline";
    el.textContent = `Couldn't reach DGEG (${data.error}). Showing the snapshot from ${data.generatedAt.slice(0, 10)} instead.`;
  }
}

function renderTable() {
  const data = state.prices[state.settings.fuelId];
  if (!data) return;
  const s = state.settings;
  const stats = brandStats(data.prices).filter((b) => b.count >= s.minStations);
  const rows = stats.map((b) => {
    const pump = b[s.stat];
    const disc = brandDiscount(b.brand, pump);
    return { ...b, pump, disc, eff: pump - disc.cents / 100 };
  }).sort((a, b) => a.eff - b.eff || b.count - a.count);
  const cheapestPump = Math.min(...rows.map((r) => r.pump));

  $("rows").innerHTML = rows.map((r, i) => {
    const applied = r.disc.applied.map(({ d, r: x }) =>
      `<span class="applied">${esc(d.name)}: −${x.total.toFixed(1)}c${x.bal && s.countBalance ? " <span class=\"badge balance\">balance</span>" : ""}${x.note ? ` (${esc(x.note)})` : ""}</span>`).join("");
    const diff = (r.eff - cheapestPump) * s.litresPerFill;
    return `<tr class="${i === 0 ? "best" : ""}">
      <td>${i + 1}</td>
      <td><strong>${esc(r.brand)}</strong>${i === 0 ? ` <span class="badge instant">best for you</span>` : ""}</td>
      <td>${r.count}</td>
      <td>${eur(r.pump)}<span class="applied">min ${eur(r.min)}</span></td>
      <td>${r.disc.cents > 0 ? `−${r.disc.cents.toFixed(1)}c${applied}` : `<span class="muted">—</span>`}</td>
      <td class="eff">${eur(r.eff)}</td>
      <td>${eur(r.eff * s.litresPerFill, 2)} €</td>
      <td>${diff <= -0.005 ? `<span style="color:var(--instant)">−${eur(-diff, 2)} €</span>` : diff >= 0.005 ? `+${eur(diff, 2)} €` : "="}</td>
    </tr>`;
  }).join("") || `<tr><td colspan="8" class="muted">No brands with at least ${s.minStations} stations for this fuel.</td></tr>`;
}

function renderFooter() {
  $("footer").innerHTML = `Prices: <a href="https://precoscombustiveis.dgeg.gov.pt/" target="_blank" rel="noopener">DGEG — Preços dos Combustíveis Online</a>.
    Discounts: <code>data/discounts.json</code>, last reviewed ${esc(state.catalog.lastReviewed)}. Always confirm the terms in each brand's app before relying on a discount.`;
}

async function update() {
  $("status").className = "status";
  $("status").textContent = "Loading prices…";
  const data = await getPrices(state.settings.fuelId);
  renderStatus(data);
  renderTable();
}

async function init() {
  load();
  try {
    state.catalog = await fetchJson("data/discounts.json");
  } catch (e) {
    $("status").className = "status offline";
    $("status").textContent = `Couldn't load data/discounts.json (${e.message}). Serve this folder over HTTP, e.g. "python3 -m http.server".`;
    return;
  }
  for (const d of state.catalog.discounts) if (!(d.id in state.enabled)) state.enabled[d.id] = d.defaultOn;
  renderControls();
  renderDiscounts();
  renderFooter();
  await update();
}

init();
