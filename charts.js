// charts.js — small dependency-free SVG charts for PowerApp.
// One y-axis per chart (never dual-axis). Stacked charts share a crosshair group keyed
// by time, so a quarter-hourly price chart and an hourly load chart line up.
import { localParts } from "./calendar.js";

const NS = "http://www.w3.org/2000/svg";
const WD = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const pad = (x) => String(x).padStart(2, "0");

function svg(tag, attrs = {}, parent) {
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null) el.setAttribute(k, v);
  if (parent) parent.appendChild(el);
  return el;
}
function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

// "Nice" ticks (d3-style) for a numeric domain.
function niceTicks(lo, hi, count) {
  if (!(hi > lo)) { const p = Math.abs(lo) * 0.05 || 1; lo -= p; hi += p; }
  const raw = (hi - lo) / Math.max(1, count);
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const err = raw / mag;
  const step = (err >= 7.5 ? 10 : err >= 3.5 ? 5 : err >= 1.5 ? 2 : 1) * mag;
  const ticks = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + step * 1e-9; v += step) ticks.push(+v.toFixed(10));
  return ticks;
}
function domain(values, { zero = false } = {}) {
  let lo = Infinity, hi = -Infinity;
  for (const v of values) if (v != null && isFinite(v)) { if (v < lo) lo = v; if (v > hi) hi = v; }
  if (!isFinite(lo)) { lo = 0; hi = 1; }
  if (zero) { lo = Math.min(0, lo); hi = Math.max(0, hi); }
  const padv = (hi - lo) * 0.08 || Math.abs(hi) * 0.05 || 1;
  const ticks = niceTicks(lo - padv, hi + padv, 4);
  // A little headroom so the extremes don't sit on the frame and read as clipped; a zero
  // baseline the data rests on stays at the edge.
  const y0 = zero && lo >= 0 ? Math.min(ticks[0], 0) : Math.min(ticks[0], lo - padv / 2);
  const y1 = zero && hi <= 0 ? Math.max(ticks[ticks.length - 1], 0) : Math.max(ticks[ticks.length - 1], hi + padv / 2);
  return { y0, y1, ticks };
}

// Local time labels (t in unix seconds).
const lp = (t, tz) => localParts(t * 1000, tz);
const wd = (p) => WD[(new Date(Date.UTC(p.y, p.m - 1, p.d)).getUTCDay() + 6) % 7];
export const fmtClock = (t, tz) => { const p = lp(t, tz); return `${pad(p.h)}:${pad(p.mi)}`; };
export const fmtDayTime = (t, tz) => { const p = lp(t, tz); return `${wd(p)} ${p.d} ${MON[p.m - 1]} ${pad(p.h)}:${pad(p.mi)}`; };

// A crosshair group keeps stacked charts on the same instant.
export function crosshairGroup() {
  const charts = new Set();
  return {
    add(c) { charts.add(c); },
    remove(c) { charts.delete(c); },
    set(t, from) { for (const c of charts) c._setTime(t, from); },
  };
}

let openTouchChart = null;
document.addEventListener("pointerdown", (e) => {
  if (openTouchChart && !openTouchChart.root.contains(e.target)) {
    openTouchChart.group.set(null);
    openTouchChart = null;
  }
}, { passive: true });

function keyed(name, color, value, lineKey = true) {
  const item = el("span", "ro-item");
  const key = el("i", lineKey ? "ro-key" : "ro-key dotkey");
  key.style.setProperty("--k", color);
  item.append(key, el("span", null, name));
  if (value != null) item.appendChild(el("b", null, value));
  return item;
}

/**
 * stepChart(container, opts): values that hold for an interval (prices, hourly load).
 *  opts.t       interval starts, unix seconds, ascending
 *  opts.step    interval length in seconds
 *  opts.series  [{ name, values, color }] aligned to t; null = missing
 *  opts.tz      time zone for labels
 *  opts.fmt     value formatter for the readout; opts.tickFmt for the axis (defaults to fmt)
 *  opts.height  plot height in px; the axis band is added on top
 *  opts.zero    keep 0 in the y domain and draw it as a baseline
 *  opts.group   crosshairGroup() shared with stacked charts
 *  opts.label   accessible description
 */
