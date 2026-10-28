// intraday.js — a battery in the intraday market, simulated: what waiting is worth.
// A port of PowerDesk's powerdesk/intraday.py (the reference); tests/intraday.test.mjs checks the two
// agree on every number, day by day (they share a seeded generator).
//
// A toy world for one delivery day, made up on purpose except the day-ahead prices. Each hour's final
// intraday price is day-ahead plus a drift that persists from hour to hour (AR(1), on a Tauchen grid)
// and spikes (a unit trips, a forecast busts) that start from calm with probability perDay/24, last
// `length` hours on average and mostly go the way of the day (up in its dear half, down in its cheap
// half), shifted so each hour averages its day-ahead price: intraday is fair. Before an hour closes the
// market quotes it at its expected final price.
//
// The battery sells its day-ahead schedule in the auction; every MWh traded in intraday after that
// costs `cost`, and every MWh it ends up drawing from the grid to charge pays the grid `fee` (a cost
// of the physical schedule, not of trading). Day-ahead keeps the schedule. The rolling LP, every hour, plans the rest of the day on
// the quotes and trades the plan at once, changing it later only when the new plan beats the old by
// more than what the trades cost. The patient trader trades each hour only when it closes, choosing by
// a dynamic programme over the hour, the charge, the cycles used and the state of the world. The oracle
// knows every final price in advance.
const IDLE = 0, CHARGE = 1, DISCHARGE = 2, TOL = 1e-9, NEG = -Infinity;
export const POLICIES = ["day_ahead", "rolling", "patient", "oracle"];
export const ACTIONS = { IDLE, CHARGE, DISCHARGE };

// ------------------------------------------------------------------ small numerics, as in intraday.py
// mulberry32: seeded uniforms in [0, 1).
export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), a | 1) >>> 0;
    t = ((t + Math.imul(t ^ (t >>> 7), t | 61)) ^ t) >>> 0;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Cumulative normal (Hart 1968, as given by West 2005).
export function ncdf(x) {
  const a = Math.abs(x);
  let c;
  if (a > 37) c = 0;
  else {
    const e = Math.exp(-a * a / 2);
    if (a < 7.07106781186547) {
      let b = 3.52624965998911e-02 * a + 0.700383064443688;
      b = b * a + 6.37396220353165; b = b * a + 33.912866078383; b = b * a + 112.079291497871;
      b = b * a + 221.213596169931; b = b * a + 220.206867912376;
      c = e * b;
      b = 8.83883476483184e-02 * a + 1.75566716318264;
      b = b * a + 16.064177579207; b = b * a + 86.7807322029461; b = b * a + 296.564248779674;
      b = b * a + 637.333633378831; b = b * a + 793.826512519948; b = b * a + 440.413735824752;
      c /= b;
    } else {
      let b = a + 0.65;
      b = a + 4 / b; b = a + 3 / b; b = a + 2 / b; b = a + 1 / b;
      c = e / b / 2.506628274631;
    }
  }
  return x > 0 ? 1 - c : c;
}

export function draw(row, u) {
  let acc = 0.0;
  for (let j = 0; j < row.length; j++) { acc += row[j]; if (u < acc) return j; }
  return row.length - 1;
}
const mv = (m, v) => m.map((r) => { let s = 0; for (let j = 0; j < v.length; j++) s += r[j] * v[j]; return s; });
const vm = (v, m) => m[0].map((_, j) => { let s = 0; for (let i = 0; i < v.length; i++) s += v[i] * m[i][j]; return s; });
const sum = (xs) => { let s = 0; for (const x of xs) s += x; return s; };

// ------------------------------------------------------------------ the world
// An AR(1) x' = phi x + sigma e on n levels (n odd) spanning m stationary standard deviations.
export function tauchen(phi, sigma, n = 15, m = 3.0) {
  if (sigma <= 0 || n <= 1) return [[0.0], [[1.0]]];
  const sd = sigma / Math.sqrt(1 - phi * phi), span = m * sd, mid = (n - 1) / 2;
  const grid = Array.from({ length: n }, (_, i) => span * (i - mid) / mid);
  const w = grid[1] - grid[0];
  const rows = grid.map((x) => {
    const mu = phi * x;
    return grid.map((y, j) => (j === 0 ? ncdf((y + w / 2 - mu) / sigma)
      : j === n - 1 ? 1 - ncdf((y - w / 2 - mu) / sigma)
        : ncdf((y + w / 2 - mu) / sigma) - ncdf((y - w / 2 - mu) / sigma)));
  });
  return [grid, rows];
}

