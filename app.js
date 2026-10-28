// app.js — PowerApp. Products works on its own; Today reads PowerDesk's summary.json
// from the private repo's dashboard-data branch with a read-only token.
import { stepChart, scatterChart, lineChart, crosshairGroup, legend, fmtClock } from "./charts.js";
import * as opt from "./options.js";
import * as crv from "./curve.js";
import { MARKETS, getMarket, delivery, strip, todayIn, isoDate, parseIso, ymd, weekday, baseHours, isHoliday, zonedToUtc, parse, MONTH_ABBR } from "./calendar.js";

const VERSION = "0.4.0";
const STORE = "powerapp.v1";
const DATA_CACHE = "pa-data-v1";
const DEFAULT_BRANCH = "dashboard-data";
const RAW = "application/vnd.github.raw+json";
const TABS = ["today", "products", "curve", "options"];
const TZ = "Europe/Berlin";
const DESK_TZ = "Europe/Zurich";   // whose "today" the brief is about
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
const isPowerSummary = (s) => !!s && (s.schema === 1 || s.schema === 2) && Array.isArray(s.zones) && Array.isArray(s.days);
// A brief cached before schema 2 kept Germany's residual load apart; give it to the DE zone.
function adapt(s) {
  if (s.schema !== 1 || !s.de) return s;
  const de = s.zones.find((z) => z.code === "DE");
  if (de && !de.fund) de.fund = { source: "Energy-Charts", basis: "mixed", rows: [...(s.de.actual || []), ...(s.de.forecast || [])], scatter: s.de.scatter, error: s.de.error };
  return s;
}

// ------------------------------------------------------------------ state
const state = { summary: null, source: null, fetchedAt: null, loading: false, error: null, tab: "today", ui: {} };
const ui = (k, dflt) => (k in state.ui ? state.ui[k] : (cfg.ui && k in cfg.ui ? cfg.ui[k] : dflt));
function setUi(k, v, persist) {
  state.ui[k] = v;
  if (persist) saveCfg({ ui: { ...(cfg.ui || {}), [k]: v } });
}
function applySummary(s, source, at) {
  if (!isPowerSummary(s)) throw new Error("Unexpected data format");
  state.summary = adapt(s);
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
  const view = { today: viewToday, products: viewProducts, curve: viewCurve, options: viewOptions }[state.tab];
  try { main.appendChild(view()); }
  catch (e) { console.error(e); main.appendChild(h("p", { class: "empty", text: `This view couldn't be drawn: ${e.message}` })); }
  const sy = state.ui[`scroll:${state.tab}`];
  if (sy != null && !r.sheet) requestAnimationFrame(() => window.scrollTo(0, sy));
  renderSheet(r.sheet);
}

function brand() {
  return h("span", { class: "brand" }, h("img", { src: "icons/icon.svg", alt: "", width: 26, height: 26 }), h("span", { class: "brand-name", text: "PowerApp" }));
}
const TAB_LABEL = { today: "Today", products: "Products", curve: "Curve", options: "Options" };
const TAB_ICON = {
  today: "M3 17h3v-4h3v-6h3v9h3v-5h3v3h3",
  products: "M4 5h16v14H4zM4 10h16M9 10v9M14 10v9",
  curve: "M3 17c3 0 4-9 7-9s3 6 6 6 3-8 5-8M3 21h18",
  options: "M3 15h8l9-9M3 20h18",
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
      s ? h("span", { class: "updated", title: s.generated_utc }, `updated ${ago(s.generated_utc)}`) : null),
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
    else if (state.summary && !state.loading) {
      const late = lateWindow(state.summary);
      if (late) el.appendChild(h("p", { class: "banner" }, `The ${late} update hasn't arrived yet (last one ${ago(state.summary.generated_utc)}). GitHub sometimes delays or skips scheduled runs; the next one in the window catches up.`));
    }
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
// Days are named from the phone's date in Zurich, the desk's time zone, so an old brief still reads right.
const deskToday = () => todayIn(DESK_TZ);
function dayWord(day) {
  const t = deskToday(), n = parseIso(day);
  return n === t ? "Today" : n === t - 1 ? "Yesterday" : n === t + 1 ? "Tomorrow" : dayName(day);
}
function pickDay(s) {
  const has = (d) => s.zones.some((z) => zoneStats(z, d));
  const t = deskToday(), tomorrow = isoDate(t + 1), today = isoDate(t);
  let day = ui("day", null);
  if (!s.days.includes(day) || !has(day)) {
    day = [tomorrow, today].find((d) => s.days.includes(d) && has(d)) || [...s.days].reverse().find(has) || s.days[1];
  }
  return { day, has };
}

// The brief runs in three windows (Zurich time). It's late if a window opened over two hours ago
// and nothing has arrived since.
const WINDOWS = [[7, 17, "morning"], [13, 17, "afternoon"], [18, 17, "evening"]];
function lateWindow(s) {
  const now = Date.now(), t = deskToday();
  let latest = null;
  for (const n of [t - 1, t]) for (const [hh, mm, name] of WINDOWS) {
    const at = zonedToUtc(n, hh, DESK_TZ) + mm * 60000;
    if (at + 2 * 3600000 <= now) latest = { at, name };
  }
  return latest && Date.parse(s.generated_utc) < latest.at ? latest.name : null;
}

function viewToday() {
  if (!connected()) return connectCard();
  const s = state.summary;
  if (!s) return h("div", { class: state.error ? "" : "loading-shell" }, state.error ? null : h("p", { text: "Loading the brief…" }));
  const { day, has } = pickDay(s);
  const de = s.zones.find((z) => z.code === "DE");
  const st = zoneStats(de, day);
  const prevDay = isoDate(parseIso(day) - 1);
  const prev = zoneStats(de, prevDay);

  const daySeg = seg("Delivery day", s.days.map((d) => ({
    value: d, label: dayWord(d), disabled: !has(d),
    title: has(d) ? dayName(d, true) : "Not published yet: tomorrow's prices come out after the noon auction",
  })), day, (d) => { setUi("day", d); render(); });

  const tomorrowIn = s.days.includes(isoDate(deskToday() + 1)) && has(isoDate(deskToday() + 1));
  const head = section("brief-head",
    kicker("Day-ahead auction · €/MWh"),
    h("h1", { class: "headline", text: `${dayWord(day)}, ${dayName(day, true)}` }),
    h("div", { class: "filters" }, daySeg),
    tomorrowIn ? null : h("p", { class: "note", text: "Tomorrow's prices come out after the noon auction; the brief checks for them several times between 13:17 and 14:47." }));

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
    h("p", { class: "note", text: `Base is the average over every quarter-hour of the day; ${anyPeak ? "peak follows each market's own definition (Poland: 07–22 on working days)" : "there are no peak hours on a weekend"}. vs DE is the base spread to Germany. Tap a zone for its curve and its residual load.` }));
}

// Rows whose hour falls on the given local delivery day (in the zone's time zone).
const dayRows = (rows, day, tz) => (rows || []).filter((r) => isoDate(todayIn(tz, r[0] * 1000)) === day);
const zoneTz = (z) => z.tz || TZ;

function residualBand(s, day) {
  const withFund = s.zones.filter((z) => z.fund);
  const sec = section("residual", kicker("What the auction priced"), h("h2", { class: "h2", text: "Residual load and price" }));
  if (!withFund.length) { sec.appendChild(h("p", { class: "empty", text: "No load, wind or solar forecasts in this brief." })); return sec; }
  let code = ui("resZone", "DE");
  if (!withFund.some((z) => z.code === code)) code = withFund[0].code;
  const z = withFund.find((x) => x.code === code);
  sec.appendChild(h("div", { class: "filters" },
    h("label", { class: "inline-field" }, h("span", { text: "Zone" }),
      h("select", { class: "select", "aria-label": "Zone", onchange: (e) => { setUi("resZone", e.target.value, true); render(); } },
        withFund.map((x) => h("option", { value: x.code, selected: x.code === code || null }, `${x.code} · ${x.name}`))))));
  sec.appendChild(residualBlock(s, z, day));
  return sec;
}

