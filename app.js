// app.js — PowerApp. Products works on its own; Today reads PowerDesk's summary.json
// from the private repo's dashboard-data branch with a read-only token.
import { stepChart, scatterChart, crosshairGroup, legend, fmtClock } from "./charts.js";
import { MARKETS, getMarket, delivery, strip, todayIn, isoDate, parseIso, ymd, weekday, baseHours, isHoliday, MONTH_ABBR } from "./calendar.js";

const VERSION = "0.1.0";
const STORE = "powerapp.v1";
const DATA_CACHE = "pa-data-v1";
const DEFAULT_BRANCH = "dashboard-data";
const RAW = "application/vnd.github.raw+json";
const TABS = ["today", "products"];
const TZ = "Europe/Berlin";
const C = { price: "var(--s-1)", residual: "var(--s-2)", renew: "var(--s-3)", load: "var(--s-load)", hist: "var(--s-hist)", sel: "var(--ink)" };
const WD = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

// ------------------------------------------------------------------ helpers
function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  if (attrs) for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k === "text") el.textContent = v;
    else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v);
    else if (k === "style" && typeof v === "object") Object.assign(el.style, v);
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid == null || kid === false) continue;
    el.appendChild(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
  return el;
}
const $ = (sel) => document.querySelector(sel);
const MINUS = "−";
const nf0 = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });
const nf1 = new Intl.NumberFormat("en-US", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const nf2 = new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const neg = (s, v) => (v < 0 ? MINUS + s.slice(1) : s);
const p2 = (v) => (v == null ? "—" : neg(nf2.format(v), v));                 // prices, €/MWh
const p1 = (v) => (v == null ? "—" : neg(nf1.format(v), v));
const gw = (v) => (v == null ? "—" : neg(nf1.format(v), v));
const signed = (v, f = p2) => (v == null ? "—" : (v > 0 ? "+" : "") + f(v));
const eur = (v) => (v == null ? "—" : (v < 0 ? MINUS : "") + "€" + new Intl.NumberFormat("en-US", { maximumFractionDigits: Math.abs(v) < 100 ? 2 : 0 }).format(Math.abs(v)));
const int = (v) => (v == null ? "—" : nf0.format(v));
const upTo2 = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 });
const tick = (v) => (Math.abs(v) >= 1000 ? `${nf0.format(v / 1000)}K` : neg(String(+v.toFixed(Math.abs(v) >= 10 ? 0 : 1)), v));
function dayName(iso, long = false) {
  const n = parseIso(iso), { d, m } = ymd(n);
  return long ? `${WD[weekday(n)]} ${d} ${MONTH_ABBR[m - 1]}` : `${WD[weekday(n)]} ${d}`;
}
function ago(isoTs) {
  const s = (Date.now() - Date.parse(isoTs)) / 1000;
  if (!isFinite(s)) return "";
  if (s < 90) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400 * 1.5) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} days ago`;
}

// ------------------------------------------------------------------ storage
const store = {
  get() { try { return JSON.parse(localStorage.getItem(STORE) || "{}") || {}; } catch { return {}; } },
  set(v) { try { localStorage.setItem(STORE, JSON.stringify(v)); } catch { /* private mode */ } },
};
let cfg = store.get();
const saveCfg = (patch) => { cfg = { ...cfg, ...patch }; store.set(cfg); };
const connected = () => !!(cfg.token && cfg.repo);

async function cacheGet(name) {
  try {
    const c = await caches.open(DATA_CACHE);
    const r = await c.match(new URL(`__data/${name}`, location.href).href);
    return r ? { text: await r.text(), at: r.headers.get("x-fetched") } : null;
  } catch { return null; }
}
async function cachePut(name, text) {
  try {
    const c = await caches.open(DATA_CACHE);
    await c.put(new URL(`__data/${name}`, location.href).href,
      new Response(text, { headers: { "content-type": "application/json", "x-fetched": new Date().toISOString() } }));
  } catch { /* no Cache Storage (non-secure context) */ }
}
async function cacheClear() { try { await caches.delete(DATA_CACHE); } catch { /* ignore */ } }

// ------------------------------------------------------------------ GitHub
class GhError extends Error {
  constructor(status, message) { super(message || `HTTP ${status}`); this.status = status; }
}
async function gh(path, accept = "application/vnd.github+json", token = cfg.token) {
  let res;
  try {
    res = await fetch("https://api.github.com" + path, { headers: { Authorization: `Bearer ${token}`, Accept: accept }, cache: "no-cache" });
  } catch { throw new GhError(0, "Can't reach GitHub"); }
  if (!res.ok) {
    let msg = "";
    try { msg = (await res.json()).message || ""; } catch { /* not json */ }
    const err = new GhError(res.status, msg);
    err.rateLimited = res.status === 403 && res.headers.get("x-ratelimit-remaining") === "0";
    throw err;
  }
  return accept === RAW ? res.text() : res.json();
}
const contentsPath = (file, c = cfg) => `/repos/${c.repo}/contents/${file}?ref=${encodeURIComponent(c.branch || DEFAULT_BRANCH)}`;
const isPowerSummary = (s) => !!s && s.schema === 1 && Array.isArray(s.zones) && Array.isArray(s.days);

// ------------------------------------------------------------------ state
const state = { summary: null, source: null, fetchedAt: null, loading: false, error: null, tab: "today", ui: {} };
const ui = (k, dflt) => (k in state.ui ? state.ui[k] : (cfg.ui && k in cfg.ui ? cfg.ui[k] : dflt));
function setUi(k, v, persist) {
  state.ui[k] = v;
  if (persist) saveCfg({ ui: { ...(cfg.ui || {}), [k]: v } });
}
function applySummary(s, source, at) {
  if (!isPowerSummary(s)) throw new Error("Unexpected data format");
  state.summary = s;
  state.source = source;
  state.fetchedAt = at || new Date().toISOString();
}

let loadSeq = 0;
async function load({ force } = {}) {
  if (!connected()) return render();
  const seq = ++loadSeq;
  if (!state.summary) {
    const cs = await cacheGet("summary.json");
    try { if (cs) applySummary(JSON.parse(cs.text), "cache", cs.at); } catch { /* stale format */ }
    if (state.summary) render();
  }
  state.loading = true;
  renderStatus();
  try {
    const text = await gh(contentsPath("summary.json"), RAW);
    if (seq !== loadSeq) return;
    const s = JSON.parse(text);
    const changed = !state.summary || state.summary.generated_utc !== s.generated_utc || state.source === "cache";
    applySummary(s, "network");
    state.error = null;
    cachePut("summary.json", text);
    if (changed || force) render();
  } catch (e) {
    if (seq !== loadSeq) return;
    state.error = e;
    render();
  } finally {
    if (seq === loadSeq) { state.loading = false; renderStatus(); }
  }
}

// ------------------------------------------------------------------ routing
function route() {
  const raw = location.hash.replace(/^#\/?/, "");
  const [path, query] = raw.split("?");
  const parts = path.split("/").filter(Boolean);
  const q = new URLSearchParams(query || "");
  if (parts[0] === "zone" && parts[1]) return { sheet: { type: "zone", code: decodeURIComponent(parts[1]) }, q };
  if (parts[0] === "settings") return { sheet: { type: "settings" }, q };
  return { tab: TABS.includes(parts[0]) ? parts[0] : "today", q };
}
let sheetPushed = false;
function go(hash) { location.hash = hash; }
function openZone(code) { sheetPushed = true; go(`#/zone/${encodeURIComponent(code)}`); }
function openSettings() { sheetPushed = true; go("#/settings"); }
function closeSheet() {
  if (sheetPushed) { sheetPushed = false; history.back(); }
  else go(`#/${state.tab}`);
}