// Calm, `bins` upward and `bins` downward spike sizes (equal-probability slices of an exponential with
// mean `size`): [price add-on per state, transition rows into each hour].
export function spikeChain(da, perDay, size, length, shape, bins = 3) {
  const lam = Math.min(Math.max(perDay, 0) / 24, 1);
  if (lam <= 0 || size <= 0) return [[0.0], da.map(() => [[1.0]])];
  const stay = length > 1 ? 1 - 1 / length : 0.0;
  const raw = Array.from({ length: bins }, (_, b) => -Math.log(1 - (b + 0.5) / bins));
  const k = size / (sum(raw) / bins), sizes = raw.map((r) => k * r);
  const jump = [0.0, ...sizes, ...sizes.map((s) => -s)], n = 1 + 2 * bins;
  const mid = [...da].sort((a, b) => a - b)[Math.floor(da.length / 2)];
  const out = da.map((p) => {
    const up = p >= mid ? shape : 1 - shape;
    const rows = Array.from({ length: n }, () => new Array(n).fill(0.0));
    rows[0][0] = 1 - lam;
    for (let b = 0; b < bins; b++) { rows[0][1 + b] = lam * up / bins; rows[0][1 + bins + b] = lam * (1 - up) / bins; }
    for (let i = 1; i < n; i++) { rows[i][i] = stay; rows[i][0] = 1 - stay; }
    return rows;
  });
  return [jump, out];
}

// The intraday world around a day-ahead day (EUR/MWh, hours, shares as fractions).
export function world(da, { sigma = 8.0, phi = 0.8, perDay = 1.0, size = 80.0, length = 2.0, shape = 0.8, cost = 2.0, levels = 15, bins = 3 } = {}) {
  const n = da.length;
  const [drift, pd] = tauchen(Math.min(Math.max(phi, 0), 0.98), Math.max(sigma, 0), levels);
  const [jump, ps] = spikeChain(da, perDay, size, length, Math.min(Math.max(shape, 0), 1), bins);
  const ns = jump.length, nd = drift.length;
  const ejm = [], edm = [];
  let dist = ps[0][0].slice();
  for (let h = 0; h < n; h++) { if (h) dist = vm(dist, ps[h]); let s = 0; for (let i = 0; i < ns; i++) s += dist[i] * jump[i]; ejm.push(s); }
  let dd = pd[Math.floor(nd / 2)].slice();
  for (let h = 0; h < n; h++) { if (h) dd = vm(dd, pd); let s = 0; for (let i = 0; i < nd; i++) s += dd[i] * drift[i]; edm.push(s); }
  const comp = ejm.slice();
  const edrift = [drift.slice()];
  for (let i = 0; i < n; i++) edrift.push(mv(pd, edrift[edrift.length - 1]));
  const espike = Array.from({ length: n }, () => Array.from({ length: n }, () => new Array(ns).fill(0.0)));
  for (let h = 0; h < n; h++) {
    let v = jump.slice();
    for (let t = h - 1; t >= 0; t--) { v = mv(ps[t + 1], v); espike[t][h] = v; }
  }
  const meanId = da.map((p, h) => p + edm[h] + ejm[h] - comp[h]);
  const nx = nd * ns;
  return {
    da: da.slice(), drift, pd, jump, ps, comp, cost: Math.max(cost, 0), edrift, espike, meanId, nx, ns, nd,
    price: (h, x) => da[h] + drift[Math.floor(x / ns)] + jump[x % ns] - comp[h],
    quote: (h, t, x) => da[h] + edrift[h - t][Math.floor(x / ns)] + espike[t][h][x % ns] - comp[h],
    start: () => { const d0 = pd[Math.floor(nd / 2)], s0 = ps[0][0]; return Array.from({ length: nx }, (_, x) => d0[Math.floor(x / ns)] * s0[x % ns]); },
  };
}