export function stepChart(container, opts) {
  const group = opts.group || crosshairGroup();
  const tz = opts.tz || "Europe/Berlin";
  const fmt = opts.fmt || ((v) => String(v));
  const tickFmt = opts.tickFmt || fmt;
  const series = opts.series;
  const t = opts.t, n = t.length, step = opts.step;
  const H = opts.height || 150, AXIS = 22;
  const root = el("div", "chart");
  const head = el("div", "chart-readout");
  const plotWrap = el("div", "chart-plot");
  root.append(head, plotWrap);
  container.appendChild(root);

  let W = 0, cur = null, s = null, geo = null;
  const self = { root, group, _setTime: setTime, destroy };
  group.add(self);
  const t0 = n ? t[0] : 0, tEnd = n ? t[n - 1] + step : 1;
  const indexAt = (time) => {
    if (time == null || !n) return null;
    let lo = 0, hi = n - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (t[mid] <= time) lo = mid; else hi = mid - 1; }
    return time >= t[lo] && time < t[lo] + step ? lo : null;
  };

  function readout(i) {
    head.replaceChildren();
    const left = el("div", "ro-vals");
    for (const se of series) {
      let v;
      if (i == null) { // the period average, until someone points at a time
        const vals = se.values.filter((x) => x != null);
        v = vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
      } else v = se.values[i];
      left.appendChild(keyed(se.name, se.color, v == null ? "—" : fmt(v)));
    }
    const right = el("span", "ro-date", i == null ? "Average" : `${fmtDayTime(t[i], tz)}–${fmtClock(t[i] + step, tz)}`);
    head.append(left, right);
  }

  function render() {
    W = Math.max(240, Math.round(plotWrap.clientWidth || container.clientWidth || 320));
    plotWrap.replaceChildren();
    if (!n) { readout(null); return; }
    const m = { l: 6, r: 46, t: 8, b: AXIS };
    const pw = W - m.l - m.r, ph = H;
    const all = series.flatMap((se) => se.values);
    const { y0, y1, ticks } = domain(all, { zero: opts.zero || Math.min(...all.filter((v) => v != null)) < 0 });
    const X = (time) => m.l + ((time - t0) / (tEnd - t0)) * pw;
    const Y = (v) => m.t + ph - ((v - y0) / (y1 - y0)) * ph;
    geo = { X, Y, m, pw, ph };
    const root2 = svg("svg", { width: W, height: ph + m.t + m.b, viewBox: `0 0 ${W} ${ph + m.t + m.b}`,
      class: "chart-svg", role: "img", tabindex: 0, "aria-label": opts.label || series.map((x) => x.name).join(", ") });
    const g = svg("g", { class: "grid" }, root2);
    for (const v of ticks) {
      if (v < y0 || v > y1) continue;
      const yy = Math.round(Y(v)) + 0.5;
      svg("line", { x1: m.l, x2: m.l + pw, y1: yy, y2: yy, class: v === 0 ? "zero" : null }, g);
      svg("text", { x: m.l + pw + 8, y: yy, class: "tick", "dominant-baseline": "middle" }, g).textContent = tickFmt(v);
    }
    // x axis: day boundaries as hairlines; day names first, then hours every 3 or 6 h where they fit
    const gx = svg("g", { class: "xaxis" }, root2);
    svg("line", { x1: m.l, x2: m.l + pw, y1: m.t + ph + 0.5, y2: m.t + ph + 0.5, class: "base" }, gx);
    const span = (tEnd - t0) / 3600, every = span > 30 ? 6 : 3;
    const cands = [];
    for (let hr = Math.ceil(t0 / 3600) * 3600; hr <= tEnd; hr += 3600) {
      const p = lp(hr, tz);
      if (p.mi !== 0 || p.h % every !== 0) continue;
      const xx = X(hr);
      if (p.h === 0 && hr > t0) svg("line", { x1: xx, x2: xx, y1: m.t, y2: m.t + ph, class: "daysep" }, gx);
      cands.push({ xx, day: p.h === 0, text: p.h === 0 ? `${wd(p)} ${p.d}` : `${pad(p.h)}:00` });
    }
    const placed = [];
    const fits = (xx, gap) => xx >= m.l + 16 && xx <= m.l + pw - 16 && placed.every((q) => Math.abs(q - xx) >= gap);
    for (const c of [...cands.filter((c) => c.day), ...cands.filter((c) => !c.day)]) {
      if (!fits(c.xx, 46)) continue;
      placed.push(c.xx);
      svg("line", { x1: c.xx, x2: c.xx, y1: m.t + ph, y2: m.t + ph + 4, class: "base" }, gx);
      svg("text", { x: c.xx, y: m.t + ph + 16, class: c.day ? "tick strong" : "tick", "text-anchor": "middle" }, gx).textContent = c.text;
    }
    // marks: steps that hold for their interval; a gap breaks the line
    for (const se of series) {
      let d = "", prevEnd = null;
      for (let i = 0; i < n; i++) {
        const v = se.values[i];
        if (v == null) { prevEnd = null; continue; }
        const x0 = X(t[i]).toFixed(1), x1 = X(Math.min(t[i] + step, i + 1 < n ? t[i + 1] : tEnd)).toFixed(1), y = Y(v).toFixed(1);
        d += prevEnd === t[i] ? `V${y}H${x1}` : `M${x0},${y}H${x1}`;
        prevEnd = t[i] + step;
      }
      if (d) svg("path", { d, class: "line", style: `--c:${se.color}` }, root2);
    }
    const cross = svg("g", { class: "cross" }, root2);
    const vline = svg("line", { y1: m.t, y2: m.t + ph, class: "vline" }, cross);
    const dots = series.map((se) => svg("circle", { r: 4, class: "dot", style: `--c:${se.color}` }, cross));
    const hit = svg("rect", { x: m.l, y: 0, width: pw, height: ph + m.t + m.b, class: "hit" }, root2);
    s = { cross, vline, dots };
    const timeAt = (clientX) => {
      const r = root2.getBoundingClientRect();
      return t0 + ((clientX - r.left - m.l) / pw) * (tEnd - t0);
    };
    hit.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      if (e.pointerType !== "mouse") openTouchChart = self;
      group.set(timeAt(e.clientX), self);
    });
    hit.addEventListener("pointermove", (e) => { if (e.pointerType === "mouse" || e.buttons) group.set(timeAt(e.clientX), self); });
    hit.addEventListener("pointerleave", (e) => { if (e.pointerType === "mouse") group.set(null); });
    root2.addEventListener("keydown", (e) => {
      const i = indexAt(cur) ?? n - 1;
      const k = { ArrowLeft: i - 1, ArrowRight: i + 1, Home: 0, End: n - 1 }[e.key];
      if (k != null) { e.preventDefault(); group.set(t[Math.max(0, Math.min(n - 1, k))] + 1, self); }
      if (e.key === "Escape") group.set(null);
    });
    root2.addEventListener("blur", () => group.set(null));
    plotWrap.appendChild(root2);
    paint();
  }

  function paint() {
    const i = indexAt(cur);
    readout(i);
    if (!s || !geo) return;
    if (i == null) { s.cross.style.display = "none"; return; }
    s.cross.style.display = "";
    const x = geo.X(t[i] + step / 2);
    s.vline.setAttribute("x1", x);
    s.vline.setAttribute("x2", x);
    series.forEach((se, k) => {
      const v = se.values[i], dot = s.dots[k];
      if (v == null) { dot.style.display = "none"; return; }
      dot.style.display = "";
      dot.setAttribute("cx", x);
      dot.setAttribute("cy", geo.Y(v));
    });
  }
  function setTime(time) { cur = time; paint(); }

  let raf = 0;
  const ro = new ResizeObserver(() => {
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(() => { const w = Math.round(plotWrap.clientWidth); if (w && Math.abs(w - W) > 1) render(); });
  });
  ro.observe(plotWrap);
  function destroy() { ro.disconnect(); group.remove(self); root.remove(); }
  render();
  return self;
}