// ------------------------------------------------------------------ shell
const app = $("#app");
let lastFocus = null, renderedTab = null;

function render() {
  applyTheme();
  const r = route();
  if (r.tab) state.tab = r.tab;
  renderedTab = state.tab;
  const main = h("main", { id: "view", tabindex: "-1" });
  app.replaceChildren(rail(), h("div", { class: "main-col" }, topbar(), h("div", { id: "status" }), main), tabbar());
  renderStatus();
  const view = { today: viewToday, products: viewProducts }[state.tab];
  try { main.appendChild(view()); }
  catch (e) { console.error(e); main.appendChild(h("p", { class: "empty", text: `This view couldn't be drawn: ${e.message}` })); }
  const sy = state.ui[`scroll:${state.tab}`];
  if (sy != null && !r.sheet) requestAnimationFrame(() => window.scrollTo(0, sy));
  renderSheet(r.sheet);
}

function brand() {
  return h("span", { class: "brand" }, h("img", { src: "icons/icon.svg", alt: "", width: 26, height: 26 }), h("span", { class: "brand-name", text: "PowerApp" }));
}
const TAB_LABEL = { today: "Today", products: "Products" };
const TAB_ICON = {
  today: "M3 17h3v-4h3v-6h3v9h3v-5h3v3h3",
  products: "M4 5h16v14H4zM4 10h16M9 10v9M14 10v9",
};
function navIcon(d) {
  const s = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  s.setAttribute("viewBox", "0 0 24 24"); s.setAttribute("aria-hidden", "true"); s.setAttribute("class", "nav-ico");
  const p = document.createElementNS("http://www.w3.org/2000/svg", "path");
  p.setAttribute("d", d);
  s.appendChild(p);
  return s;
}
function navLinks(cls) {
  return TABS.map((t) => h("a", {
    href: `#/${t}`, class: cls, "aria-current": state.tab === t ? "page" : null,
    onclick: () => { state.ui[`scroll:${state.tab}`] = window.scrollY; },
  }, navIcon(TAB_ICON[t]), h("span", { text: TAB_LABEL[t] })));
}
function rail() {
  return h("aside", { class: "rail" }, brand(), h("nav", { class: "rail-nav", "aria-label": "Sections" }, navLinks("rail-link")),
    h("div", { class: "rail-foot" },
      state.summary ? h("p", { class: "muted" }, `Brief for ${dayName(state.summary.today, true)}`) : null,
      h("button", { class: "linkish", type: "button", onclick: openSettings }, "Settings")));
}
function tabbar() { return h("nav", { class: "tabbar", "aria-label": "Sections" }, navLinks("tab-link")); }
function topbar() {
  const s = state.summary;
  return h("header", { class: "topbar" },
    h("div", { class: "topbar-brand" }, brand()),
    h("div", { class: "topbar-meta" },
      s ? h("span", { class: "asof" }, `Brief for ${dayName(s.today, true)}`) : null,
      s ? h("span", { class: "updated", title: s.generated_utc }, `built ${ago(s.generated_utc)}`) : null),
    h("div", { class: "topbar-actions" },
      connected() ? h("button", { class: "icon-btn", type: "button", "aria-label": "Refresh", title: "Refresh", id: "refresh-btn", onclick: () => load({ force: true }) },
        navIcon("M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7")) : null,
      h("button", { class: "icon-btn", type: "button", "aria-label": "Settings", title: "Settings", onclick: openSettings },
        navIcon("M12 8.5a3.5 3.5 0 1 0 0 7a3.5 3.5 0 1 0 0-7M19.4 13.5l1.6 1.2-2 3.4-1.9-.6a7 7 0 0 1-1.7 1l-.4 2h-4l-.4-2a7 7 0 0 1-1.7-1l-1.9.6-2-3.4 1.6-1.2a7 7 0 0 1 0-3l-1.6-1.2 2-3.4 1.9.6a7 7 0 0 1 1.7-1l.4-2h4l.4 2a7 7 0 0 1 1.7 1l1.9-.6 2 3.4-1.6 1.2a7 7 0 0 1 0 3z"))));
}

function renderStatus() {
  const el = $("#status");
  const btn = $("#refresh-btn");
  if (btn) btn.classList.toggle("spinning", state.loading);
  if (!el) return;
  el.replaceChildren();
  if (state.tab !== "today") return;
  const e = state.error;
  if (!e) {
    if (state.summary && state.source === "cache" && !state.loading)
      el.appendChild(h("p", { class: "banner" }, `Showing the saved brief for ${dayName(state.summary.today, true)}.`));
    return;
  }
  let msg, action = null;
  if (e.status === 0) msg = state.summary ? `Offline. Showing the saved brief for ${dayName(state.summary.today, true)}.` : "Can't reach GitHub. Check your connection, then refresh.";
  else if (e.status === 401) { msg = "GitHub rejected the token; it may have expired or been revoked. Add a new one in Settings."; action = ["Open settings", openSettings]; }
  else if (e.status === 404) { msg = `No brief in ${cfg.repo} yet. Either the token can't read that repository, or the brief workflow hasn't published to the ${cfg.branch || DEFAULT_BRANCH} branch.`; action = ["Open settings", openSettings]; }
  else if (e.rateLimited) msg = "GitHub's rate limit is used up for now. Try again in a few minutes.";
  else msg = `Loading failed: ${e.message}`;
  el.appendChild(h("div", { class: "banner warn", role: "status" }, h("span", { text: msg }),
    action ? h("button", { class: "linkish", type: "button", onclick: action[1] }, action[0]) : null));
}