// ------------------------------------------------------------------ the battery
// `fee`: EUR per MWh drawn from the grid to charge (a grid tariff), paid on the physical schedule.
export function battery({ hours = 2, roundTrip = 0.85, cycles = 2, fee = 0.0 } = {}) {
  const E = hours, cap = Math.round(cycles * hours), s = Math.sqrt(roundTrip);
  const states = [];
  for (let soc = 0; soc <= E; soc++) for (let dis = 0; dis <= cap; dis++) states.push([soc, dis]);
  const idx = (soc, dis) => soc * (cap + 1) + dis;
  // for every state: its charge, its cycles used, and where charging or discharging leads (-1: not allowed)
  const socOf = Int32Array.from(states, (st) => st[0]), disOf = Int32Array.from(states, (st) => st[1]);
  const up = Int32Array.from(states, ([soc, dis]) => (soc < E ? idx(soc + 1, dis) : -1));
  const down = Int32Array.from(states, ([soc, dis]) => (soc > 0 && dis < cap ? idx(soc - 1, dis + 1) : -1));
  return {
    hours: E, cap, s, fee, states, idx, socOf, disOf, up, down,
    ok: (n, h, soc, dis) => soc <= n - h && soc + dis <= cap && (h < n || soc === 0),
    grid: (a) => (a === DISCHARGE ? s : a === CHARGE ? -1 / s : 0.0),
    imports: (a) => (a === CHARGE ? 1 / s : 0.0),       // MWh drawn from the grid, which pay the fee
    moves: (soc, dis) => {
      const out = [[IDLE, soc, dis]];
      if (soc < E) out.push([CHARGE, soc + 1, dis]);
      if (soc > 0 && dis < cap) out.push([DISCHARGE, soc - 1, dis + 1]);
      return out;
    },
  };
}
const step = (a, soc, dis) => (a === CHARGE ? [soc + 1, dis] : a === DISCHARGE ? [soc - 1, dis + 1] : [soc, dis]);

// The first action in preference order (idle, charge, discharge) unless a later one is better by more
// than the tolerance, so a near tie goes the same way as in Python.
export function pick(cands) {
  let bestA = -1, bestV = NEG;
  for (const [a, v] of cands) {
    if (v === NEG) continue;
    if (bestA < 0 || v > bestV + TOL * Math.max(1.0, Math.abs(bestV))) { bestA = a; bestV = v; }
  }
  return [bestA, bestV];
}
// An hour's cash: grid MWh at price p, less the grid fee on charging, less trading costs on the change from `ref`.
const reward = (b, a, p, ref, cost) => { const g = b.grid(a), v = g * p - b.fee * b.imports(a); return ref == null ? v : v - cost * Math.abs(g - ref); };

// pick() over idle, charge and discharge without building arrays: values to go (NEG: not allowed)
// plus this hour's rewards. Returns the action; the chosen value is left in `chosen`.
let chosen = NEG;
function choose(vi, ri, vc, rc, vd, rd) {
  let a = -1, best = NEG;
  if (vi !== NEG) { a = IDLE; best = vi + ri; }
  if (vc !== NEG) { const v = vc + rc; if (a < 0 || v > best + TOL * Math.max(1.0, Math.abs(best))) { a = CHARGE; best = v; } }
  if (vd !== NEG) { const v = vd + rd; if (a < 0 || v > best + TOL * Math.max(1.0, Math.abs(best))) { a = DISCHARGE; best = v; } }
  chosen = best;
  return a;
}
const rw = new Float64Array(3);   // this hour's rewards of idle, charge, discharge
function rewards(b, p, ref, cost) {
  for (let a = 0; a < 3; a++) rw[a] = reward(b, a, p, ref, cost);
}

let pool = [];                     // value rows, reused from one plan to the next
function rows(count, size) {
  while (pool.length < count) pool.push(new Float64Array(0));
  for (let r = 0; r < count; r++) if (pool[r].length !== size) pool[r] = new Float64Array(size);
  return pool;
}

// Values to go of known prices q from hour h0 to the end of the day; changes from `ref` cost `cost`.
// The rows are reused by the next call: read them before planning again.
export function plan(q, b, h0 = 0, ref = null, cost = 0.0) {
  const n = q.length, S = b.states.length, { socOf, disOf, up, down, cap } = b;
  const V = rows(n - h0 + 1, S);
  for (let r = 0; r <= n - h0; r++) V[r].fill(NEG);
  for (let si = 0; si < S; si++) if (socOf[si] === 0) V[n - h0][si] = 0.0;
  for (let h = n - 1; h >= h0; h--) {
    const nxt = V[h + 1 - h0], cur = V[h - h0];
    rewards(b, q[h], ref == null ? null : ref[h], cost);
    for (let si = 0; si < S; si++) {
      const soc = socOf[si];
      if (!(soc <= n - h && soc + disOf[si] <= cap)) continue;
      choose(nxt[si], rw[0], up[si] >= 0 ? nxt[up[si]] : NEG, rw[1], down[si] >= 0 ? nxt[down[si]] : NEG, rw[2]);
      cur[si] = chosen;
    }
  }
  return V;
}