/**
 * scatterChart(container, opts): one dot per observation.
 *  opts.groups     [{ name, color, points: [{ x, y, label }] }], drawn in order
 *  opts.xFmt/yFmt  tick formatters; opts.xRead/yRead readout formatters (default to the tick ones)
 *  opts.xTitle/yTitle axis titles; opts.xName/yName short names for the readout
 *  opts.height     plot height in px
 *  opts.label      accessible description
 * The nearest dot within 24px answers the pointer, so nobody has to land on a dot.
 */
export function scatterChart(container, opts) {
  const groups = opts.groups;
  const xFmt = opts.xFmt || String, yFmt = opts.yFmt || String;
  const H = opts.height || 260, AXIS = 34;
  const root = el("div", "chart");
  const head = el("div", "chart-readout");
  const plotWrap = el("div", "chart-plot");
  root.append(head, plotWrap);
  container.appendChild(root);
  const pts = groups.flatMap((g, gi) => g.points.map((p) => ({ ...p, gi })));
  let W = 0, geo = null, mark = null, sel = null;

  function readout(p) {
    head.replaceChildren();
    const left = el("div", "ro-vals");
    if (p) {
      const pair = (name, value) => { const it = el("span", "ro-item"); it.append(el("span", null, name), el("b", null, value)); return it; };
      left.append(keyed(groups[p.gi].name, groups[p.gi].color, null, false),
        pair(opts.xName || "x", (opts.xRead || xFmt)(p.x)), pair(opts.yName || "y", (opts.yRead || yFmt)(p.y)));
    } else left.appendChild(el("span", "muted", opts.hint || "Point at a dot for its values"));
    head.append(left, el("span", "ro-date", p && p.label ? p.label : ""));
  }

  function render() {
    W = Math.max(240, Math.round(plotWrap.clientWidth || container.clientWidth || 320));
    plotWrap.replaceChildren();
    const m = { l: 6, r: 46, t: 10, b: AXIS };
    const pw = W - m.l - m.r, ph = H;
    const xd = domain(pts.map((p) => p.x), { zero: true });
    const yd = domain(pts.map((p) => p.y), { zero: true });
    const X = (v) => m.l + ((v - xd.y0) / (xd.y1 - xd.y0)) * pw;
    const Y = (v) => m.t + ph - ((v - yd.y0) / (yd.y1 - yd.y0)) * ph;
    geo = { X, Y };
    const root2 = svg("svg", { width: W, height: ph + m.t + m.b, viewBox: `0 0 ${W} ${ph + m.t + m.b}`,
      class: "chart-svg", role: "img", tabindex: 0, "aria-label": opts.label || "Scatter chart" });
    const g = svg("g", { class: "grid" }, root2);
    for (const v of yd.ticks) {
      if (v < yd.y0 || v > yd.y1) continue;
      const yy = Math.round(Y(v)) + 0.5;
      svg("line", { x1: m.l, x2: m.l + pw, y1: yy, y2: yy, class: v === 0 ? "zero" : null }, g);
      svg("text", { x: m.l + pw + 8, y: yy, class: "tick", "dominant-baseline": "middle" }, g).textContent = yFmt(v);
    }
    for (const v of xd.ticks) {
      if (v < xd.y0 || v > xd.y1) continue;
      const xx = Math.round(X(v)) + 0.5;
      svg("line", { x1: xx, x2: xx, y1: m.t, y2: m.t + ph, class: v === 0 ? "zero" : null }, g);
      svg("text", { x: xx, y: m.t + ph + 16, class: "tick", "text-anchor": "middle" }, g).textContent = xFmt(v);
    }
    svg("line", { x1: m.l, x2: m.l + pw, y1: m.t + ph + 0.5, y2: m.t + ph + 0.5, class: "base" }, root2);
    if (opts.xTitle) svg("text", { x: m.l + pw, y: m.t + ph + 31, class: "tick", "text-anchor": "end" }, root2).textContent = opts.xTitle;
    if (opts.yTitle) svg("text", { x: m.l + 4, y: m.t + 10, class: "tick" }, root2).textContent = opts.yTitle;
    for (const gr of groups) {
      const layer = svg("g", { class: `dots ${gr.cls || ""}`.trim(), style: `--c:${gr.color}` }, root2);
      for (const p of gr.points) svg("circle", { cx: X(p.x).toFixed(1), cy: Y(p.y).toFixed(1), r: gr.r || 4 }, layer);
    }
    mark = svg("circle", { r: 7, class: "dot-sel" }, root2);
    mark.style.display = "none";
    const hit = svg("rect", { x: 0, y: 0, width: W, height: ph + m.t + m.b, class: "hit" }, root2);
    const nearest = (e) => {
      const r = root2.getBoundingClientRect();
      const x = e.clientX - r.left, y = e.clientY - r.top;
      let best = null, bd = 24 * 24;
      for (const p of pts) {
        const dx = X(p.x) - x, dy = Y(p.y) - y, dd = dx * dx + dy * dy;
        if (dd <= bd) { bd = dd; best = p; }
      }
      return best;
    };
    const show = (p) => {
      sel = p;
      readout(p);
      if (!p) { mark.style.display = "none"; return; }
      mark.style.display = "";
      mark.setAttribute("cx", X(p.x));
      mark.setAttribute("cy", Y(p.y));
      mark.style.setProperty("--c", groups[p.gi].color);
    };
    hit.addEventListener("pointermove", (e) => show(nearest(e)));
    hit.addEventListener("pointerdown", (e) => { e.preventDefault(); show(nearest(e)); });
    hit.addEventListener("pointerleave", (e) => { if (e.pointerType === "mouse") show(null); });
    root2.addEventListener("keydown", (e) => {
      if (!pts.length) return;
      const i = sel ? pts.indexOf(sel) : -1;
      const k = { ArrowLeft: i - 1, ArrowRight: i + 1, Home: 0, End: pts.length - 1 }[e.key];
      if (k != null) { e.preventDefault(); show(pts[(k + pts.length) % pts.length]); }
      if (e.key === "Escape") show(null);
    });
    root2.addEventListener("blur", () => show(null));
    plotWrap.appendChild(root2);
    readout(null);
  }

  let raf = 0;
  const ro = new ResizeObserver(() => {
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(() => { const w = Math.round(plotWrap.clientWidth); if (w && Math.abs(w - W) > 1) render(); });
  });
  ro.observe(plotWrap);
  render();
  return { root, destroy() { ro.disconnect(); root.remove(); } };
}