// ------------------------------------------------------------------ shared bits
function section(cls, ...kids) { return h("section", { class: `band ${cls || ""}`.trim() }, kids); }
function kicker(text) { return h("p", { class: "kicker", text }); }
function stat(label, value, sub) {
  return h("div", { class: "stat" }, h("span", { class: "stat-label", text: label }), h("span", { class: "stat-val", text: value }),
    sub ? h("span", { class: "stat-sub" }, sub) : null);
}
function seg(label, options, cur, onPick) {
  return h("div", { class: "seg", role: "group", "aria-label": label },
    options.map((o) => h("button", { type: "button", class: "seg-btn", "aria-pressed": String(o.value === cur), disabled: o.disabled || null,
      title: o.title || null, onclick: () => onPick(o.value) }, o.label)));
}
function table(head, rows, { cls = "", caption } = {}) {
  return h("div", { class: "table-wrap" }, h("table", { class: `tbl ${cls}`.trim() },
    caption ? h("caption", { class: "sr-only", text: caption }) : null,
    h("thead", null, h("tr", null, head.map((x) => (typeof x === "string" ? h("th", { scope: "col", text: x }) : x)))),
    h("tbody", null, rows)));
}
const num = (text, cls = "") => h("td", { class: `num ${cls}`.trim(), text });

// ------------------------------------------------------------------ Today
function zoneStats(z, day) { return z && z.days ? z.days[day] || null : null; }
function pickDay(s) {
  const has = (d) => s.zones.some((z) => zoneStats(z, d));
  const [, today, tomorrow] = s.days;
  let day = ui("day", null);
  if (!s.days.includes(day) || !has(day)) day = has(tomorrow) ? tomorrow : today;
  return { day, has };
}
function dayWord(s, day) { return ["Yesterday", "Today", "Tomorrow"][s.days.indexOf(day)] || day; }

function viewToday() {
  if (!connected()) return connectCard();
  const s = state.summary;
  if (!s) return h("div", { class: state.error ? "" : "loading-shell" }, state.error ? null : h("p", { text: "Loading the brief…" }));
  const { day, has } = pickDay(s);
  const de = s.zones.find((z) => z.code === "DE");
  const st = zoneStats(de, day);
  const idx = s.days.indexOf(day);
  const prevDay = idx > 0 ? s.days[idx - 1] : null;
  const prev = prevDay ? zoneStats(de, prevDay) : null;

  const daySeg = seg("Delivery day", s.days.map((d, i) => ({
    value: d, label: ["Yesterday", "Today", "Tomorrow"][i], disabled: !has(d),
    title: has(d) ? dayName(d, true) : "Not published yet: tomorrow's prices come out after the noon auction",
  })), day, (d) => { setUi("day", d); render(); });

  const head = section("brief-head",
    kicker("Day-ahead auction · €/MWh"),
    h("h1", { class: "headline", text: `${dayWord(s, day)}, ${dayName(day, true)}` }),
    h("div", { class: "filters" }, daySeg),
    has(s.days[2]) ? null : h("p", { class: "note", text: "Tomorrow appears after the noon auction is published; the brief runs at 08:23, 13:41 and 18:47." }));

  let hero;
  if (st) {
    const weekend = st.peak == null;
    hero = section("de-hero",
      h("h2", { class: "h2", text: "Germany-Luxembourg" }),
      h("div", { class: "stats" },
        stat("Base", p2(st.base), prev && prev.complete ? `${signed(st.base - prev.base)} vs ${dayName(prevDay)}` : null),
        stat("Peak", weekend ? "—" : p2(st.peak), weekend ? "No peak hours on weekends" : "Mon–Fri 08–20"),
        stat("Off-peak", p2(st.offpeak)),
        stat("Low", p2(st.min), `at ${st.min_at}`),
        stat("High", p2(st.max), `at ${st.max_at}`),
        stat("Negative", `${upTo2.format(st.negative_hours)} h`, st.negative_hours ? "below zero" : "no hours below zero")),
      st.complete ? null : h("p", { class: "note", text: `Only ${st.hours} of ${st.day_hours} hours are in so far.` }));
  } else hero = section("de-hero", h("p", { class: "empty", text: "No German prices for this day." }));

  return h("div", { class: "today" }, head, hero, zonesBand(s, day), residualBand(s, day), sourceNote(s));
}

function zonesBand(s, day) {
  const deBase = zoneStats(s.zones.find((z) => z.code === "DE"), day)?.base;
  const anyPeak = s.zones.some((z) => zoneStats(z, day)?.peak != null);   // none on weekends
  const cols = anyPeak ? 6 : 5;
  const rows = s.zones.map((z) => {
    const open = { class: "tappable", tabindex: "0", onclick: () => openZone(z.code), onkeydown: (e) => { if (e.key === "Enter") openZone(z.code); } };
    const name = h("th", { scope: "row" }, h("b", { text: z.code }), h("span", { class: "zn", text: z.name }));
    const st = zoneStats(z, day);
    if (!st) return h("tr", open, name, h("td", { class: "muted", colspan: String(cols), text: z.error ? `No data (${z.error})` : "Not published" }));
    const vs = z.code === "DE" || deBase == null ? null : st.base - deBase;
    return h("tr", open, name,
      num(p2(st.base)), anyPeak ? num(st.peak == null ? "—" : p2(st.peak)) : null,
      num(z.code === "DE" ? "" : signed(vs)),
      num(p2(st.min), "wide"), num(p2(st.max), "wide"),
      num(st.negative_hours ? upTo2.format(st.negative_hours) : "", "wide"));
  });
  const head = ["Zone", "Base", anyPeak ? "Peak" : null, "vs DE",
    h("th", { class: "wide", text: "Low" }), h("th", { class: "wide", text: "High" }), h("th", { class: "wide", text: "Neg h" })].filter(Boolean);
  return section("zones",
    h("h2", { class: "h2", text: "Across Europe" }),
    table(head, rows, { cls: "zones-tbl", caption: "Day-ahead prices by bidding zone" }),
    h("p", { class: "note", text: `Base is the average over every quarter-hour of the day; ${anyPeak ? "peak follows each market's own definition (Poland: 07–22 on working days)" : "there are no peak hours on a weekend"}. vs DE is the base spread to Germany. Tap a zone for its curve.` }));
}

// Rows whose hour falls on the given local delivery day.
const dayRows = (rows, day) => (rows || []).filter((r) => isoDate(todayIn(TZ, r[0] * 1000)) === day);

