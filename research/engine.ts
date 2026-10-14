#!/usr/bin/env bun
/**
 * Bottom-up fantasy projection + Monte Carlo engine.
 *
 * The platform projection is NOT an input. Every skill-position mean here is
 * rebuilt from raw weekly usage (targets, carries, red-zone touches, snaps)
 * and raw team volume, then simulated forward.
 *
 * Structure of one simulated week:
 *   game env   ->  shared log-factor on both teams' play volume
 *   game script->  latent margin; trailing team throws more, leading team runs
 *   team level ->  plays -> pass/rush attempts -> yards -> TDs (Poisson)
 *   player lvl ->  Dirichlet usage shares carve up the team's volume
 *   scoring    ->  each simulated stat line scored in the league's own scoring
 *
 * QB<->receiver, RB<->pass-game and cross-team correlation are STRUCTURAL:
 * they fall out of players sharing one team's simulated volume, not from a
 * hand-set rho matrix.
 *
 * K and D/ST keep the platform projection (no kicking/defense model here) and
 * are drawn from a fitted normal. That is a stated limitation, not an oversight.
 */

type Json = any;
declare const Bun: any;

export const SLEEPER = 'https://api.sleeper.app/v1';

// ---------------------------------------------------------------- rng

let _s = 0x9e3779b9;
export function seed(n: number) { _s = n >>> 0 || 1; }
/** xorshift32 — deterministic, so a backtest and a rerun agree. */
export function rnd(): number {
  _s ^= _s << 13; _s >>>= 0;
  _s ^= _s >>> 17;
  _s ^= _s << 5; _s >>>= 0;
  return _s / 4294967296;
}
let _spare: number | null = null;
export function randn(): number {
  if (_spare !== null) { const v = _spare; _spare = null; return v; }
  let u = 0, v = 0, s = 0;
  do { u = rnd() * 2 - 1; v = rnd() * 2 - 1; s = u * u + v * v; } while (s === 0 || s >= 1);
  const f = Math.sqrt(-2 * Math.log(s) / s);
  _spare = v * f;
  return u * f;
}
/** Marsaglia-Tsang. Needed for Dirichlet; k<1 handled by the boost identity. */
export function gammaRand(k: number): number {
  if (k <= 0) return 0;
  if (k < 1) return gammaRand(k + 1) * Math.pow(rnd() || 1e-12, 1 / k);
  const d = k - 1 / 3, c = 1 / Math.sqrt(9 * d);
  for (;;) {
    let x = 0, v = 0;
    do { x = randn(); v = 1 + c * x; } while (v <= 0);
    v = v * v * v;
    const u = rnd();
    if (u < 1 - 0.0331 * x * x * x * x) return d * v;
    if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
  }
}
export function dirichlet(alpha: number[]): number[] {
  const g = alpha.map((a) => gammaRand(Math.max(a, 1e-6)));
  const s = g.reduce((a, b) => a + b, 0) || 1;
  return g.map((x) => x / s);
}
export function poisson(lam: number): number {
  if (lam <= 0) return 0;
  if (lam > 30) return Math.max(0, Math.round(lam + Math.sqrt(lam) * randn()));
  const L = Math.exp(-lam);
  let k = 0, p = 1;
  do { k++; p *= rnd(); } while (p > L);
  return k - 1;
}
export function binomial(n: number, p: number): number {
  n = Math.max(0, Math.round(n));
  if (n === 0 || p <= 0) return 0;
  if (p >= 1) return n;
  if (n > 40) return Math.max(0, Math.min(n, Math.round(n * p + Math.sqrt(n * p * (1 - p)) * randn())));
  let c = 0;
  for (let i = 0; i < n; i++) if (rnd() < p) c++;
  return c;
}
/** Multinomial allocation of `n` discrete events over weights. */
export function multinomial(n: number, w: number[]): number[] {
  const out = new Array(w.length).fill(0);
  const tot = w.reduce((a, b) => a + b, 0);
  if (tot <= 0 || n <= 0) return out;
  for (let i = 0; i < n; i++) {
    let r = rnd() * tot, j = 0;
    while (j < w.length - 1 && (r -= w[j]) > 0) j++;
    out[j]++;
  }
  return out;
}
export const lognormMult = (sigma: number) => Math.exp(randn() * sigma - (sigma * sigma) / 2);

