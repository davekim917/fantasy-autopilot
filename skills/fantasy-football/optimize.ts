#!/usr/bin/env bun
/**
 * Win-probability lineup optimizer.
 *
 * Sit/start is not "maximize projected points" — it is "maximize P(my total > their total)".
 * With ~10 starters the sum is close to normal, so no Monte Carlo is needed for this question:
 *
 *   T ~ N(mu, sd^2)   mu = sum mu_i,  sd^2 = sum sd_i^2 + 2*sum rho_ij sd_i sd_j
 *   P(win) = Phi(z),  z = (mu - mu_opp) / sqrt(sd^2 + sd_opp^2)
 *
 * The rule that falls out: a swap is right iff  d(mu) > z * d(sd).
 * Favored (z > 0) → variance costs you, play the floor. Underdog (z < 0) → variance pays.
 *
 * Inputs are public Sleeper data (weekly projections + historical weekly actuals);
 * ESPN roster/slot/lock state needs your ESPN credentials, joined on `espn_id`.
 * sd is FITTED, not assumed: empirical SD of (actual - projected) by position and
 * projection size, in each league's own scoring.
 */
import { cacheDir, errorText, fail, http as transport, loadConfig, redact, resolveLeague, type EspnLeague, type League, type SleeperLeague } from './leagues.ts';

type Json = any;
declare const Bun: any;

// ---------------------------------------------------------------- tunables
//
// Every constant here is a stated assumption, not a fitted value. These are the
// slots a judgment model (Jev) replaces first — p(play) especially.

/** Extra risk for a player whose status TODAY is worse than the average player the sd fit covers. */
const STATUS: Record<string, { muMult: number; sdMult: number }> = {
  Questionable: { muMult: 0.88, sdMult: 1.25 },
  Doubtful: { muMult: 0.45, sdMult: 1.5 },
  Out: { muMult: 0, sdMult: 0 },
  IR: { muMult: 0, sdMult: 0 },
  PUP: { muMult: 0, sdMult: 0 },
  Sus: { muMult: 0, sdMult: 0 },
  NA: { muMult: 0, sdMult: 0 },
  COV: { muMult: 0.45, sdMult: 1.5 },
};

/** Pairwise correlation by relationship. Published-range values, not fitted here. */
const RHO = {
  qbSameTeamWr: 0.35,
  qbSameTeamTe: 0.25,
  qbSameTeamRb: 0.05,
  wrSameTeamWr: -0.1,
  kSameTeamOffense: 0.15,
  dstVsOpposingSkill: -0.25,
  sameGameOpposingSkill: 0.1,
};

/** Below this swing in win probability (percentage points) the math cannot separate two lineups. */
const DEAD_BAND_PP = 1.5;

// ---------------------------------------------------------------- http

async function http(url: string, init: RequestInit & { timeoutMs?: number } = {}): Promise<Json> {
  const sep = url.includes('?') ? '&' : '?';
  const bust = url.includes('sleeper.app') ? `${sep}_=${Date.now()}${Math.random().toString(36).slice(2, 8)}` : '';
  return transport(url + bust, { ...init, headers: { 'cache-control': 'no-cache', ...(init.headers as Json) }, timeoutMs: init.timeoutMs ?? 60_000 });
}

const SLEEPER = 'https://api.sleeper.app/v1';
const ESPN_HEADERS = { 'x-fantasy-platform': 'espn-fantasy-web', 'x-fantasy-source': 'kona', accept: 'application/json' };

// ---------------------------------------------------------------- scoring

/** ESPN statId → Sleeper stat key, for the scoring items that matter to skill players. */
const ESPN_STAT_KEY: Record<number, string> = {
  3: 'pass_yd', 4: 'pass_td', 19: 'pass_2pt', 20: 'pass_int',
  24: 'rush_yd', 25: 'rush_td', 26: 'rush_2pt',
  42: 'rec_yd', 43: 'rec_td', 44: 'rec_2pt', 53: 'rec',
  72: 'fum_lost',
};

type Scoring = Record<string, number>;
const scoreLine = (line: Json, scoring: Scoring) =>
  Object.entries(scoring).reduce((a, [k, w]) => a + w * Number(line?.[k] ?? 0), 0);