function residualBand(s, day) {
  const de = s.de || {};
  const sec = section("residual", kicker("Germany-Luxembourg"), h("h2", { class: "h2", text: "Residual load and price" }));
  if (de.error) { sec.appendChild(h("p", { class: "empty", text: `No fundamentals in this brief (${de.error}).` })); return sec; }
  const isYesterday = s.days.indexOf(day) === 0;
  const rows = dayRows(isYesterday ? de.actual : de.forecast, day);
  const priceZone = s.zones.find((z) => z.code === "DE");
  const pt = [], pv = [];
  if (priceZone && priceZone.series) priceZone.series.t.forEach((t, i) => { if (isoDate(todayIn(TZ, t * 1000)) === day) { pt.push(t); pv.push(priceZone.series.v[i]); } });
  sec.appendChild(h("p", { class: "lede", text: isYesterday
    ? "Residual load is what's left of demand after wind and solar: load minus wind minus solar. Yesterday's numbers are actuals."
    : "Residual load is what's left of demand after wind and solar: load minus wind minus solar. These are the TSOs' day-ahead forecasts, which is what the auction priced." }));

  const box = h("div", { class: "chart-box" });
  sec.appendChild(box);
  const group = crosshairGroup();
  if (pt.length) {
    box.appendChild(h("h3", { class: "h3", text: "Price, €/MWh" }));
    stepChart(box, { t: pt, step: (pt[1] - pt[0]) || 900, series: [{ name: "Price", values: pv, color: C.price }], tz: TZ, fmt: p2, tickFmt: tick, height: 140, group, label: `German day-ahead price, ${dayName(day, true)}` });
  }
  if (rows.length) {
    box.appendChild(h("h3", { class: "h3", text: `Load, wind + solar and residual load, GW${isYesterday ? "" : " (forecast)"}` }));
    const t = rows.map((r) => r[0]);
    stepChart(box, { t, step: 3600, tz: TZ, fmt: gw, tickFmt: tick, height: 140, group, label: "Load, wind plus solar and residual load in gigawatts",
      series: [
        { name: "Load", values: rows.map((r) => r[1]), color: C.load },
        { name: "Wind + solar", values: rows.map((r) => +(r[2] + r[3]).toFixed(2)), color: C.renew },
        { name: "Residual", values: rows.map((r) => r[4]), color: C.residual },
      ] });
    box.appendChild(legend([{ name: "Load", color: C.load }, { name: "Wind + solar", color: C.renew }, { name: "Residual load", color: C.residual }]));
    sec.appendChild(h("details", { class: "raw" }, h("summary", { text: "Show the hours as a table" }),
      table(["Hour", "Price", "Load", "Wind", "Solar", "Residual"], rows.map((r) => h("tr", null,
        h("th", { scope: "row", text: fmtClock(r[0], TZ) }), num(p2(r[5])), num(gw(r[1])), num(gw(r[3])), num(gw(r[2])), num(gw(r[4])))))));
  } else if (!isYesterday) {
    sec.appendChild(h("p", { class: "note", text: "The day-ahead forecast for this day isn't in the brief yet; TSOs publish it by 18:00 the day before." }));
  }

  // The supply curve, revealed: 14 days of hours, with the chosen day on top.
  const hist = (de.scatter && de.scatter.points) || [];
  if (hist.length) {
    const selPts = rows.filter((r) => r[5] != null).map((r) => ({ x: r[4], y: r[5], label: `${dayName(day)} ${fmtClock(r[0], TZ)}` }));
    sec.appendChild(h("h3", { class: "h3 sp", text: "Price against residual load" }));
    sec.appendChild(h("p", { class: "note", text: `Each dot is one hour of the last ${de.scatter.days} days. The cloud traces the merit order: low residual load means cheap plants set the price, high residual load reaches the expensive ones.` }));
    const sbox = h("div", { class: "chart-box" });
    sec.appendChild(sbox);
    scatterChart(sbox, {
      groups: [
        { name: `Last ${de.scatter.days} days`, color: C.hist, cls: "hist", points: hist.map(([x, y, hr]) => ({ x, y, label: `${String(hr).padStart(2, "0")}:00` })) },
        ...(selPts.length ? [{ name: dayName(day, true), color: C.sel, cls: "sel", r: 4.5, points: selPts }] : []),
      ],
      xFmt: tick, yFmt: tick, xTitle: "Residual load, GW", yTitle: "€/MWh", height: 260,
      xName: "Residual", yName: "Price", xRead: (v) => `${gw(v)} GW`, yRead: p2,
      label: "Scatter of hourly German day-ahead price against residual load",
    });
    sbox.appendChild(legend([{ name: `Last ${de.scatter.days} days, hourly`, color: C.hist, dot: true },
      ...(selPts.length ? [{ name: `${dayName(day, true)}${isYesterday ? "" : " (forecast load)"}`, color: C.sel, dot: true }] : [])]));
    sec.appendChild(supplyTable(hist));
  }
  return sec;
}

// The scatter's table twin: the curve in residual-load bands.
function supplyTable(points) {
  const bands = [[-Infinity, 0, "Below 0 GW"], [0, 15, "0–15 GW"], [15, 30, "15–30 GW"], [30, 45, "30–45 GW"], [45, Infinity, "45 GW and up"]];
  const rows = bands.map(([lo, hi, name]) => {
    const inBand = points.filter(([x]) => x >= lo && x < hi);
    if (!inBand.length) return null;
    const prices = inBand.map(([, y]) => y).sort((a, b) => a - b);
    const avg = prices.reduce((a, b) => a + b, 0) / prices.length;
    const med = prices[Math.floor(prices.length / 2)];
    return h("tr", null, h("th", { scope: "row", text: name }), num(int(inBand.length)), num(p1(avg)), num(p1(med)), num(p1(prices[0])), num(p1(prices[prices.length - 1])));
  }).filter(Boolean);
  return h("details", { class: "raw" }, h("summary", { text: "Show the curve in numbers" }),
    table(["Residual load", "Hours", "Average", "Median", "Low", "High"], rows, { caption: "Price by residual load band" }));
}

function sourceNote(s) {
  return h("div", { class: "pipeline" },
    h("p", null, `Source: ${s.source}. Prices for some zones are licensed for private, non-commercial use only. Brief built ${ago(s.generated_utc)}.`));
}

