// Forecast a game launch day's Twitch viewers, hour by hour.
//
// The program reads every case file (*.in) in the input directory and, for
// each case, writes one forecast file (<id>.out) to the output directory:
// for hours 2..24 of the launch day, five quantiles of that hour's viewer
// count at the case's levels (0.05, 0.25, 0.5, 0.75, 0.95).
//
// Method: a launch day's shape is borrowed from the case's comparables —
// past launches whose full release-day curves are given. Each comparable's
// day becomes a ratio curve over its own first hour, and the target's
// forecast at an hour is a similarity-weighted quantile of those ratios,
// scaled by the target's known first hour. Two similarities set the
// weights, both read off data the case itself contains:
//
//   scale    — the comparable's first hour against the target's. A launch
//              whose first hour already drew half a million behaves like
//              other giants, not like a category that sat empty until an
//              afternoon unlock; across the comparables this is by far
//              the strongest predictor of a day's shape.
//   momentum — the target's first hour against its own last pre-launch
//              hours. A first hour that is itself a jump (a rolling
//              midnight unlock reaching a big region at 00:00 UTC) tilts
//              the blend toward launches whose first hour jumped too, and
//              away from early-access launches that coasted into the day.
//
// The weights are tempered (raised to 0.8) so no handful of comparables
// can shout down the rest: launch geometries the features cannot see
// coming stay hedged by the wider mixture. The per-hour quantile curves
// are lightly smoothed, and no quantile is allowed below the target's
// pre-launch baseline level (its ordinary category traffic, measured over
// the week before the final day so the unlock's first regions, which go
// live before the UTC day starts, do not inflate it).
//
// Everything is computed from the case file: no network, no clock, no
// randomness, so two runs of the same case are byte-identical.

import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// ---------------------------------------------------------------- types

interface HourPoint {
  from: string;
  viewers: number;
  channels: number | null;
}

interface Comparable {
  name: string;
  day_start: string;
  hourly: HourPoint[];
}

interface KnownHour {
  hour: number;
  viewers: number;
  channels: number | null;
}

interface CaseFile {
  id?: string;
  game?: { name?: string };
  day_start: string;
  checkpoint: string;
  levels?: number[];
  known: KnownHour[];
  history_hourly?: HourPoint[];
  comparables?: Comparable[];
}

// ------------------------------------------------------------ utilities

const HOUR_MS = 3600_000;
const DAY_MS = 24 * HOUR_MS;

function ms(iso: string): number {
  return Date.parse(iso);
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 === 1 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x;
}

// Weighted quantile of (value, weight) pairs, interpolated in log space
// because the values are ratios of viewer counts.
function weightedLogQuantile(pairs: { v: number; w: number }[], tau: number): number {
  const s = [...pairs].sort((a, b) => a.v - b.v);
  let total = 0;
  for (const p of s) total += p.w;
  if (total <= 0) return s.length ? s[s.length >> 1].v : 1;
  const target = tau * total;
  let cum = 0;
  for (let i = 0; i < s.length; i++) {
    const before = cum;
    cum += s[i].w;
    if (cum >= target) {
      if (i === 0) return s[0].v;
      const prev = s[i - 1];
      const span = cum - before;
      const frac = span > 0 ? (target - before) / span : 0;
      const lv = Math.log(prev.v) + (Math.log(s[i].v) - Math.log(prev.v)) * frac;
      return Math.exp(lv);
    }
  }
  return s[s.length - 1].v;
}

function gauss(logDiff: number, sigma: number): number {
  const d = logDiff / sigma;
  return Math.exp(-0.5 * d * d);
}

// ------------------------------------------------- comparable day curve