function missingNote(z) {
  const f = z.fund, miss = (f.missing || []).map((p) => (p === "wind_onshore" ? "wind" : p));
  if (!miss.length) return null;
  const what = miss.length === 2 ? "wind or solar forecast" : `${miss[0]} forecast`;
  const rest = miss.length === 2 ? "residual load here is simply load" : `residual load here is load minus ${miss[0] === "wind" ? "solar" : "wind"}`;
  return h("p", { class: "note", text: `${z.name} publishes no ${what} on ENTSO-E, so ${rest}.` });
}

// Price, the fundamentals behind it, and the zone's recent supply curve, for one day.
function residualBlock(s, z, day, { scatterHeight = 260, deferCharts = false } = {}) {
  const f = z.fund, tz = zoneTz(z), wrap = h("div", { class: "res-block" });
  if (f.error && !(f.rows || []).length) { wrap.appendChild(h("p", { class: "empty", text: `No fundamentals for ${z.name} (${f.error}).` })); return wrap; }
  const isPast = parseIso(day) < deskToday();
  const rows = dayRows(f.rows, day, tz);
  const pt = [], pv = [];
  if (z.series) z.series.t.forEach((t, i) => { if (isoDate(todayIn(tz, t * 1000)) === day) { pt.push(t); pv.push(z.series.v[i]); } });
  const basis = f.basis === "mixed" && isPast
    ? "Residual load is load minus wind minus solar. Past days use actual values here; today and tomorrow use day-ahead forecasts."
    : "Residual load is load minus wind minus solar. These are the TSOs' day-ahead forecasts, the numbers the auction priced.";
  wrap.append(h("p", { class: "lede", text: basis }));
  const note = missingNote(z);
  if (note) wrap.appendChild(note);

  const box = h("div", { class: "chart-box" });
  wrap.appendChild(box);
  const draw = () => {
    const group = crosshairGroup();
    if (pt.length) {
      box.appendChild(h("h3", { class: "h3", text: "Price, €/MWh" }));
      stepChart(box, { t: pt, step: (z.step_min || 15) * 60, series: [{ name: "Price", values: pv, color: C.price }], tz, fmt: p2, tickFmt: tick, height: 130, group, label: `${z.name} day-ahead price, ${dayName(day, true)}` });
    }
    if (rows.length) {
      box.appendChild(h("h3", { class: "h3", text: "Load, wind + solar and residual load, GW" }));
      const renew = (r) => (r[2] == null && r[3] == null ? null : +((r[2] || 0) + (r[3] || 0)).toFixed(2));
      stepChart(box, { t: rows.map((r) => r[0]), step: 3600, tz, fmt: gw, tickFmt: tick, height: 130, group, label: "Load, wind plus solar and residual load in gigawatts",
        series: [
          { name: "Load", values: rows.map((r) => r[1]), color: C.load },
          { name: "Wind + solar", values: rows.map(renew), color: C.renew },
          { name: "Residual", values: rows.map((r) => r[4]), color: C.residual },
        ] });
      box.appendChild(legend([{ name: "Load", color: C.load }, { name: "Wind + solar", color: C.renew }, { name: "Residual load", color: C.residual }]));
    }
  };
  if (deferCharts) requestAnimationFrame(draw); else draw();
  if (rows.length) {
    wrap.appendChild(h("details", { class: "raw" }, h("summary", { text: "Show the hours as a table" }),
      table(["Hour", "Price", "Load", "Wind", "Solar", "Residual"], rows.map((r) => h("tr", null,
        h("th", { scope: "row", text: fmtClock(r[0], tz) }), num(p2(r[5])), num(gw(r[1])), num(gw(r[3])), num(gw(r[2])), num(gw(r[4])))))));
  } else {
    wrap.appendChild(h("p", { class: "note", text: isPast ? "No forecasts for this day in the brief." : "The day-ahead forecast for this day isn't in yet; TSOs publish wind and solar by 18:00 the day before." }));
  }

  // The supply curve, revealed: the last two weeks of hours, with the chosen day on top.
  const hist = (f.scatter && f.scatter.points) || [];
  if (hist.length) {
    const selPts = rows.filter((r) => r[5] != null).map((r) => ({ x: r[4], y: r[5], label: `${dayName(day)} ${fmtClock(r[0], tz)}` }));
    wrap.appendChild(h("h3", { class: "h3 sp", text: "Price against residual load" }));
    wrap.appendChild(h("p", { class: "note", text: `Each dot is one hour of the last ${f.scatter.days} days. The cloud traces the merit order: low residual load means cheap plants set the price, high residual load reaches the expensive ones. A zone whose cloud is flat imports its price from its neighbours.` }));
    const sbox = h("div", { class: "chart-box" });
    wrap.appendChild(sbox);
    const drawScatter = () => {
      scatterChart(sbox, {
        groups: [
          { name: `Last ${f.scatter.days} days`, color: C.hist, cls: "hist", points: hist.map(([x, y, hr]) => ({ x, y, label: `${String(hr).padStart(2, "0")}:00` })) },
          ...(selPts.length ? [{ name: dayName(day, true), color: C.sel, cls: "sel", r: 4.5, points: selPts }] : []),
        ],
        xFmt: tick, yFmt: tick, xTitle: "Residual load, GW", yTitle: "€/MWh", height: scatterHeight,
        xName: "Residual", yName: "Price", xRead: (v) => `${gw(v)} GW`, yRead: p2,
        label: `Scatter of hourly ${z.name} day-ahead price against residual load`,
      });
      sbox.appendChild(legend([{ name: `Last ${f.scatter.days} days, hourly`, color: C.hist, dot: true },
        ...(selPts.length ? [{ name: dayName(day, true), color: C.sel, dot: true }] : [])]));
    };
    if (deferCharts) requestAnimationFrame(drawScatter); else drawScatter();
    wrap.appendChild(supplyTable(hist));
  }
  return wrap;
}

// The scatter's table twin: the curve in five bands of residual load, an equal number of hours in each.
function supplyTable(points) {
  const xs = points.map(([x]) => x).sort((a, b) => a - b);
  const edges = [0, 0.2, 0.4, 0.6, 0.8].map((q) => xs[Math.floor(q * xs.length)]).concat(Infinity);
  const nd = xs[xs.length - 1] - xs[0] < 5 ? 1 : 0;
  const f = (v) => neg(new Intl.NumberFormat("en-US", { minimumFractionDigits: nd, maximumFractionDigits: nd }).format(v), v);
  const rows = [];
  for (let i = 0; i < 5; i++) {
    const lo = edges[i], hi = edges[i + 1];
    if (i > 0 && lo === edges[i - 1]) continue;
    const inBand = points.filter(([x]) => x >= lo && x < hi);
    if (!inBand.length) continue;
    const prices = inBand.map(([, y]) => y).sort((a, b) => a - b);
    const avg = prices.reduce((a, b) => a + b, 0) / prices.length;
    const top = Math.max(...inBand.map(([x]) => x));
    rows.push(h("tr", null, h("th", { scope: "row", text: `${f(lo)} to ${f(top)} GW` }), num(int(inBand.length)), num(p1(avg)),
      num(p1(prices[Math.floor(prices.length / 2)])), num(p1(prices[0])), num(p1(prices[prices.length - 1]))));
  }
  return h("details", { class: "raw" }, h("summary", { text: "Show the curve in numbers" }),
    table(["Residual load", "Hours", "Average", "Median", "Low", "High"], rows, { caption: "Price by residual load band" }));
}