// ------------------------------------------------------------------ zone sheet
function viewZone(code) {
  const s = state.summary;
  const z = s && s.zones.find((x) => x.code === code);
  if (!z) return h("div", null, h("h2", { class: "st-title", text: code }), h("p", { class: "empty", text: "This zone isn't in the brief." }));
  const wrap = h("div", { class: "zone-sheet" },
    h("div", { class: "st-head" }, h("h2", { class: "st-title", text: `${z.name}` }),
      h("p", { class: "st-sub" }, h("span", { text: z.code }), h("span", { text: z.peak_rule }), z.step_min ? h("span", { text: `${z.step_min}-minute prices` }) : null)));
  if (z.error) { wrap.appendChild(h("p", { class: "empty", text: `The brief couldn't get this zone: ${z.error}.` })); return wrap; }
  const box = h("div", { class: "chart-box" });
  wrap.appendChild(box);
  requestAnimationFrame(() => stepChart(box, { t: z.series.t, step: z.step_min * 60, series: [{ name: "Price", values: z.series.v, color: C.price }], tz: TZ, fmt: p2, tickFmt: tick, height: 170,
    label: `${z.name} day-ahead price, yesterday to tomorrow` }));
  // Metrics down, published days across: fits a phone.
  const days = s.days.filter((d) => zoneStats(z, d));
  const stats = days.map((d) => zoneStats(z, d));
  const metric = (name, f) => h("tr", null, h("th", { scope: "row", text: name }), stats.map((st) => num(f(st))));
  const rows = [
    metric("Base", (st) => p2(st.base)),
    metric("Peak", (st) => (st.peak == null ? "none" : p2(st.peak))),
    metric("Off-peak", (st) => p2(st.offpeak)),
    metric("Low", (st) => p2(st.min)),
    metric("at", (st) => st.min_at),
    metric("High", (st) => p2(st.max)),
    metric("at", (st) => st.max_at),
    metric("Negative hours", (st) => upTo2.format(st.negative_hours)),
    metric("Hours in", (st) => `${upTo2.format(st.hours)} of ${st.day_hours}`),
  ];
  wrap.appendChild(table(["", ...days.map((d) => dayName(d))], rows, { cls: "zone-stats", caption: `${z.name} daily statistics` }));
  if (days.length < s.days.length) wrap.appendChild(h("p", { class: "note", text: "Tomorrow's prices aren't in the brief yet." }));
  if (z.license) wrap.appendChild(h("p", { class: "note", text: `Data licence: ${z.license}` }));
  return wrap;
}

// ------------------------------------------------------------------ Products
function productsCfg() { return { market: "DE", code: "Cal27", mw: 10, price: "", move: 0.25, ...(cfg.products || {}) }; }

function viewProducts() {
  const pc = productsCfg();
  const market = getMarket(MARKETS[pc.market] ? pc.market : "DE");
  const asof = todayIn(market.tz);
  const out = h("div", { class: "prod-out", "aria-live": "polite" });
  const save = (patch) => { saveCfg({ products: { ...productsCfg(), ...patch } }); draw(); };

  const marketSel = h("select", { class: "select", "aria-label": "Market", onchange: (e) => { save({ market: e.target.value }); render(); } },
    Object.values(MARKETS).sort((a, b) => a.name.localeCompare(b.name)).map((m) => h("option", { value: m.code, selected: m.code === market.code || null }, `${m.name} (${m.code})`)));
  const codeIn = h("input", { class: "input", value: pc.code, autocomplete: "off", spellcheck: "false", "aria-label": "Product", placeholder: "Cal27, Q1-27, Nov26, Wk45, WE, BOM…",
    oninput: (e) => save({ code: e.target.value }) });
  const numIn = (key, label, step) => h("label", { class: "field" }, h("span", { text: label }),
    h("input", { class: "input", type: "number", inputmode: "decimal", step, value: pc[key], oninput: (e) => save({ [key]: e.target.value }) }));
  const quick = [["DA", "DA"], ["WE", "WE"], ["BOM", "BOM"], ["Next week", `Wk${(isoWeek(asof + 7)).week}`], ...strip(asof).filter((c, i) => [0, 3, 9].includes(i)).map((c) => [c, c])];
  const chips = h("div", { class: "chips" }, quick.map(([label, code]) => h("button", { type: "button", class: "chip", onclick: () => { codeIn.value = code; save({ code }); } }, label)));

  function draw() {
    const p = productsCfg();
    out.replaceChildren(resultCard(p, market, asof));
  }
  draw();
  return h("div", { class: "products" },
    section("prod-form",
      kicker("Delivery hours and what a price move is worth"),
      h("h1", { class: "headline", text: "Products" }),
      h("div", { class: "form-grid" },
        h("label", { class: "field" }, h("span", { text: "Market" }), marketSel),
        h("label", { class: "field" }, h("span", { text: "Product" }), codeIn),
        numIn("mw", "Size, MW", "1"), numIn("move", "Price move, €/MWh", "0.01"), numIn("price", "Price, €/MWh (optional)", "0.01")),
      chips),
    section("prod-result", out),
    section("prod-strip", stripTable(market, asof, (code) => { codeIn.value = code; save({ code }); window.scrollTo({ top: 0, behavior: "smooth" }); })),
    section("prod-notes", conventions(market)));
}
function isoWeek(n) { const th = n - weekday(n) + 3, y = ymd(th).y; return { year: y, week: Math.floor((th - parseIso(`${y}-01-01`)) / 7) + 1 }; }

function resultCard(p, market, asof) {
  let d;
  try { d = delivery(p.code, market.code, asof); }
  catch (e) { return h("p", { class: "warn-text", text: e.message }); }
  const mw = parseFloat(p.mw), move = parseFloat(p.move), price = parseFloat(p.price);
  const ok = (x) => isFinite(x);
  const per = d.period;
  const span = per.days === 1 ? dayLong(per.start) : `${dayLong(per.start)} – ${dayLong(per.lastDay)}`;
  const rows = [["Base", "base"], ["Peak", "peak"], ["Off-peak", "offpeak"]].map(([name, k]) => {
    const hrs = d.hours[k];
    return h("tr", null, h("th", { scope: "row", text: name }), num(int(hrs)), num(int(hrs * 4), "wide"),
      num(ok(mw) ? int(hrs * mw) : "—"), num(ok(mw) && ok(move) ? eur(hrs * mw * move) : "—"),
      ok(price) ? num(ok(mw) ? eur(hrs * mw * price) : "—") : null);
  });
  const head = ["", "Hours", h("th", { class: "wide", text: "Quarter-hours" }), "MWh", "Move value", ok(price) ? "Notional" : null].filter((x) => x != null);
  // Clock changes and holidays inside the delivery period
  const odd = [];
  for (let n = per.start; n < per.end; n++) {
    const bh = baseHours(n, market);
    if (bh !== 24) odd.push(`${dayLong(n)} has ${bh} hours`);
  }
  let hol = 0;
  if (market.peak.holidays) for (let n = per.start; n < per.end; n++) if (weekday(n) < 5 && isHoliday(n, market.peak.holidays)) hol++;
  const lead = ok(mw) && ok(move) && d.hours.base
    ? `A ${p2(move)} €/MWh move on ${int(mw)} MW of ${per.label} base is worth ${eur(d.hours.base * mw * move)}. One tick (0.01) is ${eur(d.hours.base * mw * 0.01)}.`
    : null;
  return h("div", { class: "result" },
    h("div", { class: "res-head" }, h("h2", { class: "h2", text: per.label }), h("span", { class: "muted", text: `${market.code} · ${span}` })),
    lead ? h("p", { class: "lede", text: lead }) : null,
    table(head, rows, { caption: `${per.label} delivery` }),
    odd.length ? h("p", { class: "note", text: `Clock change: ${odd.join("; ")}.` }) : null,
    hol ? h("p", { class: "note", text: `${hol} Polish public holiday${hol > 1 ? "s fall" : " falls"} on weekdays here, so ${hol > 1 ? "they deliver" : "it delivers"} no peak.` }) : null,
    per.kind === "Weekend" ? h("p", { class: "note", text: "Weekends have no peak hours." }) : null);
}
const dayLong = (n) => { const { d, m, y } = ymd(n); return `${WD[weekday(n)]} ${d} ${MONTH_ABBR[m - 1]} ${y}`; };

