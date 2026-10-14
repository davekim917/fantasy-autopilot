#!/usr/bin/env bun
/**
 * Lineup decisions from the simulation's JOINT samples.
 *
 * P(win) is counted over paired draws of my lineup and my opponent's, so
 * QB<->WR stacks, RB<->game-script and cross-matchup effects are already in
 * the numbers. No rho matrix, no normal approximation.
 */
import {
  buildHistory, buildUsage, buildTeamProfiles, defenseAdj, simulate, players,
  weekly, schedule, seed, num, SLEEPER, scoreLine, linearScoring, type Usage, type Scoring,
} from './engine.ts';
import { oddsFor } from './odds.ts';

const N = Number(process.env.SIMS ?? 20000);
const SEASON = Number(process.env.SEASON ?? 2026), WEEK = Number(process.env.WEEK ?? 2);
/** From the 2025 backtest: how much of our own mean to trust vs the platform's. */
const W_OURS = Number(process.env.W_OURS ?? 0.4);
/** From the 2025 backtest: simulated marginals are too narrow by this factor. */
const WIDTH = Number(process.env.WIDTH ?? 1.24);

const OUT_STATUS = new Set(['Out', 'IR', 'PUP', 'Sus', 'NA', 'Doubtful']);
const PLATFORM_ONLY = new Set(['K', 'DEF', 'DST']);

