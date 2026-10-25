// options.js — option pricing for the Options tab.
// A port of PowerDesk's powerdesk/options.py (the reference); tests/options.test.mjs checks
// the closed forms agree with it to 1e-9 and the Monte Carlo agrees statistically.
// Everything is priced on futures (no carry). Vols are annualised, times in years.

export const CALL = "call", PUT = "put";
const SQRT2PI = Math.sqrt(2 * Math.PI);

// Cumulative normal, double precision (Hart 1968, as given by West 2005).
export function N(x) {
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
export const npdf = (x) => Math.exp(-x * x / 2) / SQRT2PI;

function sign(kind) {
  if (kind !== CALL && kind !== PUT) throw new Error(`kind must be "call" or "put", not ${kind}`);
  return kind === CALL ? 1 : -1;
}

// ------------------------------------------------------------------ Black-76
export function black76Greeks(F, K, T, sigma, r = 0, kind = CALL) {
  const w = sign(kind), D = Math.exp(-r * T);
  if (!(F > 0)) throw new Error("Black-76 needs a positive future price; use Bachelier for spreads");
  if (T <= 0 || sigma <= 0 || K <= 0) {
    const intrinsic = Math.max(w * (F - K), 0);
    return { price: D * intrinsic, delta: w * (F - K) > 0 ? D * w : 0, gamma: 0, vega: 0, theta: r * D * intrinsic };
  }
  const sd = sigma * Math.sqrt(T);
  const d1 = (Math.log(F / K) + 0.5 * sd * sd) / sd, d2 = d1 - sd;
  const price = D * w * (F * N(w * d1) - K * N(w * d2));
  return {
    price,
    delta: D * w * N(w * d1),
    gamma: D * npdf(d1) / (F * sd),
    vega: D * F * npdf(d1) * Math.sqrt(T),
    theta: -D * F * npdf(d1) * sigma / (2 * Math.sqrt(T)) + r * price,
  };
}
export const black76 = (F, K, T, sigma, r = 0, kind = CALL) => black76Greeks(F, K, T, sigma, r, kind).price;

// ------------------------------------------------------------------ Bachelier (normal vol in EUR/MWh)
export function bachelierGreeks(F, K, T, sigmaN, r = 0, kind = CALL) {
  const w = sign(kind), D = Math.exp(-r * T);
  if (T <= 0 || sigmaN <= 0) {
    const intrinsic = Math.max(w * (F - K), 0);
    return { price: D * intrinsic, delta: w * (F - K) > 0 ? D * w : 0, gamma: 0, vega: 0, theta: r * D * intrinsic };
  }
  const sd = sigmaN * Math.sqrt(T), d = (F - K) / sd;
  const price = D * (w * (F - K) * N(w * d) + sd * npdf(d));
  return {
    price, delta: D * w * N(w * d), gamma: D * npdf(d) / sd, vega: D * Math.sqrt(T) * npdf(d),
    theta: -D * sigmaN * npdf(d) / (2 * Math.sqrt(T)) + r * price,
  };
}
export const bachelier = (F, K, T, s, r = 0, kind = CALL) => bachelierGreeks(F, K, T, s, r, kind).price;

// ------------------------------------------------------------------ implied volatility (bisection: slow, never fails)
function solveVol(priceOf, target, lo, hi, tol = 1e-12) {
  if (!(priceOf(lo) <= target && target <= priceOf(hi))) throw new Error("No volatility gives that price: it's below intrinsic value or above the maximum.");
  for (let i = 0; i < 200; i++) {
    const mid = 0.5 * (lo + hi);
    if (priceOf(mid) < target) lo = mid; else hi = mid;
    if (hi - lo < tol * Math.max(1, mid)) break;
  }
  return 0.5 * (lo + hi);
}
export const black76Iv = (price, F, K, T, r = 0, kind = CALL) => solveVol((s) => black76(F, K, T, s, r, kind), price, 1e-9, 20);
export const bachelierIv = (price, F, K, T, r = 0, kind = CALL) =>
  solveVol((s) => bachelier(F, K, T, s, r, kind), price, 1e-12, 10 * Math.max(Math.abs(F), Math.abs(K), 1) / Math.sqrt(Math.max(T, 1e-12)));

// ------------------------------------------------------------------ spread options
export function kirkVol(F2, K, sigma1, sigma2, rho) {
  const a = F2 + K;
  if (!(a > 0)) throw new Error("Kirk needs F2 + K > 0");
  const b = F2 / a;
  return Math.sqrt(Math.max(sigma1 ** 2 - 2 * rho * sigma1 * sigma2 * b + (sigma2 * b) ** 2, 0));
}
export function kirk(F1, F2, K, T, sigma1, sigma2, rho, r = 0, kind = CALL) {
  const w = sign(kind), D = Math.exp(-r * T);
  const call = black76(F1, F2 + K, T, kirkVol(F2, K, sigma1, sigma2, rho), r, CALL);
  return w === 1 ? call : call - D * (F1 - F2 - K);
}
export const margrabe = (F1, F2, T, s1, s2, rho, r = 0) => black76(F1, F2, T, Math.sqrt(s1 * s1 - 2 * rho * s1 * s2 + s2 * s2), r, CALL);

// ------------------------------------------------------------------ random numbers (seeded, so results repeat)
export function rng(seed = 1) {
  let a = seed >>> 0 || 1;
  const u = () => { // mulberry32
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  let spare = null;
  return () => { // standard normals, Marsaglia polar method
    if (spare !== null) { const s = spare; spare = null; return s; }
    let x, y, s;
    do { x = 2 * u() - 1; y = 2 * u() - 1; s = x * x + y * y; } while (s >= 1 || s === 0);
    const m = Math.sqrt(-2 * Math.log(s) / s);
    spare = y * m;
    return x * m;
  };
}
function meanSe(xs) {
  const n = xs.length;
  let m = 0;
  for (const x of xs) m += x;
  m /= n;
  let v = 0;
  for (const x of xs) v += (x - m) * (x - m);
  return { mean: m, se: Math.sqrt(v / (n - 1) / n) };
}

export function spreadMc(F1, F2, K, T, s1, s2, rho, r = 0, kind = CALL, paths = 100000, seed = 1) {
  const w = sign(kind), D = Math.exp(-r * T), z = rng(seed), sq = Math.sqrt(T), c = Math.sqrt(1 - rho * rho);
  const pay = new Float64Array(paths);
  for (let i = 0; i < paths; i++) {
    const z1 = z(), z2 = rho * z1 + c * z();
    const f1 = F1 * Math.exp(-0.5 * s1 * s1 * T + s1 * sq * z1), f2 = F2 * Math.exp(-0.5 * s2 * s2 * T + s2 * sq * z2);
    pay[i] = D * Math.max(w * (f1 - f2 - K), 0);
  }
  const { mean, se } = meanSe(pay);
  return { price: mean, stderr: se };
}

// ------------------------------------------------------------------ Asian (average-price) options
// Fixings: forwards F[i] and the covariance C[i][j] of the log fixings.
export const gbmCov = (times, sigma) => times.map((a) => times.map((b) => sigma * sigma * Math.min(a, b)));

export function asianGeometric(F, C, K, T, r = 0, kind = CALL) {
  const w = sign(kind), D = Math.exp(-r * T), n = F.length;
  let mu = 0, v = 0;
  for (let i = 0; i < n; i++) { mu += Math.log(F[i]) - 0.5 * C[i][i]; for (let j = 0; j < n; j++) v += C[i][j]; }
  mu /= n; v /= n * n;
  const mean = Math.exp(mu + 0.5 * v);
  if (v <= 0) return D * Math.max(w * (mean - K), 0);
  const sd = Math.sqrt(v), d1 = (mu + v - Math.log(K)) / sd;
  return D * w * (mean * N(w * d1) - K * N(w * (d1 - sd)));
}

// Mean and log-variance of the lognormal with the average's first two moments.
export function lognormalFit(F, C, weights = null) {
  const n = F.length, wt = weights || F.map(() => 1 / n);
  let m1 = 0, m2 = 0;
  for (let i = 0; i < n; i++) {
    m1 += wt[i] * F[i];
    for (let j = 0; j < n; j++) m2 += wt[i] * wt[j] * F[i] * F[j] * Math.exp(C[i][j]);
  }
  return { mean: m1, v: Math.log(m2 / (m1 * m1)) };
}

export function asianMm(F, C, K, T, r = 0, kind = CALL, weights = null, fixed = 0) {
  const w = sign(kind), D = Math.exp(-r * T);
  const { mean: m1, v } = lognormalFit(F, C, weights);
  const k = K - fixed;
  if (k <= 0) return w === 1 ? D * Math.max(m1 - k, 0) : 0;
  if (v <= 0) return D * Math.max(w * (m1 - k), 0);
  const sd = Math.sqrt(v), d1 = (Math.log(m1 / k) + 0.5 * v) / sd;
  return D * w * (m1 * N(w * d1) - k * N(w * (d1 - sd)));
}

function cholesky(C) {
  const n = C.length, L = Array.from({ length: n }, () => new Float64Array(n));
  for (let i = 0; i < n; i++) {
    for (let j = 0; j <= i; j++) {
      let s = C[i][j] + (i === j ? 1e-14 : 0);
      for (let k = 0; k < j; k++) s -= L[i][k] * L[j][k];
      L[i][j] = i === j ? Math.sqrt(Math.max(s, 0)) : (L[j][j] > 0 ? s / L[j][j] : 0);
    }
  }
  return L;
}

// Monte Carlo on equally weighted fixings, antithetic, with the geometric Asian as control variate.
export function asianMc(F, C, K, T, r = 0, kind = CALL, paths = 20000, seed = 1) {
  const w = sign(kind), D = Math.exp(-r * T), n = F.length, L = cholesky(C), z = rng(seed);
  const mu = F.map((f, i) => Math.log(f) - 0.5 * C[i][i]);
  const half = Math.floor(paths / 2);
  const pa = new Float64Array(2 * half), pg = new Float64Array(2 * half);
  const e = new Float64Array(n), x = new Float64Array(n);
  for (let p = 0; p < half; p++) {
    for (let i = 0; i < n; i++) e[i] = z();
    for (let sgn = 1, rep = 0; rep < 2; rep++, sgn = -1) {
      let sumA = 0, sumL = 0;
      for (let i = 0; i < n; i++) {
        let s = 0;
        const Li = L[i];
        for (let k = 0; k <= i; k++) s += Li[k] * e[k];
        x[i] = mu[i] + sgn * s;
        sumA += Math.exp(x[i]);
        sumL += x[i];
      }
      pa[2 * p + rep] = D * Math.max(w * (sumA / n - K), 0);
      pg[2 * p + rep] = D * Math.max(w * (Math.exp(sumL / n) - K), 0);
    }
  }
  const exactG = asianGeometric(F, C, K, T, r, kind);
  // beta = cov(pa, pg) / var(pg)
  const m = 2 * half;
  let ma = 0, mg = 0;
  for (let i = 0; i < m; i++) { ma += pa[i]; mg += pg[i]; }
  ma /= m; mg /= m;
  let cov = 0, vg = 0;
  for (let i = 0; i < m; i++) { cov += (pa[i] - ma) * (pg[i] - mg); vg += (pg[i] - mg) ** 2; }
  const beta = vg > 0 ? cov / vg : 0;
  // standard errors from antithetic pairs, which are the independent draws
  const plainPairs = new Float64Array(half), adjPairs = new Float64Array(half);
  for (let p = 0; p < half; p++) {
    const a0 = pa[2 * p], a1 = pa[2 * p + 1], g0 = pg[2 * p], g1 = pg[2 * p + 1];
    plainPairs[p] = 0.5 * (a0 + a1);
    adjPairs[p] = 0.5 * (a0 - beta * (g0 - exactG) + a1 - beta * (g1 - exactG));
  }
  const plain = meanSe(plainPairs), adj = meanSe(adjPairs);
  return { price: adj.mean, stderr: adj.se, plain: plain.mean, plainStderr: plain.se };
}

// ------------------------------------------------------------------ a forward-curve model for power
// dF(t,T)/F = sigma_s exp(-kappa (T - t)) dW_s + sigma_l dW_l, corr rho (Clewlow & Strickland).
export class TwoFactor {
  constructor(sigmaS, kappa, sigmaL, rho = 0) { Object.assign(this, { sigmaS, kappa, sigmaL, rho }); }
  static fromHalfLife(sigmaS, halfLifeDays, sigmaL, rho = 0) { return new TwoFactor(sigmaS, Math.LN2 / (halfLifeDays / 365), sigmaL, rho); }
  forwardVol(ttd) {
    const s = this.sigmaS * Math.exp(-this.kappa * ttd), l = this.sigmaL;
    return Math.sqrt(s * s + l * l + 2 * this.rho * s * l);
  }
  static eInt(decay, length) { const x = decay * length; return x < 1e-12 ? length : -Math.expm1(-x) / decay; }
  logCov(tA, TA, tB, TB) {
    const m = Math.min(tA, tB);
    if (m <= 0) return 0;
    const k = this.kappa, ss = this.sigmaS, sl = this.sigmaL;
    const short = ss * ss * Math.exp(-k * (TA + TB - 2 * m)) * TwoFactor.eInt(2 * k, m);
    const cross = this.rho * ss * sl * (Math.exp(-k * (TA - m)) + Math.exp(-k * (TB - m))) * TwoFactor.eInt(k, m);
    return short + sl * sl * m + cross;
  }
  fixingCov(fixings) { return fixings.map((a) => fixings.map((b) => this.logCov(a, a, b, b))); }
  futureCov(expiry, deliveries) { return deliveries.map((a) => deliveries.map((b) => this.logCov(expiry, a, expiry, b))); }
}

// One delivery month priced two ways: a European on the month future (EEX style, expiring
// before delivery) and an Asian on the daily fixings.
export function monthOptions(model, F, K, start, days, expiry, r = 0, kind = CALL) {
  if (!(expiry > 0 && expiry <= start)) throw new Error("the European must expire by the start of delivery");
  const fwd = Array.isArray(F) ? F : Array(days).fill(F);
  if (fwd.length !== days) throw new Error("one forward per delivery day");
  const mids = Array.from({ length: days }, (_, d) => start + (d + 0.5) / 365);
  const Cf = model.futureCov(expiry, mids), Ca = model.fixingCov(mids);
  const { mean, v: vf } = lognormalFit(fwd, Cf), { v: va } = lognormalFit(fwd, Ca);
  const futureVol = Math.sqrt(vf / expiry), end = start + days / 365;
  return {
    european: black76(mean, K, expiry, futureVol, r, kind),
    asian: asianMm(fwd, Ca, K, end, r, kind),
    vFuture: vf, vAverage: va, futureVol, mean, fixingCov: Ca, forwards: fwd, end,
  };
}