function stripTable(market, asof, pick) {
  const rows = strip(asof).map((code) => {
    const d = delivery(code, market.code, asof);
    return h("tr", { class: "tappable", tabindex: "0", onclick: () => pick(code), onkeydown: (e) => { if (e.key === "Enter") pick(code); } },
      h("th", { scope: "row", text: d.period.label }), num(int(d.period.days)), num(int(d.hours.base)), num(int(d.hours.peak)), num(int(d.hours.offpeak)));
  });
  return h("div", null, h("h2", { class: "h2", text: "The strip" }),
    h("p", { class: "note", text: `The next months, quarters, seasons and years in ${market.name}. Tap one to price it.` }),
    table(["Product", "Days", "Base h", "Peak h", "Off-peak h"], rows, { caption: "Standard products and their hours" }));
}

function conventions(market) {
  return h("div", { class: "conventions" }, h("h2", { class: "h2", text: "How to read a quote" }),
    h("ul", { class: "facts-list" },
      h("li", null, h("b", { text: "Cal27" }), " is calendar-year 2027 baseload: 1 MW in every hour of 2027. Unless someone names a zone, it's usually Germany."),
      h("li", null, h("b", { text: "Prices" }), " are in €/MWh, so \"25 cents\" means 0.25 €/MWh, and one tick is 0.01."),
      h("li", null, h("b", { text: "X at Y" }), " is bid at offer. \"Mine\" lifts the offer, \"yours\" hits the bid; \"paid\" and \"given\" say it traded there. \"In 5\" is 5 MW."),
      h("li", null, h("b", { text: "Peak" }), ` in ${market.name} means ${market.peak.holidays ? "07:00–22:00 on Polish working days (TGE PEAK5)" : "Monday–Friday 08:00–20:00, public holidays included (EEX)"}. Off-peak is every other hour.`),
      h("li", null, h("b", { text: "Hours" }), " are real elapsed hours: the day the clocks go forward has 23, the day they go back has 25.")));
}

// ------------------------------------------------------------------ sheets
function renderSheet(sheet) {
  const root = $("#sheet-root");
  if (!sheet) {
    if (root.childNodes.length) {
      root.replaceChildren();
      document.body.classList.remove("sheet-open");
      if (lastFocus && document.contains(lastFocus)) lastFocus.focus();
    }
    return;
  }
  if (!root.childNodes.length) lastFocus = document.activeElement;
  let content, label;
  if (sheet.type === "settings") { content = viewSettings(); label = "Settings"; }
  else { content = viewZone(sheet.code); label = sheet.code; }
  const panel = h("div", { class: `sheet ${sheet.type}`, role: "dialog", "aria-modal": "true", "aria-label": label, tabindex: "-1" },
    h("button", { class: "icon-btn sheet-close", type: "button", "aria-label": "Close", onclick: closeSheet }, navIcon("M6 6l12 12M18 6L6 18")),
    content);
  root.replaceChildren(h("div", { class: "scrim", onclick: closeSheet }), panel);
  document.body.classList.add("sheet-open");
  panel.focus({ preventScroll: true });
}
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && $("#sheet-root").childNodes.length) closeSheet(); });

// ------------------------------------------------------------------ connecting
const TOKEN_URL = "https://github.com/settings/personal-access-tokens/new?" + new URLSearchParams({
  name: "PowerApp", description: "Read-only access for the PowerApp", expires_in: "366", contents: "read",
}).toString();
const TOKENS_URL = "https://github.com/settings/personal-access-tokens";

// The repository this app is served from on GitHub Pages (owner.github.io/repo) never holds the brief.
function appRepo() {
  const m = location.hostname.match(/^([^.]+)\.github\.io$/i);
  const segm = location.pathname.split("/").filter(Boolean)[0];
  return m && segm ? `${m[1]}/${segm}`.toLowerCase() : null;
}
const isAppRepo = (full) => !!full && full.toLowerCase() === appRepo();

async function findBriefRepo(token) {
  const repos = await gh("/user/repos?per_page=100&sort=pushed", undefined, token);
  const cands = repos.filter((r) => r.permissions?.pull && !isAppRepo(r.full_name)).slice(0, 30);
  const found = await Promise.all(cands.map(async (r) => {
    try {
      const text = await gh(contentsPath("summary.json", { repo: r.full_name, branch: DEFAULT_BRANCH }), RAW, token);
      return isPowerSummary(JSON.parse(text)) ? r.full_name : null;
    } catch { return null; }
  }));
  return { withBrief: found.filter(Boolean), privateRepos: cands.filter((r) => r.private).map((r) => r.full_name) };
}

function connectForm({ compact } = {}) {
  const tokenIn = h("input", { type: "password", class: "input", placeholder: "github_pat_…", autocomplete: "off", spellcheck: "false", id: "tok" });
  const msg = h("p", { class: "form-msg", role: "status" });
  const pick = h("div", { class: "pick row-btns" });
  const finish = (repo, token) => { saveCfg({ token, repo, branch: DEFAULT_BRANCH }); state.summary = null; go("#/today"); render(); load({ force: true }); };
  const connect = async () => {
    const token = tokenIn.value.trim();
    if (!token) { msg.textContent = "Paste the token first."; tokenIn.focus(); return; }
    msg.textContent = "Checking with GitHub…";
    try {
      const { withBrief, privateRepos } = await findBriefRepo(token);
      if (withBrief.length === 1) return finish(withBrief[0], token);
      const list = withBrief.length ? withBrief : privateRepos;
      if (!list.length) {
        msg.replaceChildren("This token can't read your PowerDesk repository. On GitHub, edit the token: under Repository access pick Only select repositories and PowerDesk, and under Permissions add Contents: Read-only. ",
          h("a", { href: TOKENS_URL, target: "_blank", rel: "noopener" }, "Open your tokens"));
        return;
      }
      msg.textContent = withBrief.length ? "Which repository holds the brief?" : "No brief found yet. Which repository runs PowerDesk?";
      pick.replaceChildren(...list.map((full) => h("button", { type: "button", class: "btn ghost small", onclick: () => finish(full, token) }, full)));
    } catch (e) {
      msg.textContent = e.status === 401 ? "GitHub rejected that token. Check you copied all of it."
        : e.status === 0 ? "Can't reach GitHub. Check your connection." : `That didn't work: ${e.message}`;
    }
  };
  return h("ol", { class: "steps" },
    h("li", null, h("a", { class: "btn", href: TOKEN_URL, target: "_blank", rel: "noopener" }, "Create a read-only token"),
      compact ? null : h("p", { class: "muted" }, "On GitHub, set Repository access to Only select repositories and pick PowerDesk (the private repository, not this app's). Contents read access is already filled in. Generate the token and copy it.")),
    h("li", null, h("label", { class: "field", for: "tok" }, h("span", { text: "Paste the token" }), tokenIn),
      h("button", { type: "button", class: "btn", onclick: connect }, "Connect"), msg, pick));
}