function sourceNote(s) {
  const st = s.status || {};
  const bad = st.entsoe && !["ok", "no token"].includes(st.entsoe);
  return h("div", { class: "pipeline" },
    bad ? h("p", { class: "warn-text", text: `ENTSO-E: ${st.entsoe}. Prices fall back to Energy-Charts where needed.` }) : null,
    h("p", null, `Sources: ${s.source}. Power exchanges' prices can come with stricter terms than the TSOs' data, and some zones' are for private use only. Brief updated ${ago(s.generated_utc)}.`));
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
  requestAnimationFrame(() => stepChart(box, { t: z.series.t, step: z.step_min * 60, series: [{ name: "Price", values: z.series.v, color: C.price }], tz: zoneTz(z), fmt: p2, tickFmt: tick, height: 170,
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
  wrap.appendChild(table(["", ...days.map((d) => `${dayWord(d)}`)], rows, { cls: "zone-stats", caption: `${z.name} daily statistics` }));
  if (days.length < s.days.length) wrap.appendChild(h("p", { class: "note", text: "Tomorrow's prices aren't in the brief yet." }));
  const src = z.price_source ? `Prices: ${z.price_source}.` : "";
  const c = z.check;
  const chk = !c || !c.hours ? ""
    : c.max_diff < 0.005 ? ` Energy-Charts matches it exactly over ${c.hours} hours.`
    : ` Energy-Charts differs in ${c.differing ?? "some"} of ${c.hours} hours, by up to ${p2(c.max_diff)} €/MWh; the brief uses ENTSO-E.`;
  if (src || chk) wrap.appendChild(h("p", { class: "note", text: src + chk }));
  if (z.fund) {
    const { day } = pickDay(s);
    wrap.appendChild(h("h3", { class: "h3 sp", text: `Residual load and price, ${dayWord(day).toLowerCase()}` }));
    wrap.appendChild(residualBlock(s, z, day, { scatterHeight: 220, deferCharts: true }));
  }
  const lic = z.license || z.license_energy_charts;
  if (lic) wrap.appendChild(h("p", { class: "note", text: `Energy-Charts licence for this zone: ${lic}` }));
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

// ------------------------------------------------------------------ Curve
const CURVE_ZONES = ["DE", "FR", "NL", "BE", "AT", "CH", "PL", "CZ", "SK", "HU", "SI", "IT-N", "ES"];
const CURVE_MARKET = (z) => (z === "IT-N" ? "IT" : z);
const ZONE_NAME = { DE: "Germany-Luxembourg", FR: "France", NL: "Netherlands", BE: "Belgium", AT: "Austria", CH: "Switzerland",
  PL: "Poland", CZ: "Czechia", SK: "Slovakia", HU: "Hungary", SI: "Slovenia", "IT-N": "Italy North", ES: "Spain" };
const DATA_BRANCH = "data";
const EXAMPLE_QUOTES = [
  { product: "Nov26", base: "120", peak: "135" }, { product: "Dec26", base: "115", peak: "128" },
  { product: "Q1-27", base: "108", peak: "120" }, { product: "Q2-27", base: "78", peak: "72" },
  { product: "Cal27", base: "92", peak: "98" }, { product: "Cal28", base: "84", peak: "89" },
];
const SEQ = (i) => `var(--q-${Math.min(4, i + 1)})`;

const curveCfg = () => ({ zone: "DE", years: null, mode: "multiplicative", quotes: {}, month: null, profile: "solar",
  pproduct: "", weekdays: "weekdays", h0: "17", h1: "21", bh: "2", rt: "85", hmonth: "5", ...(cfg.curve || {}) });
const saveCurve = (patch) => saveCfg({ curve: { ...curveCfg(), ...patch } });

const curveStats = {};          // zone -> stats | "loading" | {error}
async function loadCurveStats(zone) {
  if (!connected() || curveStats[zone]) return;
  curveStats[zone] = "loading";
  const name = `curve-${zone}.json`;
  const cached = await cacheGet(name);
  if (cached) { try { curveStats[zone] = JSON.parse(cached.text); if (state.tab === "curve") render(); } catch { /* stale */ } }
  try {
    const text = await gh(contentsPath(`curve/${zone}.json`, { ...cfg, branch: DATA_BRANCH }), RAW);
    curveStats[zone] = JSON.parse(text);
    cachePut(name, text);
  } catch (e) {
    if (curveStats[zone] === "loading") curveStats[zone] = { error: e.status === 404 ? "no history for this zone yet" : e.message };
  }
  if (state.tab === "curve") render();
}
const statsReady = (s) => s && s !== "loading" && !s.error;

function defaultYears(stats) {
  const ys = Object.keys(stats.years).map(Number).sort((a, b) => a - b);
  return ys.slice(-3);
}

function viewCurve() {
  const cc = curveCfg(), zone = CURVE_ZONES.includes(cc.zone) ? cc.zone : "DE";
  if (connected()) loadCurveStats(zone);
  const raw = curveStats[zone], stats = statsReady(raw) ? raw : null;
  const allYears = stats ? Object.keys(stats.years).map(Number).sort((a, b) => a - b) : [];
  const years = (cc.years || (stats ? defaultYears(stats) : [])).filter((y) => allYears.includes(y));
  const quotes = (cc.quotes[zone] || []).map((q) => ({ ...q }));
  const out = h("div", { class: "curve-out", "aria-live": "polite" });

  const zoneSel = h("select", { class: "select", "aria-label": "Zone", onchange: (e) => { saveCurve({ zone: e.target.value }); render(); } },
    CURVE_ZONES.map((z) => h("option", { value: z, selected: z === zone || null }, `${z} · ${ZONE_NAME[z]}`)));
  const yearChips = h("div", { class: "chips", role: "group", "aria-label": "Shape years" }, allYears.map((y) => h("button", {
    type: "button", class: "chip", "aria-pressed": String(years.includes(y)),
    onclick: () => { const next = years.includes(y) ? years.filter((x) => x !== y) : [...years, y].sort(); saveCurve({ years: next.length ? next : null }); render(); },
  }, String(y) + (stats.years[String(y)].full ? "" : " so far"))));

  // quote sheet
  const rowsBox = h("div", { class: "quote-rows" });
  const saveQuotes = (qs) => saveCurve({ quotes: { ...curveCfg().quotes, [zone]: qs } });
  const later = debounce(() => compute(), 250);
  const drawRows = () => {
    rowsBox.replaceChildren(...(quotes.length ? [h("div", { class: "quote-row head" }, h("span", { text: "Product" }), h("span", { text: "Base €/MWh" }), h("span", { text: "Peak €/MWh" }), h("span"))] : []),
      ...quotes.map((q, i) => {
        const inp = (key, ph) => h("input", { class: "input", value: q[key] ?? "", placeholder: ph, inputmode: key === "product" ? "text" : "decimal",
          autocomplete: "off", spellcheck: "false", "aria-label": `${key} ${i + 1}`, oninput: (e) => { quotes[i][key] = e.target.value; saveQuotes(quotes); later(); } });
        return h("div", { class: "quote-row" }, inp("product", "Cal27"), inp("base", "base"), inp("peak", "optional"),
          h("button", { type: "button", class: "icon-btn small", "aria-label": `Remove row ${i + 1}`, onclick: () => { quotes.splice(i, 1); saveQuotes(quotes); drawRows(); compute(); } }, "×"));
      }));
  };
  drawRows();
  const quoteCard = section("curve-quotes",
    h("h2", { class: "h2", text: "Quotes" }),
    h("p", { class: "note", text: "Months, quarters, seasons and years (Nov26, Q1-27, Sum27, Win27, Cal28), base and, if you have it, peak. Use prices you read in public sources, never ones from a work terminal." }),
    rowsBox,
    h("div", { class: "row-btns" },
      h("button", { type: "button", class: "btn ghost small", onclick: () => { quotes.push({ product: "", base: "", peak: "" }); saveQuotes(quotes); drawRows(); } }, "Add a product"),
      h("button", { type: "button", class: "btn ghost small", onclick: () => { quotes.splice(0, quotes.length, ...EXAMPLE_QUOTES.map((q) => ({ ...q }))); saveQuotes(quotes); drawRows(); compute(); } }, "Fill in example values"),
      quotes.length ? h("button", { type: "button", class: "linkish", onclick: () => { quotes.splice(0); saveQuotes(quotes); drawRows(); compute(); } }, "Clear") : null),
    h("p", { class: "note", text: "The example values are made up to try the tool. They are not market prices." }));

  function compute() {
    const qs = quotes.map((q) => ({ product: (q.product || "").trim(), base: num0(q.base), peak: num0(q.peak) }))
      .filter((q) => q.product && (q.base != null || q.peak != null));
    if (!qs.length) { out.replaceChildren(h("p", { class: "empty", text: "Type at least one quote, or fill in the example, to build the curve." })); return; }
    let cv;
    try { cv = crv.build(qs, CURVE_MARKET(zone), stats, years, cc.mode); }
    catch (e) { out.replaceChildren(h("p", { class: "warn-text", text: `Couldn't build the curve: ${e.message}` })); return; }
    if (!cv.months.length) { out.replaceChildren(h("p", { class: "warn-text", text: cv.notes.join(" ") || "No usable quotes." })); return; }
    out.replaceChildren(curveChecks(cv), curveStrip(cv), curveMonthly(cv), curveHourly(cv, zone), curveProfile(cv, stats, years, zone));
  }

  const head = section("curve-head", kicker("Hourly price forward curve"), h("h1", { class: "headline", text: "Forward curve" }),
    h("p", { class: "lede", text: "Type the prices you read for months, quarters, seasons and years. The curve reprices them exactly, fills the gaps from history, and gives every hour a price, so any profile can be priced against it." }),
    h("div", { class: "filters" }, h("label", { class: "inline-field" }, h("span", { text: "Zone" }), zoneSel),
      seg("Shape", [{ value: "multiplicative", label: "Scales with price" }, { value: "additive", label: "Fixed in €/MWh" }], cc.mode,
        (v) => { saveCurve({ mode: v }); render(); })),
    stats ? h("div", null, h("p", { class: "note", text: "Years the seasonal pattern and the hourly shape come from:" }), yearChips)
      : h("p", { class: "note" }, !connected() ? "Connect the brief (Today tab) to shape the curve with this zone's history. Without it, months nobody quoted are flat and hours are flat within peak and off-peak."
        : raw === "loading" ? "Loading this zone's history…" : `No history yet (${raw && raw.error}). The curve works without it, flat within blocks.`));
  const view = h("div", { class: "curve" }, head, quoteCard, section("curve-results", out), stats ? curveHistory(stats, zone) : null);
  compute();
  return view;
}
const num0 = (x) => { const v = dec(x); return isFinite(v) ? v : null; };

function curveChecks(cv) {
  const kids = [h("h2", { class: "h2", text: "Do the quotes fit together?" })];
  if (cv.checks.length) {
    for (const c of cv.checks)
      kids.push(h("p", { class: "banner warn" }, `${c.label} ${c.profile} at ${p2(c.quote)} doesn't fit the finer quotes: they imply ${p2(c.implied)} (${signed(c.quote - c.implied)}). The curve follows the finer quotes.`));
  } else kids.push(h("p", { class: "lede", text: "Yes: the curve reprices every quote exactly." }));
  const free = cv.months.filter((m) => !m.constrained).map((m) => m.label);
  if (free.length) kids.push(h("p", { class: "note", text: `No quote covers ${free.join(", ")}: those follow the seasonal pattern at the quotes' overall level (${p2(cv.level)}).` }));
  for (const n of cv.notes) kids.push(h("p", { class: "note", text: n }));
  return h("div", { class: "curve-block" }, kids);
}

// Every standard product inside the horizon, quoted or implied.
function curveStrip(cv) {
  const first = cv.months[0].month, last = cv.months[cv.months.length - 1].month;
  const codes = [];
  for (const m of cv.months) codes.push(m.label.replace("-", ""));
  for (let y = ymd(first).y; y <= ymd(last).y; y++) {
    const yy = String(y % 100).padStart(2, "0");
    for (let q = 1; q <= 4; q++) codes.push(`Q${q}-${yy}`);
    codes.push(`Sum${yy}`, `Win${yy}`, `Cal${yy}`);
  }
  const zoneNow = CURVE_ZONES.includes(curveCfg().zone) ? curveCfg().zone : "DE";
  const quotedLabels = new Set((curveCfg().quotes[zoneNow] || []).map((q) => { try { return parse(q.product, 0).label; } catch { return ""; } }));
  // a function, because a header cell element can only sit in one table
  const head = () => ["Product", "Base", "Peak", "Off-peak", h("th", { class: "wide", text: "Peak − base" }), ""];
  const misfit = new Set(cv.checks.map((c) => c.label));
  const main = [], monthsRows = [];
  for (const code of codes) {
    let p; try { p = parse(code, 0); } catch { continue; }
    if (!cv.covers(p)) continue;
    const v = cv.product(p), quoted = quotedLabels.has(p.label);
    const status = !quoted ? h("td", { class: "muted small", text: "implied" })
      : misfit.has(p.label) ? h("td", { class: "warn-text small", text: "doesn't fit" }) : h("td", { class: "small", text: "quoted" });
    const row = h("tr", { class: quoted ? "current" : null }, h("th", { scope: "row", text: p.label }),
      num(p2(v.base)), num(p2(v.peak)), num(p2(v.offpeak)), num(signed(v.peak - v.base), "wide"), status);
    if (p.kind === "Month") { monthsRows.push(row); if (quoted) main.push(row.cloneNode(true)); }
    else main.push(row);
  }
  return h("div", { class: "curve-block" }, h("h2", { class: "h2", text: "The strip" }),
    table(head(), main, { caption: "Base, peak and off-peak for the quoted months, and every quarter, season and year in the horizon" }),
    h("details", { class: "raw" }, h("summary", { text: `Every month (${monthsRows.length})` }), table(head(), monthsRows, { caption: "Every month in the horizon" })),
    h("p", { class: "note", text: "Implied products come straight from the curve, so they are consistent with every quote: Q2-27 here is what Cal27 and Q1-27 leave for the rest of the year, spread by the seasonal pattern." }));
}

function curveMonthly(cv) {
  const box = h("div", { class: "chart-box" });
  const xs = cv.months.map((_, i) => i);
  const labels = cv.months.map((m) => m.label);
  requestAnimationFrame(() => {
    lineChart(box, { x: xs, xFmt: (v) => labels[Math.round(v)] || "", xName: "", fmt: p2, tickFmt: tick, height: 170, rest: 0,
      series: [{ name: "Base", values: cv.months.map((m) => m.base), color: "var(--s-1)" },
        { name: "Peak", values: cv.months.map((m) => m.peak), color: "var(--s-2)" },
        { name: "Off-peak", values: cv.months.map((m) => m.offpeak), color: "var(--s-3)" }],
      label: "Monthly base, peak and off-peak prices of the curve" });
    box.appendChild(legend([{ name: "Base", color: "var(--s-1)" }, { name: "Peak", color: "var(--s-2)" }, { name: "Off-peak", color: "var(--s-3)" }]));
  });
  return h("div", { class: "curve-block" }, h("h2", { class: "h2", text: "Month by month" }), box);
}

function curveHourly(cv, zone) {
  const cc = curveCfg();
  const labels = cv.months.map((m) => m.label);
  let mi = Math.max(0, labels.indexOf(cc.month));
  const wrap = h("div", { class: "curve-block" });
  const draw = () => {
    const m = cv.months[mi], next = mi + 1 < cv.months.length ? cv.months[mi + 1].month : cv.day[cv.day.length - 1] + 1;
    const idx = []; for (let i = 0; i < cv.day.length; i++) if (cv.day[i] >= m.month && cv.day[i] < next) idx.push(i);
    const box = h("div", { class: "chart-box" }), avgBox = h("div", { class: "chart-box" });
    const sel = h("select", { class: "select", "aria-label": "Month", onchange: (e) => { mi = labels.indexOf(e.target.value); saveCurve({ month: e.target.value }); draw(); } },
      labels.map((l, i) => h("option", { value: l, selected: i === mi || null }, l)));
    wrap.replaceChildren(h("h2", { class: "h2", text: "Hour by hour" }),
      h("div", { class: "filters" }, h("label", { class: "inline-field" }, h("span", { text: "Month" }), sel)),
      box, h("h3", { class: "h3", text: "An average day in that month" }), avgBox,
      h("p", { class: "note", text: "Peak hours average exactly to the month's peak price and off-peak hours to its off-peak price; inside each block, hours follow the history's shape for that month, day type and hour." }),
      h("p", { class: "note", text: cc.mode === "additive"
        ? "Fixed in €/MWh keeps history's gaps between hours in euros, whatever the price level. Switch to Scales with price to see the other convention: neither is right for negative hours, which come from surplus solar and don't follow the gas price."
        : "Scales with price moves every hour in proportion to the price level, negative hours included, so a dearer curve also gets deeper negative middays. Negative hours come from surplus solar and don't follow the gas price, so Fixed in €/MWh is the other convention to compare." }));
    requestAnimationFrame(() => {
      stepChart(box, { t: idx.map((i) => cv.t[i]), step: 3600, tz: getMarket(CURVE_MARKET(zone)).tz, fmt: p2, tickFmt: tick, height: 160,
        series: [{ name: "Curve", values: idx.map((i) => cv.price[i]), color: "var(--s-1)" }], label: `Hourly forward curve, ${m.label}` });
      const types = [[0, "Weekday", "var(--s-1)"], [1, "Saturday", "var(--s-2)"], [2, "Sunday or holiday", "var(--s-3)"]];
      const series = types.map(([d, name, color]) => {
        const sum = Array(24).fill(0), cnt = Array(24).fill(0);
        for (const i of idx) if (crv.daytype(cv.day[i]) === d) { sum[cv.hour[i]] += cv.price[i]; cnt[cv.hour[i]]++; }
        return { name, color, values: sum.map((s, hh) => (cnt[hh] ? s / cnt[hh] : null)) };
      });
      lineChart(avgBox, { x: [...Array(24).keys()], xFmt: (v) => `${String(Math.round(v)).padStart(2, "0")}:00`, xName: "", fmt: p2, tickFmt: tick, height: 150, rest: 13,
        series, label: `Average hourly price by day type, ${m.label}` });
      avgBox.appendChild(legend(types.map(([, name, color]) => ({ name, color }))));
    });
  };
  draw();
  return wrap;
}

function curveProfile(cv, stats, years, zone) {
  const cc = curveCfg();
  const wrap = h("div", { class: "curve-block" });
  const firstCal = cv.months.find((m) => ymd(m.month).m === 1);
  const dflt = firstCal ? `Cal${String(ymd(firstCal.month).y % 100).padStart(2, "0")}` : cv.months[0].label.replace("-", "");
  const prodIn = h("input", { class: "input", value: cc.pproduct || dflt, autocomplete: "off", spellcheck: "false", "aria-label": "Product to price",
    oninput: debounce(() => { saveCurve({ pproduct: prodIn.value }); draw(); }, 250) });
  const res = h("div", { class: "opt-out", "aria-live": "polite" });
  const draw = () => {
    const c = curveCfg();
    let p;
    try { p = parse(prodIn.value.trim() || dflt, todayIn(TZ)); } catch (e) { res.replaceChildren(h("p", { class: "warn-text", text: e.message })); return; }
    if (!cv.covers(p)) { res.replaceChildren(h("p", { class: "warn-text", text: `${p.label} isn't inside the curve's horizon (${cv.months[0].label} to ${cv.months[cv.months.length - 1].label}).` })); return; }
    const base = cv.product(p);
    const kids = [];
    if (c.profile === "block") {
      const wd = { weekdays: new Set([0, 1, 2, 3, 4]), all: new Set([0, 1, 2, 3, 4, 5, 6]), weekends: new Set([5, 6]) }[c.weekdays] || new Set([0, 1, 2, 3, 4]);
      const h0 = Math.max(0, Math.min(23, parseInt(c.h0, 10) || 0)), h1 = Math.max(h0 + 1, Math.min(24, parseInt(c.h1, 10) || 24));
      const b = cv.block(p, wd, h0, h1);
      kids.push(table(["", "€/MWh"], [
        h("tr", null, h("th", { scope: "row" }, `${p.label}, ${{ weekdays: "Mon–Fri", all: "every day", weekends: "weekends" }[c.weekdays] || "Mon–Fri"} ${String(h0).padStart(2, "0")}–${String(h1).padStart(2, "0")}`,
          h("span", { class: "zn", text: `${int(b.hours)} hours` })), num(p2(b.price))),
        h("tr", null, h("th", { scope: "row", text: "against base" }), num(signed(b.price - base.base))),
        h("tr", null, h("th", { scope: "row", text: "against peak" }), num(signed(b.price - base.peak))),
      ], { cls: "opt-tbl", caption: "Block price" }));
    } else if (c.profile === "solar" || c.profile === "wind") {
      const prof = stats ? crv.genProfile(stats, years, c.profile) : null;
      if (!prof) { res.replaceChildren(h("p", { class: "note", text: `Pricing a ${c.profile} profile needs this zone's history (connect the brief), with ${c.profile} output in the chosen years.` })); return; }
      const cap = cv.capture(p, prof);
      const realised = realisedCapture(stats, years, c.profile, p, prof);
      kids.push(table(["", "€/MWh", "Rate"], [
        h("tr", null, h("th", { scope: "row" }, `${p.label} base`, h("span", { class: "zn", text: "from the curve" })), num(p2(cap.base)), num("100%")),
        h("tr", null, h("th", { scope: "row" }, `${c.profile === "solar" ? "Solar" : "Wind"} capture price`, h("span", { class: "zn", text: "the curve weighted by the average profile" })), num(p2(cap.price)), num(pct(cap.rate, 1))),
        realised != null ? h("tr", null, h("th", { scope: "row" }, "Realised capture rate", h("span", { class: "zn", text: `history, ${years.join(", ")}, same months` })), num(p2(cap.base * realised)), num(pct(realised, 1))) : null,
      ], { cls: "opt-tbl", caption: "Capture price" }));
      kids.push(h("p", { class: "note", text: c.profile === "solar"
        ? "The curve's capture rate counts the average daily shape: solar runs in the cheap midday hours. It can't see the weather: on a sunny day those hours are cheaper still than on a cloudy one. History's realised rate includes both, and the gap between the two is roughly the extra discount a PV PPA has to price in, on top of balancing and volume risk."
        : "Wind runs at all hours, so the daily shape matters little; its value against base comes from the seasons (more wind in winter) and, in history, from the weather: windy hours are cheap hours. The gap to the realised rate is that correlation, which an average curve can't see." }));
    } else {
      const k = [1, 2, 4].includes(+c.bh) ? +c.bh : 2, rt = Math.min(1, Math.max(0.5, (dec(c.rt) || 85) / 100));
      const b = cv.battery(p, k, rt);
      const realised = stats ? realisedBattery(stats, years, k, p) : null;
      kids.push(table(["", "€/MW/day", `€/MW over ${p.label}`], [
        h("tr", null, h("th", { scope: "row" }, `${k}-hour battery, intrinsic`, h("span", { class: "zn", text: `one cycle a day on the curve, ${pct(rt, 0)} round trip` })), num(p1(b.per_day)), num(eur(b.total))),
        realised != null ? h("tr", null, h("th", { scope: "row" }, "Realised in history", h("span", { class: "zn", text: `same months, ${years.join(", ")}, 85% round trip` })), num(p1(realised)), num(eur(realised * b.days))) : null,
      ], { cls: "opt-tbl", caption: "Battery value" }));
      kids.push(h("p", { class: "note", text: "A forward curve is an average, so its daily spreads are smoother than any real day's: it gives the intrinsic value you could lock in today. Realised days swing far more, and the gap between the two lines is the extrinsic value: what a toll buyer pays for and a trading desk has to earn in the day-ahead and intraday markets." }));
    }
    res.replaceChildren(...kids);
  };
  const c0 = curveCfg();
  const opts = h("div", { class: "filters" });
  const drawOpts = () => {
    const c = curveCfg();
    opts.replaceChildren(...[
      seg("Profile", [{ value: "solar", label: "Solar" }, { value: "wind", label: "Wind" }, { value: "battery", label: "Battery" }, { value: "block", label: "Block of hours" }], c.profile,
        (v) => { saveCurve({ profile: v }); drawOpts(); draw(); }),
      c.profile === "block" ? h("div", { class: "filters" },
        seg("Days", [{ value: "weekdays", label: "Mon–Fri" }, { value: "all", label: "Every day" }, { value: "weekends", label: "Weekends" }], c.weekdays, (v) => { saveCurve({ weekdays: v }); drawOpts(); draw(); }),
        h("label", { class: "inline-field" }, h("span", { text: "From" }), h("input", { class: "input tiny", inputmode: "numeric", value: c.h0, oninput: (e) => { saveCurve({ h0: e.target.value }); draw(); } })),
        h("label", { class: "inline-field" }, h("span", { text: "to" }), h("input", { class: "input tiny", inputmode: "numeric", value: c.h1, oninput: (e) => { saveCurve({ h1: e.target.value }); draw(); } }))) : null,
      c.profile === "battery" ? h("div", { class: "filters" },
        seg("Duration", [{ value: "1", label: "1 hour" }, { value: "2", label: "2 hours" }, { value: "4", label: "4 hours" }], String(c.bh), (v) => { saveCurve({ bh: v }); drawOpts(); draw(); }),
        h("label", { class: "inline-field" }, h("span", { text: "Round trip %" }), h("input", { class: "input tiny", inputmode: "decimal", value: c.rt, oninput: (e) => { saveCurve({ rt: e.target.value }); draw(); } }))) : null,
    ].filter(Boolean));   // replaceChildren would print a null as "null"
  };
  drawOpts();
  wrap.append(h("h2", { class: "h2", text: "Price a profile" }),
    h("div", { class: "filters" }, h("label", { class: "inline-field" }, h("span", { text: "Product" }), prodIn)), opts, res);
  void c0;
  draw();
  return wrap;
}

// History's realised capture rate over the product's calendar months, weighted by the profile's energy.
function realisedCapture(stats, years, kind, period, prof) {
  const months = new Set();
  for (let n = period.start; n < period.end; n++) months.add(ymd(n).m - 1);
  let num = 0, den = 0;
  for (const y of years) {
    const st = stats.years[String(y)];
    const rates = st && st.capture && st.capture[kind] && st.capture[kind].rate;
    if (!rates) continue;
    for (const m of months) {
      if (rates[m] == null) continue;
      const w = prof[m].reduce((a, b) => a + b, 0);
      num += rates[m] * w; den += w;
    }
  }
  return den > 0 ? num / den : null;
}
function realisedBattery(stats, years, k, period) {
  const days = Array(12).fill(0);
  for (let n = period.start; n < period.end; n++) days[ymd(n).m - 1]++;
  let num = 0, den = 0;
  for (const y of years) {
    const v = stats.years[String(y)]?.battery?.[String(k)]?.month;
    if (!v) continue;
    days.forEach((d, m) => { if (d && v[m] != null) { num += v[m] * d; den += d; } });
  }
  return den > 0 ? num / den : null;
}

// How the shape of a day has changed over the years, and what that did to capture rates.
function curveHistory(stats, zone) {
  const cc = curveCfg();
  const ys = Object.keys(stats.years).map(Number).sort((a, b) => a - b);
  const mon = Math.min(11, Math.max(0, (parseInt(cc.hmonth, 10) || 5) - 1));
  const box = h("div", { class: "chart-box" });
  const sel = h("select", { class: "select", "aria-label": "Month", onchange: (e) => { saveCurve({ hmonth: e.target.value }); render(); } },
    MONTH_ABBR.map((l, i) => h("option", { value: String(i + 1), selected: i === mon || null }, l)));
  // Four years at most, one hue from light (oldest) to dark: the first, one between, the last two.
  const withData = ys.filter((y) => stats.years[String(y)].shape[mon][0].some((v) => v != null));
  const pick = withData.length <= 4 ? withData
    : [withData[0], withData[Math.floor((withData.length - 2) / 2)], withData[withData.length - 2], withData[withData.length - 1]];
  const series = pick.map((y, i) => ({ name: stats.years[String(y)].full ? String(y) : `${y} so far`, color: SEQ(i), values: stats.years[String(y)].shape[mon][0] }));
  requestAnimationFrame(() => {
    if (!series.length) return;
    lineChart(box, { x: [...Array(24).keys()], xFmt: (v) => `${String(Math.round(v)).padStart(2, "0")}:00`, xName: "", height: 190, rest: 13,
      fmt: (v) => `${nf2.format(v)}×`, tickFmt: (v) => `${(+v).toFixed(1)}×`, series, label: `Weekday price shape in ${MONTH_ABBR[mon]}, by year` });
    box.appendChild(legend(series.map((s) => ({ name: s.name, color: s.color }))));
  });
  const rows = ys.map((y) => {
    const st = stats.years[String(y)];
    const base = st.monthly.base.filter((v) => v != null);
    const pk = st.monthly.peak.filter((v) => v != null);
    const avg = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
    return h("tr", null, h("th", { scope: "row", text: st.full ? String(y) : `${y} so far` }),
      num(p1(avg(base))), num(signed(avg(pk) - avg(base), p1), "wide"),
      num(st.capture?.solar?.rate_year != null ? pct(st.capture.solar.rate_year, 0) : "—"),
      num(st.capture?.wind?.rate_year != null ? pct(st.capture.wind.rate_year, 0) : "—"),
      num(st.battery?.["2"]?.year != null ? p1(st.battery["2"].year) : "—"));
  });
  return section("curve-history", kicker(`${ZONE_NAME[zone]}, from ENTSO-E history`), h("h2", { class: "h2", text: "How the shape of a day changed" }),
    h("div", { class: "filters" }, h("label", { class: "inline-field" }, h("span", { text: "Month" }), sel)),
    h("p", { class: "note", text: `The average weekday in that month, each hour as a multiple of the month's average price, for ${withData.length > 4 ? "four of the years" : "each year"}, from faint (oldest) to strong (newest). Watch midday sink as solar grows, and the evening rise to meet it.` }),
    box,
    table(["Year", "Base", h("th", { class: "wide", text: "Peak − base" }), "Solar", "Wind", "Battery"], rows, { caption: "Yearly averages" }),
    h("p", { class: "note", text: "Base is the average of the monthly base prices, in €/MWh. Solar and wind are capture rates: the output-weighted price over the base price. Battery is what a 2-hour battery earned, in € per MW per day, cycling once a day with perfect foresight of day-ahead prices at 85% round trip: an upper bound for day-ahead arbitrage alone." }));
}

// ------------------------------------------------------------------ Options
const YEAR_MS = 365 * 86400000;
const OPT_DEFAULTS = {
  model: "black", F: "85", K: "90", days: "60", vol: "40", volN: "34", rate: "0", product: "Q1-27", market: "DE", mw: "1", seen: "", chartKind: "call",
  month: "", mF: "90", mK: "100", mKind: "call", sl: "35", ss: "120", hl: "5", rho: "0",
  pF: "95", pGas: "35", hr: "1.9", eua: "70", ef: "0.37", vom: "2", pVol: "45", gVol: "50", pRho: "0.8", pDays: "30",
};
const optCfg = () => ({ ...OPT_DEFAULTS, ...(cfg.options || {}) });
const saveOpt = (patch) => saveCfg({ options: { ...optCfg(), ...patch } });
const p3 = (v) => (v == null ? "—" : neg(new Intl.NumberFormat("en-US", { minimumFractionDigits: 3, maximumFractionDigits: 3 }).format(v), v));
const dec = (x) => parseFloat(String(x ?? "").trim().replace(",", "."));   // "0,25" works too
const pct = (v, d = 1) => `${new Intl.NumberFormat("en-US", { maximumFractionDigits: d }).format(v * 100)}%`;
const sig3 = (v) => (v == null || !isFinite(v) ? "—" : neg(new Intl.NumberFormat("en-US", { maximumSignificantDigits: 3 }).format(v), v));
const defaultMonth = () => strip(todayIn(TZ))[1];
function debounce(fn, ms) { let t; return () => { clearTimeout(t); t = setTimeout(fn, ms); }; }

function optField(label, key, onChange, hint) {
  return h("label", { class: "field" }, h("span", { text: label }),
    h("input", { class: "input", type: "text", inputmode: "decimal", value: optCfg()[key], autocomplete: "off", spellcheck: "false",
      placeholder: hint || null, oninput: (e) => { saveOpt({ [key]: e.target.value }); onChange(); } }));
}
const warnOut = (out, text) => out.replaceChildren(h("p", { class: "warn-text", text }));

function viewOptions() {
  return h("div", { class: "options" },
    section("opt-head", kicker("Options on power futures"), h("h1", { class: "headline", text: "Options" }),
      h("p", { class: "lede", text: "Everything here is priced on futures, so there's no carry: just the future, the strike, time and volatility. Prices are in €/MWh; type 0,25 or 0.25, either works." })),
    vanillaSection(), monthSection(), spreadSection());
}

// --- an option on a future
function vanillaSection() {
  const out = h("div", { class: "opt-out", "aria-live": "polite" });
  const chartBox = h("div", { class: "chart-box" });
  const o0 = optCfg(), black0 = o0.model === "black";
  const draw = () => {
    const o = optCfg(), black = o.model === "black";
    const F = dec(o.F), K = dec(o.K), T = dec(o.days) / 365, r = dec(o.rate || 0) / 100;
    const vol = black ? dec(o.vol) / 100 : dec(o.volN);
    chartBox.replaceChildren();
    if (![F, K, T, vol, r].every(isFinite) || T < 0 || vol < 0) return warnOut(out, "Fill in the future, strike, days and vol with numbers.");
    if (black && (F <= 0 || K <= 0)) return warnOut(out, "Black-76 needs a positive future and strike. For spreads or negative prices, switch to Bachelier.");
    const greeks = (kind) => (black ? opt.black76Greeks(F, K, T, vol, r, kind) : opt.bachelierGreeks(F, K, T, vol, r, kind));
    const c = greeks("call"), p = greeks("put");
    const vega = (g) => (black ? g.vega / 100 : g.vega);
    const row = (name, g) => h("tr", null, h("th", { scope: "row", text: name }), num(p2(g.price)), num(sig3(g.delta)), num(sig3(g.gamma), "wide"), num(sig3(vega(g))), num(sig3(g.theta / 365)));
    const kids = [
      table(["", "Premium", "Delta", h("th", { class: "wide", text: "Gamma" }), "Vega", "Theta / day"], [row("Call", c), row("Put", p)], { caption: "Premiums and greeks" }),
      h("p", { class: "note", text: `Vega is the premium change ${black ? "for one vol point" : "for 1 €/MWh of normal vol"}; theta is what a day costs if nothing else moves.` }),
    ];
    try {
      const d = delivery(o.product, o.market), mw = dec(o.mw);
      if (isFinite(mw) && mw > 0) kids.push(h("p", { class: "lede", text: `On ${upTo2.format(mw)} MW of ${d.period.label} base (${int(d.hours.base)} hours in ${o.market}), the call costs ${eur(c.price * d.hours.base * mw)} and the put ${eur(p.price * d.hours.base * mw)}.` }));
    } catch (e) { kids.push(h("p", { class: "note", text: `Product: ${e.message}` })); }
    const seen = dec(o.seen);
    if (isFinite(seen)) {
      let text;
      try {
        const iv = black ? opt.black76Iv(seen, F, K, T, r, "call") : opt.bachelierIv(seen, F, K, T, r, "call");
        text = black ? `A call premium of ${p2(seen)} means the market is pricing ${pct(iv)} vol.` : `A call premium of ${p2(seen)} means a normal vol of ${p2(iv)} €/MWh.`;
      } catch (e) { text = e.message; }
      kids.push(h("p", { class: "lede", text }));
    }
    out.replaceChildren(...kids);

    // value now and at expiry, against the future
    const kind = o.chartKind === "put" ? "put" : "call", w = kind === "call" ? 1 : -1;
    const spread = black ? null : 3 * vol * Math.sqrt(Math.max(T, 1 / 365));
    const lo = black ? F * 0.4 : F - spread, hi = black ? F * 1.6 : F + spread;
    const xs = Array.from({ length: 161 }, (_, i) => lo + ((hi - lo) * i) / 160);
    const price = (f) => (black ? (f > 0 ? opt.black76(f, K, T, vol, r, kind) : null) : opt.bachelier(f, K, T, vol, r, kind));
    chartBox.append(h("div", { class: "filters" }, seg("Option", [{ value: "call", label: "Call" }, { value: "put", label: "Put" }], kind,
      (v) => { saveOpt({ chartKind: v }); draw(); })));
    lineChart(chartBox, {
      x: xs, xFmt: tick, xName: "Future at", fmt: p2, tickFmt: tick, height: 170, zero: true, xTitle: "Future, €/MWh",
      series: [
        { name: "Value now", values: xs.map(price), color: C.price },
        { name: "At expiry", values: xs.map((f) => Math.exp(-r * T) * Math.max(w * (f - K), 0)), color: C.load },
      ],
      marks: [{ x: F, label: `F ${tick(F)}` }, ...(Math.abs(K - F) > 1e-9 ? [{ x: K, label: `K ${tick(K)}` }] : [])],
      label: `${kind} value against the future price, now and at expiry`,
    });
    chartBox.appendChild(legend([{ name: "Value now", color: C.price }, { name: "Payoff at expiry", color: C.load }]));
  };
  const marketSel = h("select", { class: "select", "aria-label": "Market", onchange: (e) => { saveOpt({ market: e.target.value }); draw(); } },
    Object.values(MARKETS).sort((a, b) => a.name.localeCompare(b.name)).map((m) => h("option", { value: m.code, selected: m.code === o0.market || null }, m.code)));
  const sec = section("opt-vanilla",
    h("h2", { class: "h2", text: "Option on a future" }),
    h("p", { class: "note", text: "EEX's month, quarter and year options are European options on the future: Black-76. Bachelier assumes normal moves instead, which suits spreads and anything that can go negative." }),
    h("div", { class: "filters" }, seg("Model", [{ value: "black", label: "Black-76" }, { value: "bachelier", label: "Bachelier" }], o0.model,
      (v) => { saveOpt({ model: v }); render(); })),
    h("div", { class: "form-grid even" },
      optField("Future, €/MWh", "F", draw), optField("Strike, €/MWh", "K", draw), optField("Days to expiry", "days", draw),
      black0 ? optField("Vol, %", "vol", draw) : optField("Normal vol, €/MWh", "volN", draw),
      optField("Rate, %", "rate", draw, "0 for EEX"), optField("Premium you saw (call)", "seen", draw, "optional"),
      optField("Product", "product", draw), h("label", { class: "field" }, h("span", { text: "Market" }), marketSel), optField("Size, MW", "mw", draw)),
    out, chartBox);
  draw();
  return sec;
}

// --- a delivery month: European on the future vs Asian on the fixings
function monthSection() {
  const out = h("div", { class: "opt-out", "aria-live": "polite" });
  const chartBox = h("div", { class: "chart-box" });
  const o0 = optCfg();
  const draw = () => {
    const o = optCfg();
    chartBox.replaceChildren();
    const F = dec(o.mF), K = dec(o.mK), sl = dec(o.sl) / 100, ss = dec(o.ss) / 100, hl = dec(o.hl), rho = dec(o.rho);
    if (![F, K, sl, ss, hl, rho].every(isFinite) || F <= 0 || K <= 0 || sl < 0 || ss < 0 || hl <= 0 || Math.abs(rho) > 1)
      return warnOut(out, "Fill in every field: positive forward, strike, vols and half-life, and a correlation between −1 and 1.");
    let d;
    try { d = delivery(o.month || defaultMonth(), "DE"); } catch (e) { return warnOut(out, e.message); }
    if (d.period.kind !== "Month") return warnOut(out, `Pick a month, like ${defaultMonth()}.`);
    // The month option expires on the last weekday at least two days before delivery, at noon.
    let expN = d.period.start - 2;
    while (weekday(expN) > 4) expN--;
    const start = (d.startUtc - Date.now()) / YEAR_MS, days = d.period.days;
    const expiry = (zonedToUtc(expN, 12, TZ) - Date.now()) / YEAR_MS;
    if (expiry < 1 / 365) return warnOut(out, `${d.period.label} is too close: its month option would already have expired. Pick a later month.`);
    const kind = o.mKind === "put" ? "put" : "call";
    const model = opt.TwoFactor.fromHalfLife(ss, hl, sl, rho);
    const res = opt.monthOptions(model, F, K, start, days, expiry, 0, kind);
    const mc = opt.asianMc(res.forwards, res.fixingCov, K, res.end, 0, kind, 20000, 7);
    const expDay = isoDate(expN);
    const share = res.vFuture / res.vAverage;
    const sdF = res.mean * Math.sqrt(Math.expm1(res.vFuture)), sdA = res.mean * Math.sqrt(Math.expm1(res.vAverage));
    const row = (name, sub, value) => h("tr", null, h("th", { scope: "row" }, name, sub ? h("span", { class: "zn", text: sub }) : null), num(value));
    out.replaceChildren(
      table(["", "Premium"], [
        row("European on the month future", `expires ${dayName(expDay, true)}, at ${pct(res.futureVol)} implied vol`, p3(res.european)),
        row("Asian on the daily fixings", "moment matching", p3(res.asian)),
        row("Asian, Monte Carlo", "20,000 paths, geometric control variate", `${p3(mc.price)} ± ${p3(mc.stderr)}`),
        row("…without the control variate", "same paths", `${p3(mc.plain)} ± ${p3(mc.plainStderr)}`),
      ], { cls: "opt-tbl", caption: `${d.period.label} ${kind}s, strike ${p2(K)}` }),
      h("p", { class: "lede", text: `${pct(share, 0)} of the uncertainty in ${d.period.label}'s average builds up before delivery and ${pct(1 - share, 0)} during it. One standard deviation: ±${p2(sdF)} €/MWh for the month future at expiry, ±${p2(sdA)} for the realised average. The Asian is worth more because it carries the delivery days too.` }));

    // the Samuelson effect: how volatile a forward is, by time to delivery
    const startDays = start * 365, maxDays = Math.max(120, Math.ceil(startDays / 30) * 30 + 30);
    const xs = Array.from({ length: 241 }, (_, i) => (maxDays * i) / 240);
    chartBox.appendChild(h("h3", { class: "h3", text: "Volatility of a forward, by days to its delivery" }));
    lineChart(chartBox, {
      x: xs, xFmt: (v) => nf0.format(v), xName: "Days to delivery", fmt: (v) => pct(v / 100), tickFmt: (v) => `${nf0.format(v)}%`, height: 150, zero: true,
      series: [{ name: "Forward vol", values: xs.map((x) => 100 * model.forwardVol(x / 365)), color: C.price }],
      marks: [{ x: startDays, label: `${d.period.label} starts` }], xTitle: "Days to delivery",
      label: "Forward volatility against time to delivery",
    });
    chartBox.appendChild(h("p", { class: "note", text: `Two factors (Clewlow–Strickland): a short-term one, the spot's mean reversion, which barely moves a contract far from delivery and moves it hard close in; and a long-term one that moves every contract alike. Spot vol here is ${pct(model.forwardVol(0), 0)}; the month future trades at ${pct(res.futureVol, 0)}.` }));
  };
  const later = debounce(draw, 200);
  const sec = section("opt-month",
    h("h2", { class: "h2", text: "Average-price option on a delivery month" }),
    h("p", { class: "note", text: "A month future settles on the average spot price of the month, so an option on that average is an option on the future with two differences: it runs to the end of the month instead of expiring before delivery, and it also carries the uncertainty of the delivery days themselves. Both are priced here on the same model." }),
    h("div", { class: "filters" }, seg("Option", [{ value: "call", label: "Call" }, { value: "put", label: "Put" }], o0.mKind === "put" ? "put" : "call",
      (v) => { saveOpt({ mKind: v }); render(); })),
    h("div", { class: "form-grid even" },
      optField("Month", "month", later, defaultMonth()), optField("Forward, €/MWh", "mF", later), optField("Strike, €/MWh", "mK", later),
      optField("Long-term vol, %", "sl", later), optField("Short-term vol, %", "ss", later), optField("Half-life of a spot shock, days", "hl", later),
      optField("Correlation", "rho", later)),
    out, chartBox);
  draw();
  return sec;
}

// --- a spread option: the clean spark spread
function spreadSection() {
  const out = h("div", { class: "opt-out", "aria-live": "polite" });
  const draw = () => {
    const o = optCfg();
    const F1 = dec(o.pF), gas = dec(o.pGas), hr = dec(o.hr), eua = dec(o.eua), ef = dec(o.ef), vom = dec(o.vom);
    const s1 = dec(o.pVol) / 100, s2 = dec(o.gVol) / 100, rho = dec(o.pRho), T = dec(o.pDays) / 365;
    if (![F1, gas, hr, eua, ef, vom, s1, s2, rho, T].every(isFinite) || F1 <= 0 || gas <= 0 || hr <= 0 || T <= 0 || Math.abs(rho) > 1)
      return warnOut(out, "Fill in every field: positive prices, heat rate and days, and a correlation between −1 and 1.");
    const F2 = hr * gas, carbon = ef * eua, K = carbon + vom;
    if (F2 + K <= 0) return warnOut(out, "Fuel plus costs must be positive for Kirk's approximation.");
    const css = F1 - F2 - K;
    const value = opt.kirk(F1, F2, K, T, s1, s2, rho);
    const mc = opt.spreadMc(F1, F2, K, T, s1, s2, rho, 0, "call", 100000, 5);
    const rhos = [...new Set([0.5, 0.7, 0.8, 0.9, 0.95, rho])].filter((x) => Math.abs(x) <= 1).sort((a, b) => a - b);
    out.replaceChildren(
      h("p", { class: "lede", text: `Fuel ${p2(F2)} + carbon ${p2(carbon)} + variable cost ${p2(vom)} = ${p2(F2 + K)} €/MWh against power at ${p2(F1)}: a clean spark spread of ${signed(css)} (efficiency ${pct(1 / hr)}).` }),
      table(["", "€/MWh"], [
        h("tr", null, h("th", { scope: "row", text: "Spread option (Kirk)" }), num(p3(value))),
        h("tr", null, h("th", { scope: "row" }, "Monte Carlo check", h("span", { class: "zn", text: "100,000 paths" })), num(`${p3(mc.price)} ± ${p3(mc.stderr)}`)),
        h("tr", null, h("th", { scope: "row", text: "Intrinsic value" }), num(p2(Math.max(css, 0)))),
        h("tr", null, h("th", { scope: "row", text: "Time value" }), num(p2(value - Math.max(css, 0)))),
      ], { cls: "opt-tbl", caption: "Clean spark spread option" }),
      h("h3", { class: "h3", text: "The same option at other correlations" }),
      table(["Correlation", "Spread vol", "Option value"], rhos.map((x) => h("tr", { class: Math.abs(x - rho) < 1e-12 ? "current" : null },
        h("th", { scope: "row", text: x.toFixed(2) }), num(pct(opt.kirkVol(F2, K, s1, s2, x), 0)), num(p2(opt.kirk(F1, F2, K, T, s1, s2, x))))),
        { caption: "Spread option value by correlation" }),
      h("p", { class: "note", text: "The more power and gas move together, the less the spread moves, and the less the option is worth. A plant is a strip of these, one for every hour it could run; tolling deals start from that and subtract what a real plant can't do (start-up costs, minimum run times, ramping)." }));
  };
  const later = debounce(draw, 150);
  const sec = section("opt-spread",
    h("h2", { class: "h2", text: "Spread option: a gas plant's margin" }),
    h("p", { class: "note", text: "A gas plant earns power minus fuel minus carbon whenever that's positive, so owning one is like owning calls on the clean spark spread. Kirk's approximation prices one as an option on two futures." }),
    h("div", { class: "form-grid even" },
      optField("Power, €/MWh", "pF", later), optField("Gas, €/MWh (thermal)", "pGas", later), optField("Heat rate, MWh gas per MWh", "hr", later),
      optField("EUA, €/t", "eua", later), optField("Emissions, t per MWh", "ef", later), optField("Variable cost, €/MWh", "vom", later),
      optField("Power vol, %", "pVol", later), optField("Gas vol, %", "gVol", later), optField("Correlation", "pRho", later), optField("Days to expiry", "pDays", later)),
    out);
  draw();
  return sec;
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
    body.replaceChildren(...[
      h("p", { class: "muted" }, "The brief can send a short push through ntfy, a free notification app, with a link back here: at most two a day."),
      h("ol", { class: "steps" },
        h("li", null, "Install ntfy (", h("a", { href: NTFY_PLAY, target: "_blank", rel: "noopener" }, "Google Play"), " or ", h("a", { href: NTFY_IOS, target: "_blank", rel: "noopener" }, "App Store"), ")."),
        h("li", null, topic ? h("span", null, "Subscribe to this topic in the app: ", h("code", { class: "topic", text: topic })) : h("button", { type: "button", class: "btn small", onclick: gen }, "Make a private topic name")),
        h("li", null, "Add it to PowerDesk as an Actions secret named ", h("code", { text: "NTFY_TOPIC" }), ". ", h("a", { href: secretsUrl, target: "_blank", rel: "noopener" }, "Open the secrets page"))),
      topic ? h("div", { class: "row-btns" },
        h("button", { type: "button", class: "btn ghost", onclick: async () => { try { await sendPush(topic, "PowerApp test", "If you can read this, the brief's pushes will arrive too."); msg.textContent = "Sent. Check your phone."; } catch (e) { msg.textContent = e.message; } } }, "Send a test push"),
        h("button", { type: "button", class: "btn ghost", onclick: () => copy(topic) }, "Copy topic")) : null,
      msg].filter(Boolean));   // replaceChildren would print a null as "null"
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