// The best actions on known prices from hour h0 and a battery state.
export function bestPath(q, b, h0 = 0, soc = 0, dis = 0, ref = null, cost = 0.0) {
  const V = plan(q, b, h0, ref, cost), { up, down } = b, out = [];
  let si = b.idx(soc, dis);
  for (let h = h0; h < q.length; h++) {
    const nxt = V[h + 1 - h0];
    rewards(b, q[h], ref == null ? null : ref[h], cost);
    const a = choose(nxt[si], rw[0], up[si] >= 0 ? nxt[up[si]] : NEG, rw[1], down[si] >= 0 ? nxt[down[si]] : NEG, rw[2]);
    out.push(a);
    si = a === CHARGE ? up[si] : a === DISCHARGE ? down[si] : si;
  }
  return out;
}

// ------------------------------------------------------------------ the policies
// Trading each hour at its close, optimally: [actions[h][state][x], expected intraday reward].
export function patient(w, b, ref) {
  const n = w.da.length, { nd, ns, nx } = w, S = b.states.length, { socOf, disOf, up, down, cap } = b;
  let V = b.states.map(([soc]) => new Float64Array(nx).fill(soc === 0 ? 0.0 : NEG));
  const acts = new Array(n), u = new Float64Array(nd * ns);
  for (let h = n - 1; h >= 0; h--) {
    const trans = h + 1 < n ? w.ps[h + 1] : null;
    const C = V.map((vals) => {
      if (vals[0] === NEG || trans === null) return vals;
      for (let j = 0; j < nd; j++) for (let k = 0; k < ns; k++) {
        let t = 0; const tk = trans[k];
        for (let l = 0; l < ns; l++) t += tk[l] * vals[j * ns + l];
        u[j * ns + k] = t;
      }
      const out = new Float64Array(nx);
      for (let i = 0; i < nd; i++) {
        const pi = w.pd[i];
        for (let k = 0; k < ns; k++) { let t = 0; for (let j = 0; j < nd; j++) t += pi[j] * u[j * ns + k]; out[i * ns + k] = t; }
      }
      return out;
    });
    const A = new Array(S), Vh = new Array(S), r = ref[h];
    for (let si = 0; si < S; si++) {
      A[si] = new Int8Array(nx);
      Vh[si] = new Float64Array(nx).fill(NEG);
      const soc = socOf[si];
      if (!(soc <= n - h && soc + disOf[si] <= cap)) continue;
      const ci = C[si], cu = up[si] >= 0 ? C[up[si]] : null, cd = down[si] >= 0 ? C[down[si]] : null;
      for (let x = 0; x < nx; x++) {
        rewards(b, w.price(h, x), r, w.cost);
        A[si][x] = choose(ci[x], rw[0], cu ? cu[x] : NEG, rw[1], cd ? cd[x] : NEG, rw[2]);
        Vh[si][x] = chosen;
      }
    }
    acts[h] = A; V = Vh;
  }
  const st = w.start(), v0 = V[b.idx(0, 0)];
  let total = 0;
  for (let x = 0; x < nx; x++) total += st[x] * v0[x];
  return [acts, total];
}

// The rolling LP on one day's states: [intraday cash after trading costs and the change in grid fees
// from the day-ahead schedule's, MWh traded, actions].
export function rollingDay(w, b, xs, daActs) {
  const n = w.da.length, pos = daActs.slice(), q = new Float64Array(n);
  let cash = 0.0, traded = 0.0, soc = 0, dis = 0;
  for (let t = 0; t < n; t++) {
    q[t] = w.price(t, xs[t]);
    for (let h = t + 1; h < n; h++) q[h] = w.quote(h, t, xs[t]);
    const nw = bestPath(q, b, t, soc, dis);
    const d = [];
    for (let h = t; h < n; h++) d.push(b.grid(nw[h - t]) - b.grid(pos[h]));
    let vol = 0; for (const v of d) vol += Math.abs(v);
    let more = 0; for (let h = t; h < n; h++) more += b.imports(nw[h - t]) - b.imports(pos[h]);   // MWh charged, new plan over old
    let g = 0; for (let j = 0; j < d.length; j++) g += d[j] * q[t + j];
    const gain = g - w.cost * vol - b.fee * more;
    if (gain > 1e-9) { cash += gain; traded += vol; for (let h = t; h < n; h++) pos[h] = nw[h - t]; }
    [soc, dis] = step(pos[t], soc, dis);
  }
  return [cash, traded, pos];
}