/** K and D/ST scoring is idiosyncratic per platform; use the platform's own projected total for them. */
const USE_PLATFORM_POINTS = new Set(['K', 'DEF', 'DST', 'D/ST']);

// ---------------------------------------------------------------- data

let playersCache: Record<string, Json> | null = null;
async function sleeperPlayers(): Promise<Record<string, Json>> {
  if (playersCache) return playersCache;
  const path = `${cacheDir()}/sleeper-players-nfl.json`;
  const f = Bun.file(path);
  if ((await f.exists()) && Date.now() - f.lastModified < 12 * 3600_000) return (playersCache = await f.json());
  playersCache = await http(`${SLEEPER}/players/nfl`, { timeoutMs: 180_000 });
  await Bun.write(path, JSON.stringify(playersCache));
  return playersCache!;
}

const weekCache = new Map<string, Json>();
async function weekly(kind: 'projections' | 'stats', season: string | number, week: number): Promise<Json> {
  const key = `${kind}:${season}:${week}`;
  if (weekCache.has(key)) return weekCache.get(key);
  const path = `${cacheDir()}/sleeper-${kind}-${season}-${week}.json`;
  const f = Bun.file(path);
  let data: Json;
  if ((await f.exists()) && Date.now() - f.lastModified < 3600_000) data = await f.json();
  else {
    data = await http(`${SLEEPER}/${kind}/nfl/regular/${season}/${week}`);
    await Bun.write(path, JSON.stringify(data));
  }
  weekCache.set(key, data);
  return data;
}

/** Sleeper's own scored projection, by scoring family — the fallback for K / D/ST. */
const platformPoints = (line: Json, family: 'ppr' | 'half_ppr' | 'std') => Number(line?.[`pts_${family}`] ?? 0);

function scoringFamily(scoring: Scoring): 'ppr' | 'half_ppr' | 'std' {
  const rec = scoring.rec ?? 0;
  return rec >= 0.75 ? 'ppr' : rec >= 0.25 ? 'half_ppr' : 'std';
}

// ---------------------------------------------------------------- sigma fit

type SigmaModel = Record<string, { a: number; b: number; n: number }>;

/**
 * Empirical SD of (actual − projected) by position, as a linear function of the projection.
 * Fitted on completed weeks in THIS league's scoring. DNP outcomes are included, so the
 * baseline already carries ordinary inactive risk; STATUS above only adds today's known extra.
 */
async function fitSigma(scoring: Scoring, weeks: Array<[string | number, number]>): Promise<SigmaModel> {
  const players = await sleeperPlayers();
  const family = scoringFamily(scoring);
  const rows: Record<string, Array<[number, number]>> = {};
  for (const [season, week] of weeks) {
    const [proj, act] = await Promise.all([weekly('projections', season, week), weekly('stats', season, week)]);
    for (const [pid, pline] of Object.entries(proj)) {
      const pos = players[pid]?.position;
      if (!pos) continue;
      const mu = USE_PLATFORM_POINTS.has(pos) ? platformPoints(pline, family) : scoreLine(pline, scoring);
      if (mu < 3) continue; // startable players only — the fit should not be dominated by deep bench noise
      const aline = (act as Json)[pid];
      const actual = USE_PLATFORM_POINTS.has(pos) ? platformPoints(aline, family) : scoreLine(aline ?? {}, scoring);
      (rows[pos] ??= []).push([mu, actual - mu]);
    }
  }
  const model: SigmaModel = {};
  for (const [pos, pairs] of Object.entries(rows)) {
    // Bin by projection size, take SD of residuals per bin, regress SD on bin centre.
    const bins: Array<{ c: number; v: number[] }> = [
      { c: 4, v: [] }, { c: 7.5, v: [] }, { c: 12.5, v: [] }, { c: 17.5, v: [] }, { c: 23, v: [] },
    ];
    for (const [mu, resid] of pairs) {
      const i = mu < 5.5 ? 0 : mu < 10 ? 1 : mu < 15 ? 2 : mu < 20 ? 3 : 4;
      bins[i].v.push(resid);
    }
    const pts = bins.filter((b) => b.v.length >= 30).map((b) => {
      const m = b.v.reduce((a, x) => a + x, 0) / b.v.length;
      return [b.c, Math.sqrt(b.v.reduce((a, x) => a + (x - m) ** 2, 0) / (b.v.length - 1))] as const;
    });
    if (pts.length < 2) {
      const all = pairs.map(([, r]) => r);
      const m = all.reduce((a, x) => a + x, 0) / Math.max(all.length, 1);
      const sd = Math.sqrt(all.reduce((a, x) => a + (x - m) ** 2, 0) / Math.max(all.length - 1, 1));
      model[pos] = { a: sd || 5, b: 0, n: pairs.length };
      continue;
    }
    const n = pts.length;
    const sx = pts.reduce((a, p) => a + p[0], 0), sy = pts.reduce((a, p) => a + p[1], 0);
    const sxx = pts.reduce((a, p) => a + p[0] * p[0], 0), sxy = pts.reduce((a, p) => a + p[0] * p[1], 0);
    const b = (n * sxy - sx * sy) / (n * sxx - sx * sx);
    model[pos] = { a: (sy - b * sx) / n, b, n: pairs.length };
  }
  return model;
}