// ---------------------------------------------------------------- data

async function http(url: string, init: Json = {}): Promise<Json> {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(init.timeoutMs ?? 120_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
  return res.json();
}

const cacheDir = process.env.FF_CACHE_DIR ?? `${require('os').tmpdir()}/ff-cache`;
async function cached(path: string, url: string, ttlMs: number): Promise<Json> {
  const f = Bun.file(path);
  if ((await f.exists()) && Date.now() - f.lastModified < ttlMs) return f.json();
  const d = await http(url);
  await Bun.write(path, JSON.stringify(d));
  return d;
}

export async function players(): Promise<Record<string, Json>> {
  return cached(`${cacheDir}/players.json`, `${SLEEPER}/players/nfl`, 12 * 3600_000);
}
export async function weekly(kind: 'stats' | 'projections', season: number, week: number): Promise<Json> {
  // Finished weeks never change; the live week must stay fresh.
  const ttl = season === 2026 && week >= 2 ? 15 * 60_000 : 30 * 24 * 3600_000;
  return cached(`${cacheDir}/${kind}-${season}-${week}.json`, `${SLEEPER}/${kind}/nfl/regular/${season}/${week}`, ttl);
}
export async function schedule(season: number): Promise<Json[]> {
  return cached(`${cacheDir}/sched-${season}.json`, `https://api.sleeper.app/schedule/nfl/regular/${season}`, 24 * 3600_000);
}

export const num = (x: Json) => (typeof x === 'number' && isFinite(x) ? x : 0);

// ---------------------------------------------------------------- usage model

const NFL_TEAMS = ['ARI','ATL','BAL','BUF','CAR','CHI','CIN','CLE','DAL','DEN','DET','GB','HOU','IND','JAX','KC','LAC','LAR','LV','MIA','MIN','NE','NO','NYG','NYJ','PHI','PIT','SEA','SF','TB','TEN','WAS'];

export type TeamWeek = {
  plays: number; passAtt: number; rushAtt: number;
  passYd: number; rushYd: number; passTD: number; rushTD: number;
  rzPassAtt: number; rzRushAtt: number; sacks: number;
};
export type PlayerWeek = {
  pid: string; team: string; pos: string; week: number; season: number;
  tgt: number; rec: number; recYd: number; recTD: number; rzTgt: number; airYd: number;
  rushAtt: number; rushYd: number; rushTD: number; rzRush: number;
  passAtt: number; passYd: number; passTD: number; passInt: number; passRzAtt: number;
  fum: number; snapShare: number;
};

/** Week-by-week history, keyed season:week. Built once and reused by every league. */
export type History = {
  teams: Map<string, TeamWeek>;          // `${season}:${week}:${team}`
  playerWeeks: Map<string, PlayerWeek[]>; // pid -> chronological
  defAllow: Map<string, Record<string, number>>; // `${season}:${week}:${team}` -> fan_pts_allow_*
  order: { season: number; week: number }[];
};

export async function buildHistory(weeks: { season: number; week: number }[]): Promise<History> {
  const meta = await players();
  const teams = new Map<string, TeamWeek>();
  const playerWeeks = new Map<string, PlayerWeek[]>();
  const defAllow = new Map<string, Record<string, number>>();

  for (const { season, week } of weeks) {
    let st: Json;
    try { st = await weekly('stats', season, week); } catch { continue; }
    const tw = new Map<string, TeamWeek>();
    const blank = (): TeamWeek => ({ plays: 0, passAtt: 0, rushAtt: 0, passYd: 0, rushYd: 0, passTD: 0, rushTD: 0, rzPassAtt: 0, rzRushAtt: 0, sacks: 0 });

    for (const [pid, line] of Object.entries(st) as [string, Json][]) {
      if (NFL_TEAMS.includes(pid)) {
        defAllow.set(`${season}:${week}:${pid}`, {
          QB: num(line.fan_pts_allow_qb), RB: num(line.fan_pts_allow_rb),
          WR: num(line.fan_pts_allow_wr), TE: num(line.fan_pts_allow_te),
          all: num(line.fan_pts_allow), ptsAllow: num(line.pts_allow), ydsAllow: num(line.yds_allow),
        });
        continue;
      }
      const m = meta[pid];
      if (!m || !m.team) continue;
      const pos = m.position;
      if (!['QB', 'RB', 'WR', 'TE', 'FB'].includes(pos)) continue;
      if (!num(line.gp)) continue;
      const team = m.team;
      const t = tw.get(team) ?? blank();
      // tm_off_snp is repeated on every player of that team; take the max, don't sum.
      t.plays = Math.max(t.plays, num(line.tm_off_snp));
      t.passAtt += num(line.pass_att); t.rushAtt += num(line.rush_att);
      t.passYd += num(line.pass_yd); t.rushYd += num(line.rush_yd);
      t.passTD += num(line.pass_td); t.rushTD += num(line.rush_td);
      t.rzPassAtt += num(line.pass_rz_att); t.rzRushAtt += num(line.rush_rz_att);
      t.sacks += num(line.pass_sack);
      tw.set(team, t);

      const arr = playerWeeks.get(pid) ?? [];
      arr.push({
        pid, team, pos: pos === 'FB' ? 'RB' : pos, week, season,
        tgt: num(line.rec_tgt), rec: num(line.rec), recYd: num(line.rec_yd), recTD: num(line.rec_td),
        rzTgt: num(line.rec_rz_tgt), airYd: num(line.rec_air_yd),
        rushAtt: num(line.rush_att), rushYd: num(line.rush_yd), rushTD: num(line.rush_td), rzRush: num(line.rush_rz_att),
        passAtt: num(line.pass_att), passYd: num(line.pass_yd), passTD: num(line.pass_td),
        passInt: num(line.pass_int), passRzAtt: num(line.pass_rz_att),
        fum: num(line.fum), snapShare: num(line.tm_off_snp) ? num(line.off_snp) / num(line.tm_off_snp) : 0,
      });
      playerWeeks.set(pid, arr);
    }
    for (const [team, t] of tw) teams.set(`${season}:${week}:${team}`, t);
  }
  return { teams, playerWeeks, defAllow, order: weeks };
}

/** Recency weight: halflife in games. */
const wOf = (agoGames: number, halflife = 3) => Math.pow(0.5, agoGames / halflife);

/** Tunables exposed for the hyperparameter sweep in tune.ts. */
// Defaults below are the values selected by the 2025 W5-W18 sweep in backtest.ts.
// Changing one without re-running that backtest is a guess, not a tune.
export const T = {
  hlPlayer: Number(process.env.HL_PLAYER ?? 6),
  hlTeam: Number(process.env.HL_TEAM ?? 5),
  hlDef: Number(process.env.HL_DEF ?? 4),
  lookbackPlayer: Number(process.env.LB_PLAYER ?? 14),
  lookbackTeam: Number(process.env.LB_TEAM ?? 12),
  lookbackDef: Number(process.env.LB_DEF ?? 6),
  shrinkShare: Number(process.env.SHRINK_SHARE ?? 2.5),
  defPow: Number(process.env.DEF_POW ?? 0.5),
  defClamp: Number(process.env.DEF_CLAMP ?? 0.28),
  seasonDecay: Number(process.env.SEASON_DECAY ?? 1),
  // Vegas: how much of team scoring comes from the market vs the EWMA prior,
  // and the points -> offensive-TD conversion.
  vegW: Number(process.env.VEG_W ?? 0.7),
  vegOff: Number(process.env.VEG_OFF ?? 3.0),
  vegDiv: Number(process.env.VEG_DIV ?? 6.9),
  vegYd: Number(process.env.VEG_YD ?? 0.25),
};

/** Shrink a rate toward a prior; k is "how many observations before we trust it". */
const shrink = (obs: number, n: number, prior: number, k: number) => (obs * n + prior * k) / (n + k || 1);

export type Usage = {
  pid: string; name: string; pos: string; team: string;
  n: number;                 // games of evidence (weighted)
  tgtShare: number; carryShare: number; rzTgtShare: number; rzCarryShare: number;
  passAttShare: number; snapShare: number;
  ypt: number; ypc: number; catchRate: number; ypa: number;
  intRate: number; fumRate: number;
};

const POS_PRIOR: Record<string, { ypt: number; ypc: number; catchRate: number }> = {
  WR: { ypt: 8.2, ypc: 6.0, catchRate: 0.63 },
  TE: { ypt: 7.4, ypc: 4.0, catchRate: 0.68 },
  RB: { ypt: 6.3, ypc: 4.3, catchRate: 0.75 },
  QB: { ypt: 6.0, ypc: 4.6, catchRate: 0.6 },
};

/** Build each player's usage profile from every game strictly BEFORE (season, week). */
export function buildUsage(h: History, meta: Record<string, Json>, season: number, week: number, lookback = T.lookbackPlayer): Map<string, Usage> {
  const idx = (s: number, w: number) => s * 100 + w;
  const cut = idx(season, week);
  const out = new Map<string, Usage>();

  for (const [pid, all] of h.playerWeeks) {
    const hist = all.filter((p) => idx(p.season, p.week) < cut).slice(-lookback);
    if (!hist.length) continue;
    const m = meta[pid];
    if (!m) continue;
    const pos = hist[hist.length - 1].pos;
    const prior = POS_PRIOR[pos] ?? POS_PRIOR.WR;

    let W = 0;
    const acc = { tgt: 0, tgtDen: 0, carry: 0, carryDen: 0, rzT: 0, rzTDen: 0, rzC: 0, rzCDen: 0,
                  pa: 0, paDen: 0, snap: 0, recYd: 0, tgtN: 0, rec: 0, rushYd: 0, carryN: 0,
                  passYd: 0, paN: 0, int: 0, fum: 0, touch: 0 };
    hist.forEach((p, i) => {
      const w = wOf(hist.length - 1 - i, T.hlPlayer) * (p.season < season ? T.seasonDecay : 1);
      W += w;
      const t = h.teams.get(`${p.season}:${p.week}:${p.team}`);
      if (t) {
        acc.tgt += w * p.tgt;      acc.tgtDen += w * Math.max(t.passAtt, 1);
        acc.carry += w * p.rushAtt; acc.carryDen += w * Math.max(t.rushAtt, 1);
        acc.rzT += w * p.rzTgt;    acc.rzTDen += w * Math.max(t.rzPassAtt, 1);
        acc.rzC += w * p.rzRush;   acc.rzCDen += w * Math.max(t.rzRushAtt, 1);
        acc.pa += w * p.passAtt;   acc.paDen += w * Math.max(t.passAtt, 1);
      }
      acc.snap += w * p.snapShare;
      acc.recYd += w * p.recYd; acc.tgtN += w * p.tgt; acc.rec += w * p.rec;
      acc.rushYd += w * p.rushYd; acc.carryN += w * p.rushAtt;
      acc.passYd += w * p.passYd; acc.paN += w * p.passAtt;
      acc.int += w * p.passInt; acc.fum += w * p.fum;
      acc.touch += w * (p.rushAtt + p.rec + p.passAtt * 0.15);
    });
    if (!W) continue;

    out.set(pid, {
      pid, name: m.full_name ?? pid, pos, team: m.team ?? hist[hist.length - 1].team,
      n: W,
      tgtShare: shrink(acc.tgtDen ? acc.tgt / acc.tgtDen : 0, W, 0.06, T.shrinkShare),
      carryShare: shrink(acc.carryDen ? acc.carry / acc.carryDen : 0, W, 0.10, T.shrinkShare),
      rzTgtShare: acc.rzTDen ? acc.rzT / acc.rzTDen : 0,
      rzCarryShare: acc.rzCDen ? acc.rzC / acc.rzCDen : 0,
      passAttShare: acc.paDen ? acc.pa / acc.paDen : 0,
      snapShare: acc.snap / W,
      ypt: shrink(acc.tgtN ? acc.recYd / acc.tgtN : prior.ypt, acc.tgtN, prior.ypt, 18),
      ypc: shrink(acc.carryN ? acc.rushYd / acc.carryN : prior.ypc, acc.carryN, prior.ypc, 22),
      catchRate: Math.min(0.95, shrink(acc.tgtN ? acc.rec / acc.tgtN : prior.catchRate, acc.tgtN, prior.catchRate, 12)),
      ypa: shrink(acc.paN ? acc.passYd / acc.paN : 6.9, acc.paN, 6.9, 40),
      intRate: shrink(acc.paN ? acc.int / acc.paN : 0.023, acc.paN, 0.023, 60),
      fumRate: shrink(acc.touch ? acc.fum / acc.touch : 0.008, acc.touch, 0.008, 60),
    });
  }
  return out;
}

/** Team volume profile: EWMA over that team's recent games, before (season, week). */
export type TeamProfile = {
  team: string; n: number;
  plays: number; passAtt: number; rushAtt: number;
  ypa: number; ypc: number; td: number; passTDshare: number;
  rzPassAtt: number; rzRushAtt: number;
};

export function buildTeamProfiles(h: History, season: number, week: number, lookback = T.lookbackTeam): Map<string, TeamProfile> {
  const idx = (s: number, w: number) => s * 100 + w;
  const cut = idx(season, week);
  const rows = new Map<string, { k: number; t: TeamWeek }[]>();
  for (const [key, t] of h.teams) {
    const [s, w, team] = key.split(':');
    const k = idx(+s, +w);
    if (k >= cut) continue;
    (rows.get(team) ?? rows.set(team, []).get(team)!).push({ k, t });
  }
  const lgAvg = { plays: 63, passAtt: 33, rushAtt: 26, ypa: 6.9, ypc: 4.3, td: 2.5 };
  const out = new Map<string, TeamProfile>();
  for (const [team, list] of rows) {
    list.sort((a, b) => a.k - b.k);
    const recent = list.slice(-lookback);
    let W = 0;
    const a = { plays: 0, pa: 0, ra: 0, py: 0, ry: 0, ptd: 0, rtd: 0, rzp: 0, rzr: 0 };
    recent.forEach((r, i) => {
      const w = wOf(recent.length - 1 - i, T.hlTeam);
      W += w;
      const sw = w * ((r.k / 100 | 0) < season ? T.seasonDecay : 1);
      a.plays += sw * r.t.plays; a.pa += w * r.t.passAtt; a.ra += w * r.t.rushAtt;
      a.py += w * r.t.passYd; a.ry += w * r.t.rushYd;
      a.ptd += w * r.t.passTD; a.rtd += w * r.t.rushTD;
      a.rzp += w * r.t.rzPassAtt; a.rzr += w * r.t.rzRushAtt;
    });
    if (!W) continue;
    const passAtt = a.pa / W, rushAtt = a.ra / W, td = (a.ptd + a.rtd) / W;
    out.set(team, {
      team, n: W,
      plays: shrink(a.plays / W, W, lgAvg.plays, 2),
      passAtt: shrink(passAtt, W, lgAvg.passAtt, 2),
      rushAtt: shrink(rushAtt, W, lgAvg.rushAtt, 2),
      ypa: shrink(a.pa ? a.py / a.pa : lgAvg.ypa, a.pa / W, lgAvg.ypa, 3),
      ypc: shrink(a.ra ? a.ry / a.ra : lgAvg.ypc, a.ra / W, lgAvg.ypc, 3),
      td: shrink(td, W, lgAvg.td, 2),
      passTDshare: shrink(td ? a.ptd / W / td : 0.62, W, 0.62, 3),
      rzPassAtt: a.rzp / W, rzRushAtt: a.rzr / W,
    });
  }
  return out;
}

/** Opponent defensive multiplier by position, from fantasy points allowed. Dampened. */
export function defenseAdj(h: History, season: number, week: number, lookback = T.lookbackDef): Map<string, Record<string, number>> {
  const idx = (s: number, w: number) => s * 100 + w;
  const cut = idx(season, week);
  const byTeam = new Map<string, { k: number; v: Record<string, number> }[]>();
  for (const [key, v] of h.defAllow) {
    const [s, w, team] = key.split(':');
    const k = idx(+s, +w);
    if (k >= cut) continue;
    (byTeam.get(team) ?? byTeam.set(team, []).get(team)!).push({ k, v });
  }
  const ewma = new Map<string, Record<string, number>>();
  const POS = ['QB', 'RB', 'WR', 'TE'];
  for (const [team, list] of byTeam) {
    list.sort((a, b) => a.k - b.k);
    const recent = list.slice(-lookback);
    let W = 0;
    const acc: Record<string, number> = { QB: 0, RB: 0, WR: 0, TE: 0 };
    recent.forEach((r, i) => {
      const w = wOf(recent.length - 1 - i, T.hlDef);
      W += w;
      for (const p of POS) acc[p] += w * r.v[p];
    });
    if (!W) continue;
    ewma.set(team, Object.fromEntries(POS.map((p) => [p, acc[p] / W])));
  }
  // league mean per position, then a dampened ratio so one soft week can't swing a projection 40%
  const mean: Record<string, number> = {};
  for (const p of POS) {
    const vals = [...ewma.values()].map((v) => v[p]).filter((x) => x > 0);
    mean[p] = vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : 1;
  }
  const out = new Map<string, Record<string, number>>();
  for (const [team, v] of ewma) {
    out.set(team, Object.fromEntries(POS.map((p) => {
      const ratio = mean[p] > 0 ? v[p] / mean[p] : 1;
      const c = T.defClamp;
      return [p, Math.max(1 - c, Math.min(1 + c, Math.pow(ratio, T.defPow)))];
    })));
  }
  return out;
}

// ---------------------------------------------------------------- scoring

export type Scoring = Record<string, number>;
export type StatLine = Record<string, number>;

export function scoreLine(l: StatLine, s: Scoring): number {
  let p = 0;
  for (const k in s) p += s[k] * (l[k] ?? 0);
  // yardage bonuses are threshold, not linear
  if (s.bonus_rec_yd_100 && (l.rec_yd ?? 0) >= 100) p += s.bonus_rec_yd_100;
  if (s.bonus_rush_yd_100 && (l.rush_yd ?? 0) >= 100) p += s.bonus_rush_yd_100;
  if (s.bonus_pass_yd_300 && (l.pass_yd ?? 0) >= 300) p += s.bonus_pass_yd_300;
  if (s.bonus_pass_yd_400 && (l.pass_yd ?? 0) >= 400) p += s.bonus_pass_yd_400;
  if (s.bonus_rush_rec_yd_100 && (l.rush_yd ?? 0) + (l.rec_yd ?? 0) >= 100) p += s.bonus_rush_rec_yd_100;
  return p;
}
/** Bonus keys are applied by threshold above; drop them from the linear pass. */
export const linearScoring = (s: Scoring): Scoring =>
  Object.fromEntries(Object.entries(s).filter(([k]) => !k.startsWith('bonus_')));

// ---------------------------------------------------------------- simulation

/** Dirichlet concentration: higher = shares hold steadier week to week. */
const CONC = { tgt: 20, carry: 26, qb: 70 };

export type SimInput = {
  usage: Map<string, Usage>;
  teamProf: Map<string, TeamProfile>;
  defAdj: Map<string, Record<string, number>>;
  games: { home: string; away: string }[];
  scoring: Scoring;
  keep: Set<string>;            // pids whose samples we retain
  /** pid -> {mu, sd} platform fallback for K/DST and players with no usage history. */
  fallback: Map<string, { mu: number; sd: number }>;
  /** Vegas implied team totals, by team. Absent team -> EWMA prior only. */
  odds?: Map<string, { implied: number; spread: number; total: number }>;
  /** Players expected to actually play. Anyone absent is removed from the share pool,
   *  and the Dirichlet redistributes their usage to the teammates who remain. */
  active?: Set<string>;
  n: number;
};

export type SimOut = {
  samples: Map<string, Float64Array>;
  source: Map<string, 'model' | 'platform-fallback'>;
};

export function simulate(inp: SimInput): SimOut {
  const { usage, teamProf, defAdj, games, keep, fallback, n } = inp;
  const odds = inp.odds;
  /** Market view of a team's offensive TDs, blended with its own recent rate. */
  const tdMean = (team: string, prior: number) => {
    const o = odds?.get(team);
    if (!o) return prior;
    const vegas = Math.max(0.2, (o.implied - T.vegOff) / T.vegDiv);
    return T.vegW * vegas + (1 - T.vegW) * prior;
  };
  /** Market view of offensive volume, as a multiplier on yards-per-attempt. */
  const ydMult = (team: string) => {
    const o = odds?.get(team);
    if (!o) return 1;
    return 1 + T.vegYd * (o.implied / 22.5 - 1);
  };
  const scoring = linearScoring(inp.scoring);
  const bonus = inp.scoring;

  // index usage by team
  const byTeam = new Map<string, Usage[]>();
  for (const u of usage.values()) {
    if (!u.team) continue;
    if (inp.active && !inp.active.has(u.pid)) continue;
    (byTeam.get(u.team) ?? byTeam.set(u.team, []).get(u.team)!).push(u);
  }

  const samples = new Map<string, Float64Array>();
  const source = new Map<string, 'model' | 'platform-fallback'>();
  const modelled = new Set<string>();
  for (const g of games) for (const t of [g.home, g.away]) {
    for (const u of byTeam.get(t) ?? []) if (keep.has(u.pid) && u.n >= 0.8) modelled.add(u.pid);
  }
  for (const pid of keep) {
    samples.set(pid, new Float64Array(n));
    source.set(pid, modelled.has(pid) ? 'model' : 'platform-fallback');
  }

  const line: StatLine = {};
  const put = (pid: string, i: number, l: StatLine) => {
    const arr = samples.get(pid);
    if (!arr) return;
    let extra = 0;
    if (bonus.bonus_rec_yd_100 && (l.rec_yd ?? 0) >= 100) extra += bonus.bonus_rec_yd_100;
    if (bonus.bonus_rush_yd_100 && (l.rush_yd ?? 0) >= 100) extra += bonus.bonus_rush_yd_100;
    if (bonus.bonus_pass_yd_300 && (l.pass_yd ?? 0) >= 300) extra += bonus.bonus_pass_yd_300;
    if (bonus.bonus_pass_yd_400 && (l.pass_yd ?? 0) >= 400) extra += bonus.bonus_pass_yd_400;
    if (bonus.bonus_rush_rec_yd_100 && (l.rush_yd ?? 0) + (l.rec_yd ?? 0) >= 100) extra += bonus.bonus_rush_rec_yd_100;
    arr[i] = scoreLine(l, scoring) + extra;
  };

  for (let i = 0; i < n; i++) {
    for (const g of games) {
      const env = randn() * 0.10;
      const prof = { home: teamProf.get(g.home), away: teamProf.get(g.away) };
      if (!prof.home || !prof.away) continue;
      const dHome = defAdj.get(g.away) ?? { QB: 1, RB: 1, WR: 1, TE: 1 }; // defense FACING home
      const dAway = defAdj.get(g.home) ?? { QB: 1, RB: 1, WR: 1, TE: 1 };

      // 1) team touchdowns first, so game script is caused by scoring, not assumed
      // Vegas already prices the opponent; only fall back to the defence adjustment
      // when there is no line for that team.
      const dH = odds?.has(g.home) ? 1 : (dHome.WR + dHome.RB) / 2;
      const dA = odds?.has(g.away) ? 1 : (dAway.WR + dAway.RB) / 2;
      const tdH = poisson(tdMean(g.home, prof.home.td) * dH * Math.exp(env));
      const tdA = poisson(tdMean(g.away, prof.away.td) * dA * Math.exp(env));
      const script = tdH - tdA; // >0: home ahead -> away throws more, home runs more

      for (const side of ['home', 'away'] as const) {
        const team = g[side];
        const p = prof[side]!;
        const d = side === 'home' ? dHome : dAway;
        const sign = side === 'home' ? 1 : -1;
        const roster = byTeam.get(team) ?? [];
        if (!roster.length) continue;

        const playsMult = Math.exp(env + randn() * 0.06);
        const passAtt = Math.max(8, p.passAtt * playsMult * Math.exp(-0.055 * script * sign) * lognormMult(0.10));
        const rushAtt = Math.max(8, p.rushAtt * playsMult * Math.exp(0.060 * script * sign) * lognormMult(0.13));
        const ym = ydMult(team);
        const dPass = odds?.has(team) ? 1 : (d.WR * 2 + d.TE) / 3;
        const dRush = odds?.has(team) ? 1 : d.RB;
        const teamPassYd = passAtt * p.ypa * dPass * ym * lognormMult(0.17);
        const teamRushYd = rushAtt * p.ypc * dRush * ym * lognormMult(0.15);
        const td = side === 'home' ? tdH : tdA;
        const passTD = binomial(td, Math.max(0.15, Math.min(0.9, p.passTDshare)));
        const rushTD = td - passTD;

        // --- receivers
        const catchers = roster.filter((u) => u.tgtShare > 0.002 || u.rzTgtShare > 0.002);
        if (catchers.length) {
          const sh = dirichlet(catchers.map((u) => CONC.tgt * Math.max(u.tgtShare, 0.002)));
          const ydW = catchers.map((u, j) => sh[j] * u.ypt * lognormMult(0.30));
          const ydTot = ydW.reduce((a, b) => a + b, 0) || 1;
          const tdW = catchers.map((u, j) => 0.6 * u.rzTgtShare + 0.4 * sh[j]);
          const tdAlloc = multinomial(passTD, tdW);
          for (let j = 0; j < catchers.length; j++) {
            const u = catchers[j];
            if (!samples.has(u.pid)) continue;
            const tg = sh[j] * passAtt;
            line.rec = binomial(tg, u.catchRate);
            line.rec_yd = (ydW[j] / ydTot) * teamPassYd;
            line.rec_td = tdAlloc[j];
            line.rush_yd = 0; line.rush_td = 0; line.pass_yd = 0; line.pass_td = 0; line.pass_int = 0;
            line.fum_lost = 0; line.fum = 0;
            put(u.pid, i, line);
          }
        }

        // --- rushers (QBs included: they take carries and goal-line TDs)
        const rushers = roster.filter((u) => u.carryShare > 0.002 || u.rzCarryShare > 0.002);
        if (rushers.length) {
          const sh = dirichlet(rushers.map((u) => CONC.carry * Math.max(u.carryShare, 0.002)));
          const ydW = rushers.map((u, j) => sh[j] * u.ypc * lognormMult(0.28));
          const ydTot = ydW.reduce((a, b) => a + b, 0) || 1;
          const tdW = rushers.map((u, j) => 0.7 * u.rzCarryShare + 0.3 * sh[j]);
          const tdAlloc = multinomial(rushTD, tdW);
          for (let j = 0; j < rushers.length; j++) {
            const u = rushers[j];
            const arr = samples.get(u.pid);
            if (!arr) continue;
            const carries = sh[j] * rushAtt;
            const l: StatLine = {
              rush_yd: (ydW[j] / ydTot) * teamRushYd,
              rush_td: tdAlloc[j],
            };
            const touches = carries + 2;
            l.fum_lost = binomial(poisson(u.fumRate * touches), 0.5);
            arr[i] += scoreLine(l, scoring);
            if (bonus.bonus_rush_yd_100 && l.rush_yd >= 100) arr[i] += bonus.bonus_rush_yd_100;
          }
        }

        // --- quarterbacks
        const qbs = roster.filter((u) => u.pos === 'QB' && u.passAttShare > 0.02);
        if (qbs.length) {
          const sh = dirichlet(qbs.map((u) => CONC.qb * Math.max(u.passAttShare, 0.01)));
          const tdAlloc = multinomial(passTD, sh);
          for (let j = 0; j < qbs.length; j++) {
            const u = qbs[j];
            const arr = samples.get(u.pid);
            if (!arr) continue;
            const att = sh[j] * passAtt;
            const l: StatLine = {
              pass_yd: sh[j] * teamPassYd,
              pass_td: tdAlloc[j],
              pass_int: poisson(u.intRate * att),
            };
            arr[i] += scoreLine(l, scoring);
            if (bonus.bonus_pass_yd_300 && l.pass_yd >= 300) arr[i] += bonus.bonus_pass_yd_300;
            if (bonus.bonus_pass_yd_400 && l.pass_yd >= 400) arr[i] += bonus.bonus_pass_yd_400;
          }
        }
      }
    }
    // players with no usable history (K, D/ST, true rookies): platform mean + fitted sd
    for (const [pid, fb] of fallback) {
      const arr = samples.get(pid);
      if (!arr || source.get(pid) !== 'platform-fallback') continue;
      arr[i] = Math.max(0, fb.mu + fb.sd * randn());
    }
  }
  return { samples, source };
}