function pct(xs, q) {
  const s = xs.slice().sort((a, b) => a - b), pos = q * (s.length - 1), lo = Math.floor(pos), hi = Math.min(lo + 1, s.length - 1);
  return s[lo] + (s[hi] - s[lo]) * (pos - lo);
}

// The four policies on the same simulated days (EUR per MW). Each settles its day-ahead schedule at
// day-ahead prices and every change at intraday prices, less trading costs, and pays the grid fee on
// what it ends up charging. `pat` reuses a solved patient policy for the same world and battery.
export function simulate(w, b, { days = 1000, seed = 7, pat = null } = {}) {
  const n = w.da.length, { ns, nd } = w;
  const daActs = bestPath(w.da, b), ref = daActs.map((a) => b.grid(a));
  let daCash = 0; for (let h = 0; h < n; h++) daCash += ref[h] * w.da[h];
  let daImp = 0; for (const a of daActs) daImp += b.imports(a);
  const daVal = daCash - b.fee * daImp;                                 // the day-ahead schedule's grid fees
  const [patActs, patReward] = pat || patient(w, b, ref);
  const rnd = rng(seed);
  const pl = Object.fromEntries(POLICIES.map((k) => [k, []])), vol = Object.fromEntries(POLICIES.map((k) => [k, []]));
  let bestGap = NEG, example = null;
  for (let day = 0; day < days; day++) {
    let i = Math.floor(nd / 2), k = 0;
    const xs = [];
    for (let h = 0; h < n; h++) { i = draw(w.pd[i], rnd()); k = draw(w.ps[h][k], rnd()); xs.push(i * ns + k); }
    const ida = xs.map((x, h) => w.price(h, x));
    const acts = { day_ahead: daActs };
    const [cash, traded, rollActs] = rollingDay(w, b, xs, daActs);
    acts.rolling = rollActs;
    let soc = 0, dis = 0;
    acts.patient = xs.map((x, h) => { const a = patActs[h][b.idx(soc, dis)][x]; [soc, dis] = step(a, soc, dis); return a; });
    acts.oracle = bestPath(ida, b, 0, 0, 0, ref, w.cost);
    const vals = { day_ahead: daVal, rolling: daVal + cash };
    vol.day_ahead.push(0.0); vol.rolling.push(traded);
    for (const name of ["patient", "oracle"]) {
      let c = 0, t = 0;
      acts[name].forEach((a, h) => { const d = b.grid(a) - ref[h]; c += d * ida[h] - w.cost * Math.abs(d) - b.fee * b.imports(a); t += Math.abs(d); });
      vals[name] = daCash + c; vol[name].push(t);
    }
    for (const name of POLICIES) pl[name].push(vals[name]);
    const gap = vals.patient - vals.rolling;
    if (gap > bestGap + 1e-9) { bestGap = gap; example = { intraday: ida, spike: xs.map((x) => w.jump[x % ns]), actions: acts, values: vals }; }
  }
  const out = {};
  for (const name of POLICIES) {
    const xs = pl[name], m = sum(xs) / xs.length;
    let ss = 0; for (const v of xs) ss += (v - m) * (v - m);
    const sd = xs.length > 1 ? Math.sqrt(ss / (xs.length - 1)) : 0.0;
    out[name] = { mean: m, se: sd / Math.sqrt(xs.length), p10: pct(xs, 0.1), p90: pct(xs, 0.9), traded: sum(vol[name]) / vol[name].length };
  }
  let exp = 0; for (let h = 0; h < n; h++) exp += ref[h] * w.meanId[h];
  out.day_ahead.expected = daVal;
  out.patient.expected = daCash - exp + patReward;          // the programme's reward already carries its fees
  out.rolling.expected = out.rolling.mean;
  out.oracle.expected = out.oracle.mean;
  return { policies: out, days, example, dayAheadActions: daActs };
}

// Each policy's value as spikes get more frequent, everything else as set.
export function sweep(da, b, { perDays = [0, 0.5, 1, 2, 3, 4], days = 300, seed = 7, ...worldOpts } = {}) {
  return perDays.map((f) => {
    const r = simulate(world(da, { ...worldOpts, perDay: f }), b, { days, seed });
    return { per_day: f, ...Object.fromEntries(POLICIES.map((k) => [k, r.policies[k].expected])) };
  });
}