const sigmaOf = (model: SigmaModel, pos: string, mu: number) => {
  const m = model[pos] ?? { a: 6, b: 0.15 };
  return Math.max(2, m.a + m.b * mu);
};

// ---------------------------------------------------------------- player model

type P = {
  id: string;
  name: string;
  pos: string;
  team: string | null;
  opp: string | null;
  status: string | null;
  mu: number;
  sd: number;
  locked: boolean;
  done: boolean;
  slot?: string;
  eligible?: number[];
};

const phi = (z: number) => 0.5 * (1 + erf(z / Math.SQRT2));
function erf(x: number) {
  const s = Math.sign(x);
  x = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * x);
  const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return s * y;
}

/** sd of a set of players including pairwise correlation. */
function lineupSd(ps: P[]): number {
  let v = ps.reduce((a, p) => a + p.sd * p.sd, 0);
  for (let i = 0; i < ps.length; i++) {
    for (let j = i + 1; j < ps.length; j++) {
      const r = rho(ps[i], ps[j]);
      if (r) v += 2 * r * ps[i].sd * ps[j].sd;
    }
  }
  return Math.sqrt(Math.max(v, 0));
}

function rho(a: P, b: P): number {
  if (!a.team || !b.team || a.sd === 0 || b.sd === 0) return 0;
  const skill = (p: P) => ['QB', 'RB', 'WR', 'TE'].includes(p.pos);
  const dst = (p: P) => USE_PLATFORM_POINTS.has(p.pos) && p.pos !== 'K';
  if (a.team === b.team) {
    const pair = [a.pos, b.pos].sort().join('');
    if (pair === 'QBWR') return RHO.qbSameTeamWr;
    if (pair === 'QBTE') return RHO.qbSameTeamTe;
    if (pair === 'QBRB') return RHO.qbSameTeamRb;
    if (pair === 'WRWR') return RHO.wrSameTeamWr;
    if (a.pos === 'K' || b.pos === 'K') return RHO.kSameTeamOffense;
    return 0;
  }
  const opposed = (a.opp && a.opp === b.team) || (b.opp && b.opp === a.team);
  if (!opposed) return 0;
  if (dst(a) && skill(b)) return RHO.dstVsOpposingSkill;
  if (dst(b) && skill(a)) return RHO.dstVsOpposingSkill;
  if (skill(a) && skill(b)) return RHO.sameGameOpposingSkill;
  return 0;
}

const total = (ps: P[]) => ({ mu: ps.reduce((a, p) => a + p.mu, 0), sd: lineupSd(ps) });

function winProb(mine: P[], opp: P[]): number {
  const m = total(mine), o = total(opp);
  const sd = Math.sqrt(m.sd ** 2 + o.sd ** 2);
  return sd <= 0 ? (m.mu > o.mu ? 1 : 0) : phi((m.mu - o.mu) / sd);
}

// ---------------------------------------------------------------- optimizer

type Slot = { idx: number; name: string; allows: (p: P) => boolean; locked?: boolean };