/**
 * lineChart(container, opts): series over a numeric x, e.g. an option's value against the future.
 *  opts.x        ascending x values
 *  opts.series   [{ name, values, color }] aligned to x
 *  opts.xFmt     x formatter (ticks and readout); opts.fmt / opts.tickFmt for y
 *  opts.marks    [{ x, label }] vertical reference lines (the strike, today's price); the readout
 *                rests on the first one until someone points at the chart
 *  opts.rest     an x for the readout to rest on instead (default: the first mark, else the last x)
 *  opts.xTitle, opts.height, opts.label, opts.zero
 */
export function lineChart(container, opts) {
  const xs = opts.x, n = xs.length, series = opts.series;
  const xFmt = opts.xFmt || String, fmt = opts.fmt || String, tickFmt = opts.tickFmt || fmt;
  const H = opts.height || 180, AXIS = opts.xTitle ? 34 : 22;
  const root = el("div", "chart"), head = el("div", "chart-readout"), plotWrap = el("div", "chart-plot");
  root.append(head, plotWrap);
  container.appendChild(root);
  let W = 0, geo = null, s = null, cur = null;
  const nearest = (x) => { let b = 0; for (let i = 1; i < n; i++) if (Math.abs(xs[i] - x) < Math.abs(xs[b] - x)) b = i; return b; };
  const rest = opts.rest != null ? nearest(opts.rest) : opts.marks && opts.marks.length ? nearest(opts.marks[0].x) : n - 1;

  function readout(i) {
    head.replaceChildren();
    const left = el("div", "ro-vals");
    for (const se of series) left.appendChild(keyed(se.name, se.color, se.values[i] == null ? "—" : fmt(se.values[i])));
    head.append(left, el("span", "ro-date", `${opts.xName ? opts.xName + " " : ""}${xFmt(xs[i])}`));
  }
  function render() {
    W = Math.max(240, Math.round(plotWrap.clientWidth || container.clientWidth || 320));
    plotWrap.replaceChildren();
    const m = { l: 6, r: 46, t: 14, b: AXIS };
    const pw = W - m.l - m.r, ph = H;
    const { y0, y1, ticks } = domain(series.flatMap((se) => se.values), { zero: opts.zero });
    const X = (v) => m.l + ((v - xs[0]) / (xs[n - 1] - xs[0])) * pw;
    const Y = (v) => m.t + ph - ((v - y0) / (y1 - y0)) * ph;
    geo = { X, Y };
    const root2 = svg("svg", { width: W, height: ph + m.t + m.b, viewBox: `0 0 ${W} ${ph + m.t + m.b}`,
      class: "chart-svg", role: "img", tabindex: 0, "aria-label": opts.label || series.map((x) => x.name).join(", ") });
    const g = svg("g", { class: "grid" }, root2);
    for (const v of ticks) {
      if (v < y0 || v > y1) continue;
      const yy = Math.round(Y(v)) + 0.5;
      svg("line", { x1: m.l, x2: m.l + pw, y1: yy, y2: yy, class: v === 0 ? "zero" : null }, g);
      svg("text", { x: m.l + pw + 8, y: yy, class: "tick", "dominant-baseline": "middle" }, g).textContent = tickFmt(v);
    }
    svg("line", { x1: m.l, x2: m.l + pw, y1: m.t + ph + 0.5, y2: m.t + ph + 0.5, class: "base" }, root2);
    const xt = niceTicks(xs[0], xs[n - 1], Math.max(2, Math.floor(pw / 70)));
    for (const v of xt) {
      if (v < xs[0] || v > xs[n - 1] || (opts.xInt && !Number.isInteger(v))) continue;   // xInt: whole numbers only (years)
      const xx = X(v);
      svg("line", { x1: xx, x2: xx, y1: m.t + ph, y2: m.t + ph + 4, class: "base" }, root2);
      svg("text", { x: xx, y: m.t + ph + 16, class: "tick", "text-anchor": "middle" }, root2).textContent = xFmt(v);
    }
    if (opts.xTitle) svg("text", { x: m.l + pw, y: m.t + ph + 31, class: "tick", "text-anchor": "end" }, root2).textContent = opts.xTitle;
    // Reference lines; when two sit close, their labels face away from each other.
    const marks = (opts.marks || []).filter((mk) => mk.x >= xs[0] && mk.x <= xs[n - 1]).sort((a, b) => a.x - b.x);
    marks.forEach((mk, i) => {
      const xx = Math.round(X(mk.x)) + 0.5;
      const crowded = i + 1 < marks.length && X(marks[i + 1].x) - X(mk.x) < 56;
      svg("line", { x1: xx, x2: xx, y1: m.t, y2: m.t + ph, class: "mark" }, root2);
      svg("text", { x: crowded ? xx - 4 : xx + 4, y: m.t + 2, class: "tick", "dominant-baseline": "hanging", "text-anchor": crowded ? "end" : "start" }, root2).textContent = mk.label;
    });
    for (const se of series) {
      let d = "", pen = false;
      for (let i = 0; i < n; i++) {
        const v = se.values[i];
        if (v == null || !isFinite(v)) { pen = false; continue; }
        d += `${pen ? "L" : "M"}${X(xs[i]).toFixed(1)},${Y(v).toFixed(1)}`;
        pen = true;
      }
      if (d) svg("path", { d, class: "line", style: `--c:${se.color}` }, root2);
    }
    const cross = svg("g", { class: "cross" }, root2);
    const vline = svg("line", { y1: m.t, y2: m.t + ph, class: "vline" }, cross);
    const dots = series.map((se) => svg("circle", { r: 4, class: "dot", style: `--c:${se.color}` }, cross));
    const hit = svg("rect", { x: m.l, y: 0, width: pw, height: ph + m.t + m.b, class: "hit" }, root2);
    s = { cross, vline, dots };
    const at = (e) => { const r = root2.getBoundingClientRect(); return nearest(xs[0] + ((e.clientX - r.left - m.l) / pw) * (xs[n - 1] - xs[0])); };
    hit.addEventListener("pointerdown", (e) => { e.preventDefault(); set(at(e)); });
    hit.addEventListener("pointermove", (e) => { if (e.pointerType === "mouse" || e.buttons) set(at(e)); });
    hit.addEventListener("pointerleave", (e) => { if (e.pointerType === "mouse") set(null); });
    root2.addEventListener("keydown", (e) => {
      const i = cur ?? rest;
      const k = { ArrowLeft: i - 1, ArrowRight: i + 1, Home: 0, End: n - 1 }[e.key];
      if (k != null) { e.preventDefault(); set(Math.max(0, Math.min(n - 1, k))); }
      if (e.key === "Escape") set(null);
    });
    root2.addEventListener("blur", () => set(null));
    plotWrap.appendChild(root2);
    paint();
  }
  function paint() {
    readout(cur ?? rest);
    if (!s || !geo) return;
    if (cur == null) { s.cross.style.display = "none"; return; }
    s.cross.style.display = "";
    const x = geo.X(xs[cur]);
    s.vline.setAttribute("x1", x); s.vline.setAttribute("x2", x);
    series.forEach((se, k) => {
      const v = se.values[cur];
      if (v == null || !isFinite(v)) { s.dots[k].style.display = "none"; return; }
      s.dots[k].style.display = "";
      s.dots[k].setAttribute("cx", x); s.dots[k].setAttribute("cy", geo.Y(v));
    });
  }
  function set(i) { cur = i; paint(); }
  let raf = 0;
  const ro = new ResizeObserver(() => {
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(() => { const w = Math.round(plotWrap.clientWidth); if (w && Math.abs(w - W) > 1) render(); });
  });
  ro.observe(plotWrap);
  render();
  return { root, destroy() { ro.disconnect(); root.remove(); } };
}