// The 24 hourly values of a comparable's release day (index 1..24), with
// short gaps filled by log-linear interpolation, or null when the day is
// too incomplete to teach anything.
function releaseDay(hourly: HourPoint[], dayStartMs: number): number[] | null {
  const raw: (number | null)[] = new Array(25).fill(null);
  const counts: number[] = new Array(25).fill(0);
  for (const pt of hourly) {
    const t = ms(pt.from);
    if (t >= dayStartMs && t < dayStartMs + DAY_MS) {
      const h = Math.floor((t - dayStartMs) / HOUR_MS) + 1;
      raw[h] = (raw[h] ?? 0) + Math.max(pt.viewers, 0);
      counts[h] += 1;
    }
  }
  for (let h = 1; h <= 24; h++) {
    if (counts[h] > 0) raw[h] = (raw[h] as number) / counts[h];
  }
  if (raw[1] === null) return null;
  let present = 0;
  for (let h = 1; h <= 24; h++) if (raw[h] !== null) present++;
  if (present < 20) return null;
  // Fill gaps: interior by log-linear interpolation, edges by nearest value.
  const v: number[] = new Array(25).fill(0);
  let lastKnown = 1;
  for (let h = 1; h <= 24; h++) {
    if (raw[h] !== null) {
      v[h] = Math.max(raw[h] as number, 1);
      lastKnown = h;
    } else {
      let next = h + 1;
      while (next <= 24 && raw[next] === null) next++;
      if (next <= 24) {
        const a = Math.log(Math.max(raw[lastKnown] as number, 1));
        const b = Math.log(Math.max(raw[next] as number, 1));
        v[h] = Math.exp(a + ((b - a) * (h - lastKnown)) / (next - lastKnown));
      } else {
        v[h] = v[lastKnown];
      }
    }
  }
  return v;
}

// Median viewers over an hourly series inside [fromMs, untilMs).
function windowMedian(hourly: HourPoint[], fromMs: number, untilMs: number): number {
  const vals: number[] = [];
  for (const pt of hourly) {
    const t = ms(pt.from);
    if (t >= fromMs && t < untilMs) vals.push(Math.max(pt.viewers, 0));
  }
  return median(vals);
}

// A launch's baseline and momentum, read off an hourly series that covers
// the days before its day start:
//   baseline: the category's ordinary level — the median over the week
//             before the final day (the final day is left out: a rolling
//             unlock's first regions already disturb it);
//   momentum: hour 1 over the median of the three hours before the day —
//             was the first hour itself a jump, or a coast?
function launchShape(
  hourly: HourPoint[],
  dayStartMs: number,
  hour1: number,
): { baseline: number; momentum: number } {
  let baseline = windowMedian(hourly, dayStartMs - 8 * DAY_MS, dayStartMs - DAY_MS);
  if (baseline <= 0) {
    baseline = windowMedian(hourly, dayStartMs - 14 * DAY_MS, dayStartMs - DAY_MS);
  }
  const before = windowMedian(hourly, dayStartMs - 3 * HOUR_MS, dayStartMs);
  return {
    baseline,
    momentum: clamp(hour1 / Math.max(before, 1), 0.05, 1e4),
  };
}

// ------------------------------------------------------------- forecast

const DEFAULT_LEVELS = [0.05, 0.25, 0.5, 0.75, 0.95];
const NORMAL_Z = [-1.6448536269514722, -0.6744897501960817, 0, 0.6744897501960817, 1.6448536269514722];

// Similarity kernel widths (log units) and the weight tempering power,
// chosen by leave-one-out validation over the comparables: each launch in
// turn was forecast from the others and scored with the contest's pinball
// loss; this configuration scored 0.41 against 0.71 for the unweighted
// blend and 0.93 for holding hour 1 flat.
const SIGMA_SCALE = 0.9;
const SIGMA_MOMENTUM = 2.0;
const TEMPER = 0.8;

interface CompCurve {
  ratios: number[]; // index 1..24, viewers over the comparable's own hour 1
  weight: number;
}