/** Hill-climb over legal assignments, maximizing P(win). Small problem; restarts make it robust. */
function optimize(slots: Slot[], starters: (P | null)[], bench: P[], opp: P[]) {
  // Membership is by player id, never object identity: the same player can be built
  // from two sources (starters view and roster view) and object-identity checks then
  // let him be seated twice, which silently doubles his points in the total.
  const byId = new Map<string, P>();
  for (const p of [...(starters.filter(Boolean) as P[]), ...bench]) if (!byId.has(p.id)) byId.set(p.id, p);
  const roster = [...byId.values()];
  const has = (l: (P | null)[], p: P) => l.some((x) => x?.id === p.id);
  const movable = (p: P) => !p.locked && !p.done;
  let best = starters.map((s) => s);
  let bestWp = winProb(best.filter(Boolean) as P[], opp);

  const climb = (start: (P | null)[]) => {
    let cur = [...start];
    let wp = winProb(cur.filter(Boolean) as P[], opp);
    for (let pass = 0; pass < 12; pass++) {
      let improved = false;
      for (let i = 0; i < slots.length; i++) {
        if (cur[i] && !movable(cur[i]!)) continue;
        // Recomputed per slot: a stale bench list lets an already-seated player be
        // seated again later in the same pass, double-counting his points.
        const onBench = roster.filter((p) => !has(cur, p));
        for (const cand of [...onBench, null]) {
          if (cand && (!movable(cand) || !slots[i].allows(cand) || has(cur, cand))) continue;
          if (!cand && cur[i]) continue;
          const trial = [...cur];
          trial[i] = cand;
          const wp2 = winProb(trial.filter(Boolean) as P[], opp);
          if (wp2 > wp + 1e-9) { cur = trial; wp = wp2; improved = true; }
        }
        // slot exchange between two starters
        for (let j = i + 1; j < slots.length; j++) {
          const a = cur[i], b = cur[j];
          if (!a || !b || !movable(a) || !movable(b)) continue;
          if (!slots[i].allows(b) || !slots[j].allows(a)) continue;
          const trial = [...cur];
          trial[i] = b; trial[j] = a;
          const wp2 = winProb(trial.filter(Boolean) as P[], opp);
          if (wp2 > wp + 1e-9) { cur = trial; wp = wp2; improved = true; }
        }
      }
      if (!improved) break;
    }
    if (wp > bestWp) { best = cur; bestWp = wp; }
  };

  climb(starters);
  for (let r = 0; r < 25; r++) {
    const shuffled = [...starters];
    for (let i = 0; i < slots.length; i++) {
      // A slot holding a locked or already-played starter is frozen: his points are banked
      // and the platform will reject the move. The climb respects this; the restart must too.
      const sitting = shuffled[i];
      if (sitting && !movable(sitting)) continue;
      const pool = roster.filter((p) => movable(p) && slots[i].allows(p) && !has(shuffled, p));
      if (pool.length && Math.random() < 0.5) shuffled[i] = pool[Math.floor(Math.random() * pool.length)];
    }
    // repair duplicates
    const seen = new Set<string>();
    for (let i = 0; i < shuffled.length; i++) {
      const p = shuffled[i];
      if (p && seen.has(p.id)) shuffled[i] = null;
      else if (p) seen.add(p.id);
    }
    climb(shuffled);
  }
  const ids = (best.filter(Boolean) as P[]).map((p) => p.id);
  if (new Set(ids).size !== ids.length) fail('internal: optimizer produced a duplicate starter');
  for (let i = 0; i < slots.length; i++) {
    const was = starters[i];
    if (was && !movable(was) && best[i]?.id !== was.id) fail(`internal: optimizer moved locked/played starter ${was.name}`);
  }
  return { lineup: best, wp: bestWp };
}

// ---------------------------------------------------------------- sleeper league

const SLEEPER_FLEX: Record<string, string[]> = {
  FLEX: ['RB', 'WR', 'TE'],
  SUPER_FLEX: ['QB', 'RB', 'WR', 'TE'],
  REC_FLEX: ['WR', 'TE'],
  WRRB_FLEX: ['RB', 'WR'],
};