// A legend row: keyed names, always visible under a chart with two or more series.
export function legend(items) {
  const row = el("div", "legend");
  for (const it of items) row.appendChild(keyed(it.name, it.color, null, !it.dot));
  return row;
}

/**
 * waterfallChart(container, opts): a bridge from one total to another, one row per step.
 *  opts.steps  [{ label, value, total }]: a total sets the running sum (drawn from zero), a step
 *              moves it (drawn between the sums before and after)
 *  opts.fmt    value formatter; steps get a sign
 *  opts.unit   shown in the readout
 *  opts.label  accessible description
 * Rows are HTML, so long labels wrap on a phone; every value is printed, the readout gives the
 * running sum of the row under the pointer or focus.
 */
export function waterfallChart(container, opts) {
  // a step that is zero up to rounding dust shows as zero, not "−€0"
  const fmt = opts.fmt || String, steps = opts.steps.map((s) => (Math.abs(s.value) < 1e-6 ? { ...s, value: 0 } : s));
  const root = el("div", "chart wf-chart");
  const head = el("div", "chart-readout");
  const rows = el("div", "wf");
  rows.setAttribute("role", "table");
  rows.setAttribute("aria-label", opts.label || "Bridge");
  root.append(head, rows);
  container.appendChild(root);
  // running sums
  let run = 0;
  const spans = steps.map((s) => {
    const a = s.total ? 0 : run, b = s.total ? s.value : run + s.value;
    run = s.total ? s.value : run + s.value;
    return { a, b, after: run };
  });
  let lo = 0, hi = 0;
  for (const sp of spans) { lo = Math.min(lo, sp.a, sp.b); hi = Math.max(hi, sp.a, sp.b); }
  if (hi === lo) hi = lo + 1;
  const pad = (hi - lo) * 0.03;
  lo = lo < 0 ? lo - pad : lo; hi += pad;
  const pct = (v) => ((v - lo) / (hi - lo)) * 100;
  const readout = (i) => {
    head.replaceChildren();
    const left = el("div", "ro-vals");
    if (i == null) left.appendChild(el("span", "muted", "Point at a step for the running total"));
    else {
      const s = steps[i];
      const it = el("span", "ro-item");
      it.append(el("span", null, s.label), el("b", null, s.total ? fmt(s.value) : `${s.value > 0 ? "+" : ""}${fmt(s.value)}`));
      left.appendChild(it);
      if (!s.total) { const r = el("span", "ro-item"); r.append(el("span", null, "after it"), el("b", null, fmt(spans[i].after))); left.appendChild(r); }
    }
    head.append(left, el("span", "ro-date", opts.unit || ""));
  };
  steps.forEach((s, i) => {
    const sp = spans[i], kind = s.total ? "total" : s.value >= 0 ? "up" : "down";
    const row = el("div", `wf-row ${kind}`);
    row.setAttribute("role", "row");
    row.tabIndex = 0;
    const lab = el("span", "wf-label", s.label);
    lab.setAttribute("role", "rowheader");
    const track = el("span", "wf-track");
    track.setAttribute("role", "cell");
    if (lo < 0) { const z = el("i", "wf-zero"); z.style.left = `${pct(0)}%`; track.appendChild(z); }
    if (s.total || Math.abs(s.value) > 1e-9) {        // a step of nothing gets no bar
      const bar = el("i", "wf-bar");
      const x0 = pct(Math.min(sp.a, sp.b)), x1 = pct(Math.max(sp.a, sp.b));
      bar.style.left = `${x0}%`;
      bar.style.width = `${Math.max(x1 - x0, 0.6)}%`;
      track.appendChild(bar);
    }
    const val = el("span", "wf-val", s.total ? fmt(s.value) : `${s.value > 0 ? "+" : ""}${fmt(s.value)}`);
    val.setAttribute("role", "cell");
    row.append(lab, track, val);
    const on = () => readout(i), off = () => readout(null);
    row.addEventListener("pointerenter", on);
    row.addEventListener("pointerleave", off);
    row.addEventListener("focus", on);
    row.addEventListener("blur", off);
    rows.appendChild(row);
  });
  readout(null);
  return { root, destroy() { root.remove(); } };
}