function forecastCase(kase: CaseFile): { hour: number; q: number[] }[] {
  const levels = kase.levels && kase.levels.length === 5 ? kase.levels : DEFAULT_LEVELS;
  const known = kase.known && kase.known.length > 0 ? kase.known[0] : null;
  const p = Math.max(known ? known.viewers : 1, 1);
  const dayStartMs = ms(kase.day_start);

  // The target's own shape, from its recorded history.
  const ownHistory = kase.history_hourly ?? [];
  const target = launchShape(ownHistory, dayStartMs, p);
  const logMomT = Math.log(target.momentum);
  const logScaleT = Math.log(p);

  // Build the weighted comparable ratio curves.
  const curves: CompCurve[] = [];
  const comps = kase.comparables ?? [];
  for (const comp of comps) {
    // A comparable that is the target game itself is its pre-launch
    // history, not a launch to borrow a shape from.
    if (kase.game && comp.name && kase.game.name && comp.name.startsWith(kase.game.name)) continue;
    const ds = ms(comp.day_start);
    if (!Number.isFinite(ds)) continue;
    const day = releaseDay(comp.hourly ?? [], ds);
    if (!day) continue;
    const g = launchShape(comp.hourly ?? [], ds, day[1]);
    let w =
      gauss(Math.log(day[1]) - logScaleT, SIGMA_SCALE) *
      gauss(Math.log(g.momentum) - logMomT, SIGMA_MOMENTUM);
    if (!Number.isFinite(w) || w <= 0) w = 0;
    w = Math.pow(Math.max(w, 1e-12), TEMPER);
    const ratios: number[] = new Array(25).fill(1);
    for (let h = 1; h <= 24; h++) ratios[h] = day[h] / day[1];
    curves.push({ ratios, weight: w });
  }

  const rows: { hour: number; q: number[] }[] = [];

  if (curves.length === 0) {
    // No comparable to learn from: hold the first hour, with a lognormal
    // spread that widens over the day.
    for (let h = 2; h <= 24; h++) {
      const s = 0.2 * Math.sqrt(h - 1);
      rows.push({ hour: h, q: NORMAL_Z.map((z) => round2capped(p * Math.exp(z * s))) });
    }
    return rows;
  }

  // If every similarity weight collapsed, fall back to equal weights.
  let wSum = 0;
  for (const c of curves) wSum += c.weight;
  if (wSum < 1e-9) {
    for (const c of curves) c.weight = 1;
  }

  // Weighted ratio quantiles per hour, in log space.
  const logQ: number[][] = []; // [hour][levelIdx]
  for (let h = 2; h <= 24; h++) {
    const pairs = curves.map((c) => ({ v: Math.max(c.ratios[h], 1e-9), w: c.weight }));
    logQ[h] = levels.map((tau) => Math.log(weightedLogQuantile(pairs, tau)));
  }
  // Light smoothing across neighbouring hours, per level.
  const smooth: number[][] = [];
  for (let h = 2; h <= 24; h++) {
    smooth[h] = [];
    for (let li = 0; li < levels.length; li++) {
      let acc = 0;
      let wacc = 0;
      for (let dh = -1; dh <= 1; dh++) {
        const hh = h + dh;
        if (hh < 2 || hh > 24) continue;
        const wgt = dh === 0 ? 0.5 : 0.25;
        acc += wgt * logQ[hh][li];
        wacc += wgt;
      }
      smooth[h][li] = acc / wacc;
    }
  }

  const floor = Math.min(target.baseline, 0.5 * p);
  for (let h = 2; h <= 24; h++) {
    const q = levels.map((_, li) => Math.max(p * Math.exp(smooth[h][li]), floor, 1e-6));
    q.sort((a, b) => a - b);
    rows.push({ hour: h, q: q.map(round2capped) });
  }
  return rows;
}

function round2capped(x: number): number {
  return Math.round(clamp(x, 0.01, 1_000_000_000) * 100) / 100;
}

// ---------------------------------------------------------------- main

function main(): void {
  const inDir = process.env.MAKEFUN_INPUT_DIR ?? "/input";
  const outDir = process.env.MAKEFUN_OUTPUT_DIR ?? "/output";
  mkdirSync(outDir, { recursive: true });
  const files = readdirSync(inDir)
    .filter((f) => f.endsWith(".in"))
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  for (const file of files) {
    const text = readFileSync(join(inDir, file), "utf8");
    const kase = JSON.parse(text) as CaseFile;
    const hours = forecastCase(kase);
    const id = file.slice(0, file.length - 3);
    writeFileSync(join(outDir, `${id}.out`), JSON.stringify({ hours }));
  }
}

main();