async function sleeperBoard(lg: SleeperLeague, weekArg?: number) {
  const players = await sleeperPlayers();
  const [state, league, rosters] = await Promise.all([
    http(`${SLEEPER}/state/nfl`),
    http(`${SLEEPER}/league/${lg.leagueId}`),
    http(`${SLEEPER}/league/${lg.leagueId}/rosters`),
  ]);
  const week = weekArg ?? Number(league.settings?.leg ?? state.week);
  const season = String(league.season);
  const schedule = await http(`https://api.sleeper.app/schedule/nfl/regular/${season}`);
  const scoring: Scoring = league.scoring_settings;
  const family = scoringFamily(scoring);
  const matchups = await http(`${SLEEPER}/league/${lg.leagueId}/matchups/${week}`);
  const mine = matchups.find((m: Json) => m.roster_id === lg.rosterId) ?? fail('no matchup for your roster');
  const oppM = matchups.find((m: Json) => m.matchup_id === mine.matchup_id && m.roster_id !== lg.rosterId);
  const proj = await weekly('projections', season, week);

  const games = new Map<string, Json>();
  for (const g of schedule) if (g.week === week) { games.set(g.home, { ...g, opp: g.away }); games.set(g.away, { ...g, opp: g.home }); }

  const sigma = await fitSigma(scoring, historyWeeks(season, week));
  const roster = rosters.find((r: Json) => r.roster_id === lg.rosterId);

  const mk = (pid: string, pointsIfDone?: number): P => {
    const info = players[pid] ?? {};
    const isDst = /^[A-Z]{2,3}$/.test(pid);
    const pos = isDst ? 'DEF' : info.position;
    const team = isDst ? pid : info.team ?? null;
    const g = team ? games.get(team) : undefined;
    const done = g ? g.status === 'complete' : false;
    const locked = g ? g.status !== 'pre_game' : false;
    let mu = USE_PLATFORM_POINTS.has(pos) ? platformPoints(proj[pid], family) : scoreLine(proj[pid] ?? {}, scoring);
    let sd = sigmaOf(sigma, pos, mu);
    const st = info.injury_status as string | null;
    if (st && STATUS[st]) { mu *= STATUS[st].muMult; sd *= STATUS[st].sdMult; }
    if (done) { mu = pointsIfDone ?? mu; sd = 0; }
    return { id: pid, name: isDst ? `${team} DST` : `${info.first_name ?? ''} ${info.last_name ?? ''}`.trim() || pid,
      pos, team, opp: g?.opp ?? null, status: st ?? null, mu, sd, locked, done };
  };

  const startersPoints: number[] = mine.starters_points ?? [];
  const slotNames: string[] = league.roster_positions.filter((p: string) => p !== 'BN' && p !== 'IR' && p !== 'TAXI');
  const starters: (P | null)[] = mine.starters.map((pid: string, i: number) => (pid && pid !== '0' ? mk(pid, startersPoints[i]) : null));
  const reserve: string[] = roster.reserve ?? [];
  const benchIds: string[] = (roster.players ?? []).filter((p: string) => !mine.starters.includes(p) && !reserve.includes(p));
  const bench = benchIds.map((p) => mk(p));
  const oppPlayers: P[] = (oppM?.starters ?? []).filter((p: string) => p && p !== '0')
    .map((pid: string, i: number) => mk(pid, oppM.starters_points?.[i]));

  const slots: Slot[] = slotNames.map((name, idx) => ({
    idx, name,
    allows: (p: P) => {
      const fps: string[] = p.pos === 'DEF' ? ['DEF'] : (players[p.id]?.fantasy_positions ?? [p.pos]);
      const allowed = SLEEPER_FLEX[name] ?? [name];
      return fps.some((f) => allowed.includes(f));
    },
  }));
  return { week, leagueName: league.name, slots, starters, bench, opp: oppPlayers, sigma, oppName: oppM ? `roster ${oppM.roster_id}` : 'bye' };
}

/** Completed weeks to fit on: this season's finished weeks plus all of last season. */
function historyWeeks(season: string, week: number): Array<[string | number, number]> {
  const out: Array<[string | number, number]> = [];
  const prev = String(Number(season) - 1);
  for (let w = 1; w <= 18; w++) out.push([prev, w]);
  for (let w = 1; w < week; w++) out.push([season, w]);
  return out;
}

