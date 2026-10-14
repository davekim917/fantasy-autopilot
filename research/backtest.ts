#!/usr/bin/env bun
/**
 * Out-of-sample backtest: our bottom-up mean vs the platform's own projection,
 * scored against what actually happened. Usage for week W is built ONLY from
 * games before week W, so nothing leaks.
 */
import { buildHistory, buildUsage, buildTeamProfiles, defenseAdj, simulate, players, weekly, schedule, seed, num } from './engine.ts';
import { oddsFor } from './odds.ts';
const USE_VEGAS = process.env.VEGAS !== '0';

const PPR = {
  pass_yd: 0.04, pass_td: 4, pass_int: -1, pass_2pt: 2,
  rush_yd: 0.1, rush_td: 6, rush_2pt: 2,
  rec: 1, rec_yd: 0.1, rec_td: 6, rec_2pt: 2, fum_lost: -2,
};

const N = Number(process.env.SIMS ?? 1200);
const FIRST = 5, LAST = 18;

const mean = (a: number[]) => a.reduce((x, y) => x + y, 0) / (a.length || 1);
const quantile = (sorted: Float64Array, q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];

const weeks = [];
for (let w = 1; w <= 18; w++) weeks.push({ season: 2025, week: w });

const meta = await players();
const hist = await buildHistory(weeks);
const sched = await schedule(2025);

type Row = { pos: string; ours: number; theirs: number; actual: number; p10: number; p50: number; p90: number; sd: number };
/** The blend weight lineup.ts ships with; reported per position so the choice is visible. */
const W_OURS = Number(process.env.W_OURS ?? 0.4);
const blend = (r: Row) => W_OURS * r.ours + (1 - W_OURS) * r.theirs;
const rows: Row[] = [];

for (let w = FIRST; w <= LAST; w++) {
  seed(1000 + w);
  const usage = buildUsage(hist, meta, 2025, w);
  const teamProf = buildTeamProfiles(hist, 2025, w);
  const dAdj = defenseAdj(hist, 2025, w);
  const games = sched.filter((g: any) => g.week === w).map((g: any) => ({ home: g.home, away: g.away }));

  const proj = await weekly('projections', 2025, w);
  const stats = await weekly('stats', 2025, w);

  // startable universe: the platform thought they were worth considering
  // Who suits up is known at kickoff (inactives are posted 90 min before), so the
  // share pool uses the set that played — the same information a manager has.
  const active = new Set<string>();
  for (const [pid, line] of Object.entries(stats) as [string, any][]) if (num(line.gp)) active.add(pid);

  const keep = new Set<string>();
  for (const [pid, line] of Object.entries(proj) as [string, any][]) {
    const m = meta[pid];
    if (!m || !['QB', 'RB', 'WR', 'TE'].includes(m.position)) continue;
    if (num(line.pts_ppr) < 5) continue;
    if (!stats[pid] || !num(stats[pid].gp)) continue;  // must have actually played
    keep.add(pid);
  }

  const odds = USE_VEGAS ? await oddsFor(2025, w) : undefined;
  const { samples, source } = simulate({
    usage, teamProf, defAdj: dAdj, games, scoring: PPR, keep,
    fallback: new Map(), active, odds, n: N,
  });

  for (const pid of keep) {
    if (source.get(pid) !== 'model') continue;
    const s = samples.get(pid)!;
    const sorted = Float64Array.from(s).sort();
    const mu = mean(Array.from(s));
    const sd = Math.sqrt(mean(Array.from(s).map((v) => (v - mu) ** 2)));
    rows.push({
      sd,
      pos: meta[pid].position,
      ours: mu,
      theirs: num(proj[pid].pts_ppr),
      actual: num(stats[pid].pts_ppr),
      p10: quantile(sorted, 0.10), p50: quantile(sorted, 0.50), p90: quantile(sorted, 0.90),
    });
  }
  process.stderr.write(`week ${w}: ${rows.length} player-weeks\n`);
}

function report(label: string, rs: Row[]) {
  if (!rs.length) return null;
  const mae = (f: (r: Row) => number) => mean(rs.map((r) => Math.abs(f(r) - r.actual)));
  const rmse = (f: (r: Row) => number) => Math.sqrt(mean(rs.map((r) => (f(r) - r.actual) ** 2)));
  const corr = (f: (r: Row) => number) => {
    const x = rs.map(f), y = rs.map((r) => r.actual);
    const mx = mean(x), my = mean(y);
    const sxy = mean(x.map((v, i) => (v - mx) * (y[i] - my)));
    const sx = Math.sqrt(mean(x.map((v) => (v - mx) ** 2))), sy = Math.sqrt(mean(y.map((v) => (v - my) ** 2)));
    return sxy / (sx * sy || 1);
  };
  const within = mean(rs.map((r) => (r.actual >= r.p10 && r.actual <= r.p90 ? 1 : 0)));
  const below50 = mean(rs.map((r) => (r.actual <= r.p50 ? 1 : 0)));
  // How wide SHOULD the marginals be? Compare realized error sd to simulated sd.
  const simSd = Math.sqrt(mean(rs.map((r) => r.sd ** 2)));
  const errSd = Math.sqrt(mean(rs.map((r) => (r.ours - r.actual) ** 2)));
  return {
    label, n: rs.length,
    widthNeeded: +(errSd / (simSd || 1)).toFixed(3),
    ours: { mae: +mae((r) => r.ours).toFixed(3), rmse: +rmse((r) => r.ours).toFixed(3), corr: +corr((r) => r.ours).toFixed(3), bias: +mean(rs.map((r) => r.ours - r.actual)).toFixed(2) },
    platform: { mae: +mae((r) => r.theirs).toFixed(3), rmse: +rmse((r) => r.theirs).toFixed(3), corr: +corr((r) => r.theirs).toFixed(3), bias: +mean(rs.map((r) => r.theirs - r.actual)).toFixed(2) },
    blend: { mae: +mae(blend).toFixed(3), rmse: +rmse(blend).toFixed(3), corr: +corr(blend).toFixed(3), bias: +mean(rs.map((r) => blend(r) - r.actual)).toFixed(2) },
    calibration: { pctInside80: +(within * 100).toFixed(1), pctBelowMedian: +(below50 * 100).toFixed(1) },
  };
}

// ensemble: is the honest best answer a blend rather than either alone?
for (const wOurs of [0.3, 0.5, 0.7]) {
  const blended = rows.map((r) => ({ ...r, ours: wOurs * r.ours + (1 - wOurs) * r.theirs }));
  const rep = report(`BLEND ${wOurs}`, blended)!;
  process.stderr.write(`blend ${wOurs}: mae ${rep.ours.mae} rmse ${rep.ours.rmse} corr ${rep.ours.corr}\n`);
}
const out = [report('ALL', rows)];
for (const p of ['QB', 'RB', 'WR', 'TE']) out.push(report(p, rows.filter((r) => r.pos === p)));
console.log(JSON.stringify({ sims: N, weeks: `2025 W${FIRST}-W${LAST}`, vegas: USE_VEGAS, blendWeightOurs: W_OURS, results: out.filter(Boolean) }, null, 2));