function connectCard() {
  return h("div", { class: "connect" },
    section("connect-card",
      h("img", { src: "icons/icon.svg", alt: "", width: 52, height: 52, class: "setup-icon" }),
      h("h1", { class: "title", text: "Connect the brief" }),
      h("p", { class: "lede", text: "Today shows the day-ahead brief that PowerDesk builds three times a day in your private repository. The app reads it with a read-only GitHub token that stays on this device. Products works without it." }),
      connectForm(),
      h("p", { class: "muted small", text: "Have a setup link from another device? Open it on this one and you're connected." })));
}

// ------------------------------------------------------------------ settings
const NTFY_PLAY = "https://play.google.com/store/apps/details?id=io.heckel.ntfy";
const NTFY_IOS = "https://apps.apple.com/app/ntfy/id1625396347";
async function sendPush(topic, title, message) {
  const r = await fetch(`https://ntfy.sh/${encodeURIComponent(topic)}`, { method: "POST", body: message, headers: { Title: title, Tags: "zap" } });
  if (!r.ok) throw new Error(`ntfy answered ${r.status}`);
}

function viewSettings() {
  const theme = cfg.theme || "system";
  const themeSeg = seg("Theme", [{ value: "system", label: "Match device" }, { value: "light", label: "Light" }, { value: "dark", label: "Dark" }], theme,
    (v) => { saveCfg({ theme: v }); render(); });
  const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent);
  const standalone = matchMedia("(display-mode: standalone)").matches || navigator.standalone;
  const install = installPrompt ? h("button", { type: "button", class: "btn", onclick: async () => { installPrompt.prompt(); installPrompt = null; render(); } }, "Install PowerApp") : null;

  // Connection
  let conn;
  if (connected()) {
    const msg = h("p", { class: "form-msg", role: "status" });
    const repoIn = h("input", { type: "text", class: "input", value: cfg.repo, autocomplete: "off", spellcheck: "false" });
    const branchIn = h("input", { type: "text", class: "input", value: cfg.branch || DEFAULT_BRANCH, autocomplete: "off", spellcheck: "false" });
    const tokenIn = h("input", { type: "password", class: "input", placeholder: "github_pat_…", autocomplete: "off", spellcheck: "false" });
    const saveConn = async () => {
      const next = { token: tokenIn.value.trim() || cfg.token, repo: repoIn.value.trim(), branch: branchIn.value.trim() || DEFAULT_BRANCH };
      msg.textContent = "Checking…";
      try {
        const text = await gh(contentsPath("summary.json", next), RAW, next.token);
        if (!isPowerSummary(JSON.parse(text))) { msg.textContent = "That branch has a summary.json, but it isn't a PowerDesk brief."; return; }
        saveCfg(next); state.summary = null; await cacheClear(); msg.textContent = "Connected. Brief found."; load({ force: true });
      } catch (e) { msg.textContent = e.status === 401 ? "GitHub rejected that token." : e.status === 404 ? "No brief there. Check the repository and branch, and that the token can read it." : `Check failed: ${e.message}`; }
    };
    const qrBox = h("div", { class: "qr-box" });
    const msg2 = h("p", { class: "form-msg", role: "status" });
    const setupLink = () => {
      const payload = btoa(JSON.stringify({ t: cfg.token, r: cfg.repo, b: cfg.branch || DEFAULT_BRANCH })).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
      return `${location.origin}${location.pathname}#setup=${payload}`;
    };
    const showQr = async () => {
      qrBox.replaceChildren(h("p", { class: "muted", text: "Making the code…" }));
      try {
        const { default: qrcode } = await import("./vendor/qrcode.mjs");
        const q = qrcode(0, "M");
        q.addData(setupLink());
        q.make();
        const wrap = h("div", { class: "qr" });
        wrap.innerHTML = q.createSvgTag({ cellSize: 4, margin: 3, scalable: true }); // library output, no user text
        qrBox.replaceChildren(wrap, h("p", { class: "muted" }, "Scan it with your phone's camera and the app opens already connected. On iPhone, an app on the Home Screen keeps its own storage, so if you've installed it there, paste a token inside the installed app instead."),
          h("button", { type: "button", class: "btn ghost", onclick: () => qrBox.replaceChildren() }, "Hide code"));
      } catch (e) { qrBox.replaceChildren(h("p", { class: "warn-text", text: `Couldn't make the code: ${e.message}` })); }
    };
    const copyLink = async () => {
      try { await navigator.clipboard.writeText(setupLink()); msg2.textContent = "Setup link copied. Send it only to yourself."; }
      catch { msg2.textContent = "Couldn't copy. Use the QR code instead."; }
    };
    conn = [
      h("section", { class: "set-sec" }, h("h3", { class: "h3", text: "Connection" }),
        h("p", { class: "muted" }, `Reading ${cfg.repo} (${cfg.branch || DEFAULT_BRANCH} branch) with a token ending in ${(cfg.token || "").slice(-4)}.`),
        h("label", { class: "field" }, h("span", { text: "Repository" }), repoIn),
        h("label", { class: "field" }, h("span", { text: "Data branch" }), branchIn),
        h("label", { class: "field" }, h("span", { text: "Replace token" }), tokenIn),
        h("div", { class: "row-btns" }, h("button", { type: "button", class: "btn", onclick: saveConn }, "Save and check"),
          h("a", { class: "btn ghost", href: TOKENS_URL, target: "_blank", rel: "noopener" }, "Edit token access")),
        msg),
      h("section", { class: "set-sec" }, h("h3", { class: "h3", text: "Use it on another device" }),
        h("p", { class: "muted" }, "Open this link on the other device to connect it without a new token. It contains your read-only token, so only send it to yourself."),
        h("div", { class: "row-btns" }, h("button", { type: "button", class: "btn ghost", onclick: showQr }, "Show setup QR code"),
          h("button", { type: "button", class: "btn ghost", onclick: copyLink }, "Copy setup link")),
        msg2, qrBox),
      pushSection(),
    ];
  } else {
    conn = [h("section", { class: "set-sec" }, h("h3", { class: "h3", text: "Connect the brief" }), connectForm({ compact: true }))];
  }

  return h("div", { class: "settings" },
    h("h2", { class: "st-title", text: "Settings" }),
    conn,
    h("section", { class: "set-sec" }, h("h3", { class: "h3", text: "Install" }),
      standalone ? h("p", { class: "muted", text: "You're using the installed app." })
        : h("p", { class: "muted" }, isIOS ? "On iPhone: tap Share, then Add to Home Screen." : "Install it from your browser's menu (Install app, or Add to Home screen) for its own icon and window."),
      install),
    h("section", { class: "set-sec" }, h("h3", { class: "h3", text: "Appearance" }), themeSeg),
    h("section", { class: "set-sec" }, h("h3", { class: "h3", text: "This device" }),
      state.summary ? h("p", { class: "muted" }, `Brief for ${dayName(state.summary.today, true)}, built ${ago(state.summary.generated_utc)}.`) : null,
      h("div", { class: "row-btns" },
        connected() ? h("button", { type: "button", class: "btn ghost", onclick: async () => { await cacheClear(); state.summary = null; load({ force: true }); } }, "Reload the brief") : null,
        connected() ? h("button", { type: "button", class: "btn danger", onclick: async () => {
          if (!confirm("Disconnect this device? The token and the saved brief are removed from it.")) return;
          await cacheClear(); store.set({ theme: cfg.theme, products: cfg.products }); cfg = store.get(); state.summary = null; sheetPushed = false; go("#/today"); render();
        } }, "Disconnect this device") : null),
      h("p", { class: "muted small" }, `PowerApp ${VERSION}`)));
}