// ---------------------------------------------------------------- espn league

const ESPN_SLOTS: Record<number, string> = { 0: 'QB', 2: 'RB', 3: 'RB/WR', 4: 'WR', 5: 'WR/TE', 6: 'TE', 7: 'OP', 16: 'D/ST', 17: 'K', 20: 'Bench', 21: 'IR', 23: 'FLEX' };
const ESPN_POS: Record<number, string> = { 1: 'QB', 2: 'RB', 3: 'WR', 4: 'TE', 5: 'K', 16: 'DEF' };

async function espnBoard(lg: EspnLeague, weekArg?: number) {
  const players = await sleeperPlayers();
  const season = Number((await http('https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl', { headers: ESPN_HEADERS })).currentSeasonId);
  const base = `https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/${season}/segments/0/leagues/${lg.leagueId}`;
  const meta = await http(`${base}?view=mSettings&view=mStatus&view=mTeam`, { headers: ESPN_HEADERS });
  const period = weekArg ?? Number(meta.scoringPeriodId);
  const mp = Number(meta.status?.currentMatchupPeriod ?? period);
  const scoring: Scoring = {};
  for (const it of meta.settings.scoringSettings.scoringItems) {
    const k = ESPN_STAT_KEY[it.statId];
    if (k) scoring[k] = it.points;
  }
  const family = scoringFamily(scoring);
  const [rosterView, schedule, sleeperSchedule] = await Promise.all([
    http(`${base}?view=mRoster&scoringPeriodId=${period}`, { headers: ESPN_HEADERS }),
    http(`${base}?view=mMatchupScore&scoringPeriodId=${period}`, { headers: ESPN_HEADERS }),
    http(`https://api.sleeper.app/schedule/nfl/regular/${season}`),
  ]);
  const game = schedule.schedule.find((g: Json) => g.matchupPeriodId === mp && (g.home?.teamId === lg.teamId || g.away?.teamId === lg.teamId))
    ?? fail(`no ESPN matchup in period ${mp}`);
  const oppId = game.home?.teamId === lg.teamId ? game.away?.teamId : game.home?.teamId;

  // Sleeper injury status is the fresher feed (it had Zay Flowers OUT while ESPN still said
  // QUESTIONABLE), so statuses are merged. espn_id is missing for many Sleeper records, so the
  // join falls back to normalized name + position.
  const norm = (x: string) => x.toLowerCase().replace(/[^a-z]/g, '');
  const byEspnId = new Map<number, string>();
  const byName = new Map<string, string>();
  for (const [pid, info] of Object.entries(players)) {
    const i = info as Json;
    if (i.espn_id) byEspnId.set(Number(i.espn_id), pid);
    if (i.full_name && i.position) byName.set(`${norm(i.full_name)}|${i.position}`, pid);
  }
  const games = new Map<string, Json>();
  for (const g of sleeperSchedule) if (g.week === period) { games.set(g.home, { ...g, opp: g.away }); games.set(g.away, { ...g, opp: g.home }); }
  const sigma = await fitSigma(scoring, historyWeeks(String(season), period));

  const entryToP = (e: Json): P => {
    const pl = e.playerPoolEntry?.player ?? {};
    const pos = ESPN_POS[pl.defaultPositionId] ?? String(pl.defaultPositionId);
    const sid = byEspnId.get(Number(pl.id)) ?? byName.get(`${norm(pl.fullName ?? '')}|${pos}`);
    const team = sid ? (players[sid]?.team ?? null) : null;
    const g = team ? games.get(team) : undefined;
    // ESPN's own projection, in this league's exact scoring — one source for the whole lineup.
    // Mixing ESPN and Sleeper projections inside one comparison biases every swap between them.
    let mu = Number((pl.stats ?? []).find((s: Json) => s.statSourceId === 1 && s.scoringPeriodId === period)?.appliedTotal ?? 0);
    let sd = sigmaOf(sigma, pos, mu);
    const espnSt = pl.injuryStatus as string | null;
    const fromEspn = espnSt === 'QUESTIONABLE' ? 'Questionable' : espnSt === 'DOUBTFUL' ? 'Doubtful'
      : espnSt === 'OUT' ? 'Out' : espnSt === 'INJURY_RESERVE' ? 'IR' : null;
    const fromSleeper = sid ? ((players[sid]?.injury_status as string | null) ?? null) : null;
    const rank = (k: string | null) => (k === null ? 0 : k === 'Questionable' ? 1 : k === 'Doubtful' ? 2 : 3);
    const key = rank(fromSleeper) > rank(fromEspn) ? fromSleeper : fromEspn;
    if (key && STATUS[key]) { mu *= STATUS[key].muMult; sd *= STATUS[key].sdMult; }
    const done = g ? g.status === 'complete' : false;
    const locked = !!e.playerPoolEntry?.lineupLocked || (g ? g.status !== 'pre_game' : false);
    const actual = (pl.stats ?? []).find((s: Json) => s.statSourceId === 0 && s.scoringPeriodId === period)?.appliedTotal;
    if (done) { mu = Number(actual ?? mu); sd = 0; }
    return { id: String(pl.id), name: pl.fullName, pos, team, opp: g?.opp ?? null, status: key, mu, sd, locked, done,
      slot: ESPN_SLOTS[e.lineupSlotId], eligible: pl.eligibleSlots ?? [] };
  };

  const teamEntries = (tid: number): Json[] => rosterView.teams.find((t: Json) => t.id === tid)?.roster?.entries ?? [];
  const mineAll = teamEntries(lg.teamId).map(entryToP);
  const counts: Record<string, number> = meta.settings.rosterSettings.lineupSlotCounts;
  const slotIds = Object.entries(counts).flatMap(([id, n]) => (Number(id) === 20 || Number(id) === 21 ? [] : Array(Number(n)).fill(Number(id))));
  const slots: Slot[] = slotIds.map((sid, idx) => ({
    idx, name: ESPN_SLOTS[sid] ?? String(sid),
    allows: (p: P) => (p.eligible ?? []).includes(sid),
  }));
  // seat current starters into their slots
  const starters: (P | null)[] = Array(slots.length).fill(null);
  const used = new Set<P>();
  for (let i = 0; i < slotIds.length; i++) {
    const p = mineAll.find((x) => !used.has(x) && x.slot === ESPN_SLOTS[slotIds[i]]);
    if (p) { starters[i] = p; used.add(p); }
  }
  const bench = mineAll.filter((p) => !used.has(p) && p.slot !== 'IR');
  const oppStarters = teamEntries(oppId).map(entryToP).filter((p) => p.slot !== 'Bench' && p.slot !== 'IR');
  const oppName = meta.teams.find((t: Json) => t.id === oppId)?.name ?? `team ${oppId}`;
  return { week: period, leagueName: meta.settings.name, slots, starters, bench, opp: oppStarters, sigma, oppName };
}