async function http(url: string, init: any = {}): Promise<any> {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(90_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
  return res.json();
}
const ESPN_HEADERS = { 'x-fantasy-platform': 'espn-fantasy-web', 'x-fantasy-source': 'kona', accept: 'application/json' };
const ESPN_STAT_KEY: Record<number, string> = {
  3: 'pass_yd', 4: 'pass_td', 19: 'pass_2pt', 20: 'pass_int',
  24: 'rush_yd', 25: 'rush_td', 26: 'rush_2pt',
  42: 'rec_yd', 43: 'rec_td', 44: 'rec_2pt', 53: 'rec', 72: 'fum_lost',
};

const meta = await players();
const hist = await buildHistory([
  ...Array.from({ length: 18 }, (_, i) => ({ season: 2025, week: i + 1 })),
  { season: 2026, week: 1 },
]);
const usage = buildUsage(hist, meta, SEASON, WEEK);
const teamProf = buildTeamProfiles(hist, SEASON, WEEK);
const dAdj = defenseAdj(hist, SEASON, WEEK);
const sched = await schedule(SEASON);
const games = sched.filter((g: any) => g.week === WEEK).map((g: any) => ({ home: g.home, away: g.away }));
const liveStats = await weekly('stats', SEASON, WEEK);
const liveProj = await weekly('projections', SEASON, WEEK);
const odds = await oddsFor(SEASON, WEEK);

/** Whoever is not ruled out. Dirichlet redistributes an absent player's share. */
const active = new Set<string>();
for (const [pid, m] of Object.entries(meta) as [string, any][]) {
  if (!m.team) continue;
  if (m.injury_status && OUT_STATUS.has(m.injury_status)) continue;
  active.add(pid);
}

/** The platform's projection IN THIS LEAGUE'S SCORING: rescore its projected stat
 *  line, exactly as the league would. pts_ppr/pts_half_ppr are the wrong yardstick
 *  for a league with non-standard yardage values. K and D/ST have no stat line to
 *  rescore, so they keep the platform's own scored total. */
const platformPts = (pid: string, family: string, scoring?: Scoring) => {
  const line = (liveProj as any)[pid];
  if (!line) return 0;
  const pos = meta[pid]?.position;
  if (!scoring || PLATFORM_ONLY.has(pos)) return num(line[`pts_${family}`]);
  return scoreLine(line, scoring);
};
/** Points already banked, scored the same way. */
export const actualPts = (pid: string, family: string, scoring?: Scoring) => {
  const line = (liveStats as any)[pid];
  if (!line) return 0;
  const pos = meta[pid]?.position;
  if (!scoring || PLATFORM_ONLY.has(pos)) return num(line[`pts_${family}`]);
  return scoreLine(line, scoring);
};
const scoringFamily = (s: Scoring) => ((s.rec ?? 0) >= 0.75 ? 'ppr' : (s.rec ?? 0) >= 0.25 ? 'half_ppr' : 'std');

type Seat = { pid: string; name: string; pos: string; slot: string; locked: boolean; done: boolean; actual: number };

/** Which teams have already kicked off / finished this week. */
const kickedOff = new Set<string>();
for (const [pid, l] of Object.entries(liveStats) as [string, any][]) {
  if (num(l.gp) && meta[pid]?.team) kickedOff.add(meta[pid].team);
}

function runSim(scoring: Scoring, keep: Set<string>, fallbackFamily: string) {
  const fallback = new Map<string, { mu: number; sd: number }>();
  for (const pid of keep) {
    const pos = meta[pid]?.position;
    const mu = platformPts(pid, fallbackFamily, scoring);
    const sd = pos === 'K' ? 4.7 : PLATFORM_ONLY.has(pos) ? 5.6 : Math.max(3, 0.55 * mu + 2);
    fallback.set(pid, { mu, sd });
  }
  seed(20260920);
  return simulate({ usage, teamProf, defAdj: dAdj, games, scoring, keep, fallback, active, odds, n: N });
}

const mean = (a: Float64Array) => { let s = 0; for (const v of a) s += v; return s / a.length; };
const sdOf = (a: Float64Array, m: number) => { let s = 0; for (const v of a) s += (v - m) ** 2; return Math.sqrt(s / a.length); };

/** Re-centre on the blended mean and widen to the width the backtest says we need.
 *  Shape and cross-player correlation are preserved — only location and scale move. */
function calibrate(arr: Float64Array, pid: string, family: string, isModel: boolean, scoring?: Scoring): { arr: Float64Array; mu: number; plat: number } {
  const m = mean(arr);
  const plat = platformPts(pid, family, scoring);
  const target = isModel && plat > 0 ? W_OURS * m + (1 - W_OURS) * plat : m;
  const out = new Float64Array(arr.length);
  for (let i = 0; i < arr.length; i++) out[i] = Math.max(0, target + (arr[i] - m) * WIDTH);
  return { arr: out, mu: target, plat };
}

function winProb(mine: Float64Array[], opp: Float64Array[], bankMine = 0, bankOpp = 0): number {
  let w = 0;
  const n = mine[0]?.length ?? opp[0]?.length ?? 0;
  for (let i = 0; i < n; i++) {
    let a = bankMine, b = bankOpp;
    for (const s of mine) a += s[i];
    for (const s of opp) b += s[i];
    if (a > b) w++;
  }
  return n ? w / n : 0;
}

/** Hill-climb with restarts over legal seatings, maximising P(win) on the joint samples. */
function optimize(slots: { name: string; allows: (s: Seat) => boolean }[], start: (Seat | null)[], roster: Seat[], opp: Float64Array[], bankMine: number, bankOpp: number, S: Map<string, Float64Array>) {
  const banked = (l: (Seat | null)[]) => l.reduce((a, s) => a + (s?.done ? s.actual : 0), 0);
  const live = (l: (Seat | null)[]) => l.filter((s): s is Seat => !!s && !s.done).map((s) => S.get(s.pid)!).filter(Boolean);
  const wp = (l: (Seat | null)[]) => winProb(live(l), opp, bankMine + banked(l), bankOpp);
  const movable = (s: Seat) => !s.locked && !s.done;
  const has = (l: (Seat | null)[], s: Seat) => l.some((x) => x?.pid === s.pid);

  let best = [...start], bestWp = wp(start);
  const climb = (init: (Seat | null)[]) => {
    let cur = [...init], c = wp(cur);
    for (let pass = 0; pass < 10; pass++) {
      let improved = false;
      for (let i = 0; i < slots.length; i++) {
        if (cur[i] && !movable(cur[i]!)) continue;
        for (const cand of [...roster.filter((p) => !has(cur, p) && movable(p) && slots[i].allows(p)), null]) {
          if (!cand && cur[i]) continue;
          const t = [...cur]; t[i] = cand;
          const v = wp(t);
          if (v > c + 1e-9) { cur = t; c = v; improved = true; }
        }
        for (let j = i + 1; j < slots.length; j++) {
          const a = cur[i], b = cur[j];
          if (!a || !b || !movable(a) || !movable(b) || !slots[i].allows(b) || !slots[j].allows(a)) continue;
          const t = [...cur]; t[i] = b; t[j] = a;
          const v = wp(t);
          if (v > c + 1e-9) { cur = t; c = v; improved = true; }
        }
      }
      if (!improved) break;
    }
    if (c > bestWp) { best = cur; bestWp = c; }
  };
  climb(start);
  for (let r = 0; r < 12; r++) {
    const sh = [...start];
    for (let i = 0; i < slots.length; i++) {
      if (sh[i] && !movable(sh[i]!)) continue;
      const pool = roster.filter((p) => movable(p) && slots[i].allows(p) && !has(sh, p));
      if (pool.length && Math.random() < 0.5) sh[i] = pool[Math.floor(Math.random() * pool.length)];
    }
    const seen = new Set<string>();
    for (let i = 0; i < sh.length; i++) { const p = sh[i]; if (p && seen.has(p.pid)) sh[i] = null; else if (p) seen.add(p.pid); }
    climb(sh);
  }
  return { lineup: best, wp: bestWp };
}
export { odds, runSim, calibrate, winProb, optimize, meta, usage, liveProj, liveStats, kickedOff, active, mean, sdOf, scoringFamily, ESPN_HEADERS, ESPN_STAT_KEY, http, SLEEPER, N, SEASON, WEEK, W_OURS, WIDTH, PLATFORM_ONLY, type Seat };