function pushSection() {
  const msg = h("p", { class: "form-msg", role: "status" });
  const body = h("div");
  const secretsUrl = `https://github.com/${cfg.repo}/settings/secrets/actions/new`;
  const draw = () => {
    const topic = cfg.ntfyTopic || "";
    const gen = () => {
      const a = new Uint8Array(12); crypto.getRandomValues(a);
      saveCfg({ ntfyTopic: "power-" + Array.from(a, (x) => "abcdefghijkmnpqrstuvwxyz23456789"[x % 32]).join("") });
      draw();
    };
    const copy = async (text) => { try { await navigator.clipboard.writeText(text); msg.textContent = "Copied."; } catch { msg.textContent = "Couldn't copy; select it by hand."; } };
    body.replaceChildren(
      h("p", { class: "muted" }, "Each brief run can send a short push through ntfy, a free notification app, with a link back here."),
      h("ol", { class: "steps" },
        h("li", null, "Install ntfy (", h("a", { href: NTFY_PLAY, target: "_blank", rel: "noopener" }, "Google Play"), " or ", h("a", { href: NTFY_IOS, target: "_blank", rel: "noopener" }, "App Store"), ")."),
        h("li", null, topic ? h("span", null, "Subscribe to this topic in the app: ", h("code", { class: "topic", text: topic })) : h("button", { type: "button", class: "btn small", onclick: gen }, "Make a private topic name")),
        h("li", null, "Add it to PowerDesk as an Actions secret named ", h("code", { text: "NTFY_TOPIC" }), ". ", h("a", { href: secretsUrl, target: "_blank", rel: "noopener" }, "Open the secrets page"))),
      topic ? h("div", { class: "row-btns" },
        h("button", { type: "button", class: "btn ghost", onclick: async () => { try { await sendPush(topic, "PowerApp test", "If you can read this, the brief's pushes will arrive too."); msg.textContent = "Sent. Check your phone."; } catch (e) { msg.textContent = e.message; } } }, "Send a test push"),
        h("button", { type: "button", class: "btn ghost", onclick: () => copy(topic) }, "Copy topic")) : null,
      msg);
  };
  draw();
  return h("section", { class: "set-sec" }, h("h3", { class: "h3", text: "Phone pushes" }), body);
}

// ------------------------------------------------------------------ theme, install, boot
function applyTheme() {
  const t = cfg.theme || "system";
  if (t === "system") delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = t;
  const dark = t === "dark" || (t === "system" && matchMedia("(prefers-color-scheme: dark)").matches);
  const meta = $('meta[name="theme-color"]');
  if (meta) meta.content = dark ? "#0f1318" : "#f3f5f8";
}
matchMedia("(prefers-color-scheme: dark)").addEventListener?.("change", () => render());

let installPrompt = null;
window.addEventListener("beforeinstallprompt", (e) => { e.preventDefault(); installPrompt = e; });

function importSetupLink() {
  const m = location.hash.match(/^#setup=([A-Za-z0-9_-]+)/);
  if (!m) return false;
  try {
    const b64 = m[1].replace(/-/g, "+").replace(/_/g, "/");
    const j = JSON.parse(atob(b64 + "===".slice((b64.length + 3) % 4)));
    if (j.t && j.r) saveCfg({ token: j.t, repo: j.r, branch: j.b || DEFAULT_BRANCH });
  } catch { /* ignore a malformed link */ }
  history.replaceState(null, "", location.pathname + location.search + "#/today");
  return true;
}

function toast(text, actionLabel, action) {
  const t = h("div", { class: "toast", role: "status" }, h("span", { text }),
    actionLabel ? h("button", { type: "button", class: "linkish", onclick: action }, actionLabel) : null);
  document.body.appendChild(t);
  setTimeout(() => t.remove(), actionLabel ? 15000 : 4000);
}

if ("serviceWorker" in navigator && (location.protocol === "https:" || location.hostname === "localhost")) {
  navigator.serviceWorker.register("./sw.js").then((reg) => {
    reg.addEventListener("updatefound", () => {
      const nw = reg.installing;
      nw?.addEventListener("statechange", () => {
        if (nw.state === "installed" && navigator.serviceWorker.controller) toast("A new version of the app is ready.", "Reload", () => location.reload());
      });
    });
  }).catch(() => { /* offline-first is optional */ });
}

window.addEventListener("hashchange", () => {
  const r = route();
  if ($("#view") && (r.sheet || r.tab === renderedTab)) {
    if (!r.sheet) sheetPushed = false;
    renderSheet(r.sheet);
    return;
  }
  sheetPushed = false;
  render();
  window.scrollTo(0, state.ui[`scroll:${state.tab}`] || 0);
});
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && connected() && state.fetchedAt && Date.now() - Date.parse(state.fetchedAt) > 10 * 60000) load();
});

importSetupLink();
render();
load();