// ---------------------------------------------------------------- report

const f1 = (x: number) => x.toFixed(1);
const pp = (x: number) => `${(x * 100).toFixed(1)}%`;

async function run(lg: League, weekArg?: number, json = false) {
  const b = lg.platform === 'sleeper' ? await sleeperBoard(lg, weekArg) : await espnBoard(lg, weekArg);
  const cur = b.starters.filter(Boolean) as P[];
  const curWp = winProb(cur, b.opp);
  const { lineup, wp } = optimize(b.slots, b.starters, b.bench, b.opp);
  const opt = lineup.filter(Boolean) as P[];
  const mT = total(opt), cT = total(cur), oT = total(b.opp);
  const z = (cT.mu - oT.mu) / Math.sqrt(cT.sd ** 2 + oT.sd ** 2);

  // Report who starts and who sits, not slot churn: moving a player between two
  // interchangeable slots changes nothing and reads as a phantom swap.
  const before = new Set(cur.map((p) => p.id));
  const after = new Set((lineup.filter(Boolean) as P[]).map((p) => p.id));
  const benched = cur.filter((p) => !after.has(p.id));
  const started = (lineup.filter(Boolean) as P[]).filter((p) => !before.has(p.id));
  const desc = (p: P) => ({ name: p.name, proj: +f1(p.mu), sd: +f1(p.sd), status: p.status, pos: p.pos });
  const changes = started.map((inP, i) => ({ in: desc(inP), out: benched[i] ? desc(benched[i]) : null }))
    .concat(benched.slice(started.length).map((outP) => ({ in: null as Json, out: desc(outP) })));
  const deltaPP = (wp - curWp) * 100;

  // Attribution, leave-one-out: take the OPTIMAL lineup and revert this one start/sit pair
  // back to the current starter. The drop in win probability is what that single move buys.
  // Leave-one-out handles cross-slot moves (a WR replaced by an RB via the flex) that a
  // like-for-like slot swap cannot express.
  const optimal = lineup.filter(Boolean) as P[];
  const marginal = changes.map((c) => {
    if (!c.in || !c.out) return { ...c, winProbGainPP: null as number | null, call: 'forced (unavailable player)' };
    const reverted = optimal.map((p) => (p.name === c.in!.name ? cur.find((x) => x.name === c.out!.name)! : p));
    const gain = (wp - winProb(reverted, b.opp)) * 100;
    return { ...c, winProbGainPP: +gain.toFixed(2), call: Math.abs(gain) < DEAD_BAND_PP ? 'dead band — judgment call' : 'math call' };
  });

  const report = {
    league: b.leagueName, alias: lg.alias, week: b.week, opponent: b.oppName,
    posture: z >= 0.15 ? 'favored — protect the floor' : z <= -0.15 ? 'underdog — buy variance' : 'coin flip — maximize points',
    z: +z.toFixed(2),
    current: { projected: +f1(cT.mu), sd: +f1(cT.sd), winProb: pp(curWp) },
    opponent_projected: +f1(oT.mu), opponent_sd: +f1(oT.sd),
    optimal: { projected: +f1(mT.mu), sd: +f1(mT.sd), winProb: pp(wp) },
    winProbGainPP: +deltaPP.toFixed(2),
    verdict: changes.length === 0 ? 'lineup already optimal' : deltaPP < DEAD_BAND_PP ? `inside the dead band (<${DEAD_BAND_PP}pp) — judgment call, not a math call` : 'take the swap',
    changes: marginal,
    sigmaFit: Object.fromEntries(Object.entries(b.sigma).map(([k, v]) => [k, `sd ≈ ${f1(v.a)} + ${v.b.toFixed(2)}·proj (n=${v.n})`])),
    lineup: lineup.map((p, i) => ({ slot: b.slots[i].name, player: p?.name ?? '—', proj: p ? +f1(p.mu) : 0, sd: p ? +f1(p.sd) : 0, status: p?.status ?? null, state: p?.done ? 'played (banked)' : p?.locked ? 'locked' : undefined })),
    assumptions: 'sd fitted from historical weekly (actual − projected) in this league scoring; injury multipliers and correlations are stated constants in optimize.ts',
  };
  if (json) return report;
  return report;
}

export async function main(argv: string[]) {
  const flag = (k: string) => {
    const inline = argv.find((a) => a.startsWith(`--${k}=`));
    if (inline !== undefined) return inline.slice(k.length + 3);
    const i = argv.indexOf(`--${k}`);
    return i >= 0 ? (argv[i + 1] ?? '') : undefined;
  };
  const week = flag('week') ? Number(flag('week')) : undefined;
  const leagues: League[] = loadConfig(flag('config'));
  const target = argv.find((a, i) => !a.startsWith('--') && !(i > 0 && argv[i - 1].startsWith('--')));
  const chosen = target && target !== 'all' ? [resolveLeague(target, leagues)] : leagues;
  const out: Json[] = [];
  for (const lg of chosen) {
    try {
      out.push(await run(lg, week));
    } catch (e) {
      out.push({ alias: lg.alias, error: errorText(e) });
    }
  }
  console.log(redact(JSON.stringify(out.length === 1 ? out[0] : out, null, 2)));
}

if (import.meta.main) {
  main(process.argv.slice(2)).catch((e) => {
    console.error(`error: ${errorText(e)}`);
    process.exit(1);
  });
}
