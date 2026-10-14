#!/usr/bin/env bun
import {
  runSim, calibrate, winProb, optimize, meta, liveProj, liveStats, kickedOff,
  mean, sdOf, scoringFamily, ESPN_HEADERS, ESPN_STAT_KEY, http, SLEEPER, N, WEEK, W_OURS, WIDTH,
  actualPts, type Seat,
} from './lineup.ts';
import { num, type Scoring } from './engine.ts';
import { loadConfig } from '../skills/fantasy-football/leagues.ts';

const leagues = loadConfig();

const ELIG: Record<string, string[]> = {
  QB: ['QB'], RB: ['RB'], WR: ['WR'], TE: ['TE'], K: ['K'], DEF: ['DEF'], 'D/ST': ['DEF'],
  FLEX: ['RB', 'WR', 'TE'], WRRB_FLEX: ['RB', 'WR'], REC_FLEX: ['WR', 'TE'],
  SUPER_FLEX: ['QB', 'RB', 'WR', 'TE'],
};
const posOf = (pid: string) => (meta[pid]?.position === 'FB' ? 'RB' : meta[pid]?.position ?? '?');
const seatOf = (pid: string, slot: string, scoring?: any, family = 'ppr'): Seat => {
  const team = meta[pid]?.team;
  const done = !!(team && kickedOff.has(team));
  return {
    pid, name: meta[pid]?.full_name ?? (meta[pid]?.position === 'DEF' ? `${pid} DST` : pid),
    pos: posOf(pid), slot, locked: done, done,
    actual: done ? actualPts(pid, family, scoring) : 0,
  };
};

async function sleeperLeague(alias: string, leagueId: string, rosterId: number) {
  const [lg, rosters, matchups] = await Promise.all([
    http(`${SLEEPER}/league/${leagueId}`),
    http(`${SLEEPER}/league/${leagueId}/rosters`),
    http(`${SLEEPER}/league/${leagueId}/matchups/${WEEK}`),
  ]);
  const scoring: Scoring = lg.scoring_settings;
  const family = scoringFamily(scoring);
  const slotNames: string[] = lg.roster_positions.filter((s: string) => !['BN', 'IR', 'TAXI'].includes(s));
  const mine = rosters.find((r: any) => r.roster_id === rosterId);
  const myM = matchups.find((m: any) => m.roster_id === rosterId);
  const oppM = matchups.find((m: any) => m.matchup_id === myM?.matchup_id && m.roster_id !== rosterId);
  const oppStarters: string[] = (oppM?.starters ?? []).filter((p: string) => p && p !== '0');

  const reserve: string[] = [...(mine.reserve ?? []), ...(mine.taxi ?? [])];
  const rosterIds: string[] = (mine.players ?? []).filter((p: string) => !reserve.includes(p));
  const curStarters: string[] = (myM?.starters ?? []).filter((p: string) => p && p !== '0');

  const keep = new Set<string>([...rosterIds, ...oppStarters]);
  const { samples, source } = runSim(scoring, keep, family);

  const S = new Map<string, Float64Array>();
  const info = new Map<string, { mu: number; plat: number; src: string }>();
  for (const pid of keep) {
    const raw = samples.get(pid);
    if (!raw) continue;
    const isModel = source.get(pid) === 'model' && !['K', 'DEF'].includes(posOf(pid));
    const c = calibrate(raw, pid, family, isModel, scoring);
    S.set(pid, c.arr);
    info.set(pid, { mu: c.mu, plat: c.plat, src: isModel ? 'model' : 'platform' });
  }

  const slots = slotNames.map((name) => ({ name, allows: (s: Seat) => (ELIG[name] ?? [name]).includes(s.pos) }));
  const roster = rosterIds.map((p) => seatOf(p, 'BN', scoring, family));
  const byPid = new Map(roster.map((s) => [s.pid, s]));
  const start: (Seat | null)[] = slotNames.map((name, i) => {
    const pid = curStarters[i];
    return pid && byPid.has(pid) ? byPid.get(pid)! : null;
  });

  const oppSeats = oppStarters.map((p) => seatOf(p, 'S', scoring, family));
  const bankOpp = oppSeats.filter((s) => s.done).reduce((a, s) => a + s.actual, 0);
  const oppLive = oppSeats.filter((s) => !s.done).map((s) => S.get(s.pid)!).filter(Boolean);

  const bankedMine = (l: (Seat | null)[]) => l.reduce((a, s) => a + (s?.done ? s.actual : 0), 0);
  const liveMine = (l: (Seat | null)[]) => l.filter((s): s is Seat => !!s && !s.done).map((s) => S.get(s.pid)!).filter(Boolean);
  const curWp = winProb(liveMine(start), oppLive, bankedMine(start), bankOpp);
  const { lineup, wp } = optimize(slots, start, roster, oppLive, 0, bankOpp, S);

  const show = (s: Seat | null, i: number) => s && ({
    slot: slotNames[i], player: s.name, pos: s.pos,
    mean: +(s.done ? s.actual : info.get(s.pid)?.mu ?? 0).toFixed(1),
    platform: +(info.get(s.pid)?.plat ?? 0).toFixed(1),
    src: s.done ? 'played' : info.get(s.pid)?.src,
  });
  const beforeIds = new Set(start.filter(Boolean).map((s) => s!.pid));
  const afterIds = new Set(lineup.filter(Boolean).map((s) => s!.pid));
  const changes = [
    ...lineup.filter((s) => s && !beforeIds.has(s.pid)).map((s) => ({ in: s!.name, mean: +(info.get(s!.pid)?.mu ?? 0).toFixed(1) })),
    ...start.filter((s) => s && !afterIds.has(s.pid)).map((s) => ({ out: s!.name, mean: +(info.get(s!.pid)?.mu ?? 0).toFixed(1) })),
  ];

  const tot = (l: (Seat | null)[]) => {
    const live = liveMine(l), bank = bankedMine(l);
    const sums = new Float64Array(N);
    for (let i = 0; i < N; i++) { let a = bank; for (const s of live) a += s[i]; sums[i] = a; }
    const m = mean(sums);
    return { mean: +m.toFixed(1), sd: +sdOf(sums, m).toFixed(1) };
  };
  const oppTot = (() => {
    const sums = new Float64Array(N);
    for (let i = 0; i < N; i++) { let a = bankOpp; for (const s of oppLive) a += s[i]; sums[i] = a; }
    const m = mean(sums);
    return { mean: +m.toFixed(1), sd: +sdOf(sums, m).toFixed(1) };
  })();

  return {
    league: lg.name, alias, week: WEEK, opponent: `roster ${oppM?.roster_id ?? '?'}`,
    me: tot(start), optimal: tot(lineup), opponent_total: oppTot,
    winProbCurrent: +(curWp * 100).toFixed(1), winProbOptimal: +(wp * 100).toFixed(1),
    gainPP: +((wp - curWp) * 100).toFixed(1),
    changes,
    lineup: lineup.map(show).filter(Boolean),
  };
}

const which = process.argv[2] ?? 'all';
const out: any[] = [];

// ---------------------------------------------------------------- ESPN

const ESPN_SLOT: Record<number, { name: string; allows: string[] }> = {
  0: { name: 'QB', allows: ['QB'] },
  2: { name: 'RB', allows: ['RB'] },
  3: { name: 'RB/WR', allows: ['RB', 'WR'] },
  4: { name: 'WR', allows: ['WR'] },
  5: { name: 'WR/TE', allows: ['WR', 'TE'] },
  6: { name: 'TE', allows: ['TE'] },
  7: { name: 'OP', allows: ['QB', 'RB', 'WR', 'TE'] },
  16: { name: 'D/ST', allows: ['DEF'] },
  17: { name: 'K', allows: ['K'] },
  23: { name: 'FLEX', allows: ['RB', 'WR', 'TE'] },
};
const ESPN_POS: Record<number, string> = { 1: 'QB', 2: 'RB', 3: 'WR', 4: 'TE', 5: 'K', 16: 'DEF' };

async function espnLeague(alias: string, leagueId: string, teamId: number) {
  const base = `https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/2026/segments/0/leagues/${leagueId}`;
  const [settings, rosterView, matchupView] = await Promise.all([
    http(`${base}?view=mSettings`, { headers: ESPN_HEADERS }),
    http(`${base}?view=mRoster&scoringPeriodId=${WEEK}`, { headers: ESPN_HEADERS }),
    http(`${base}?view=mMatchup&scoringPeriodId=${WEEK}`, { headers: ESPN_HEADERS }),
  ]);

  // ESPN scoring -> the same stat keys the simulator emits
  const scoring: any = {};
  for (const it of settings.settings.scoringSettings.scoringItems ?? []) {
    const k = ESPN_STAT_KEY[it.statId];
    if (k) scoring[k] = it.points;
  }
  const family = scoringFamily(scoring);

  const counts: Record<string, number> = settings.settings.rosterSettings.lineupSlotCounts ?? {};
  const slotIds: number[] = [];
  for (const [id, cnt] of Object.entries(counts)) {
    const n = Number(cnt), sid = Number(id);
    if (!ESPN_SLOT[sid]) continue;
    for (let i = 0; i < n; i++) slotIds.push(sid);
  }

  // espn player id -> sleeper pid. espn_id is null for a lot of current players
  // (Ja'Marr Chase among them), so fall back to a normalised name+position join.
  const bySleeper = new Map<number, string>();
  const byName = new Map<string, string>();
  const norm = (s: string) => (s ?? '').toLowerCase().replace(/[^a-z ]/g, '').replace(/ (jr|sr|ii|iii|iv|v)$/, '').trim();
  for (const [pid, m] of Object.entries(meta) as [string, any][]) {
    if (m.espn_id) bySleeper.set(Number(m.espn_id), pid);
    if (m.full_name && m.position && m.team) byName.set(`${norm(m.full_name)}|${m.position}`, pid);
  }
  const resolve = (pl: any, pos: string) => bySleeper.get(Number(pl.id)) ?? byName.get(`${norm(pl.fullName)}|${pos}`);

  const teams = rosterView.teams ?? [];
  const mine = teams.find((t: any) => t.id === teamId);
  const game = (matchupView.schedule ?? []).find((g: any) => g.matchupPeriodId === WEEK && (g.home?.teamId === teamId || g.away?.teamId === teamId));
  const oppId = game ? (game.home?.teamId === teamId ? game.away?.teamId : game.home?.teamId) : null;
  const oppTeam = teams.find((t: any) => t.id === oppId);

  type E = { key: string; name: string; pos: string; slotId: number; proj: number; done: boolean; actual: number };
  const parse = (t: any): E[] => (t?.roster?.entries ?? []).map((en: any) => {
    const pl = en.playerPoolEntry?.player ?? en.player;
    const stats = pl.stats ?? [];
    const proj = Number(stats.find((s: any) => s.statSourceId === 1 && s.scoringPeriodId === WEEK)?.appliedTotal ?? 0);
    const real = stats.find((s: any) => s.statSourceId === 0 && s.scoringPeriodId === WEEK);
    const pos = ESPN_POS[pl.defaultPositionId] ?? '?';
    const sid = resolve(pl, pos);
    return {
      key: sid ?? `espn:${pl.id}`, name: pl.fullName, pos, slotId: en.lineupSlotId,
      proj, done: !!real, actual: Number(real?.appliedTotal ?? 0),
    };
  });
  const myEntries = parse(mine).filter((e) => e.slotId !== 21);
  const oppEntries = parse(oppTeam).filter((e) => ESPN_SLOT[e.slotId]);

  const keep = new Set<string>([...myEntries, ...oppEntries].map((e) => e.key));
  // ESPN's own projection is the fallback for anything the model can't build:
  // D/ST, K, and any player with no Sleeper usage history.
  const espnProj = new Map<string, number>();
  for (const e of [...myEntries, ...oppEntries]) espnProj.set(e.key, e.proj);

  const { samples, source } = runSim(scoring, keep, family);
  // overwrite fallback draws with ESPN's number where we have no model
  for (const [key, arr] of samples) {
    const isModel = source.get(key) === 'model' && !key.startsWith('espn:');
    if (isModel) continue;
    const mu = espnProj.get(key) ?? 0;
    const sd = Math.max(3, 0.5 * mu + 2);
    for (let i = 0; i < arr.length; i++) arr[i] = Math.max(0, mu + sd * (Math.random() * 2 - 1) * 1.7);
  }

  const S = new Map<string, Float64Array>();
  const info = new Map<string, { mu: number; plat: number; src: string }>();
  for (const key of keep) {
    const raw = samples.get(key);
    if (!raw) continue;
    const isModel = source.get(key) === 'model' && !key.startsWith('espn:');
    const m = mean(raw);
    const plat = espnProj.get(key) ?? 0;
    const target = isModel && plat > 0 ? W_OURS * m + (1 - W_OURS) * plat : (isModel ? m : plat);
    const out = new Float64Array(raw.length);
    for (let i = 0; i < raw.length; i++) out[i] = Math.max(0, target + (raw[i] - m) * WIDTH);
    S.set(key, out);
    info.set(key, { mu: target, plat, src: isModel ? 'model' : 'espn' });
  }

  const toSeat = (e: E): Seat => ({ pid: e.key, name: e.name, pos: e.pos, slot: String(e.slotId), locked: e.done, done: e.done, actual: e.actual });
  const roster = myEntries.map(toSeat);
  const byKey = new Map(roster.map((s) => [s.pid, s]));
  const slots = slotIds.map((sid) => ({ name: ESPN_SLOT[sid].name, allows: (s: Seat) => ESPN_SLOT[sid].allows.includes(s.pos) }));

  // seat the current lineup into matching slots
  const start: (Seat | null)[] = new Array(slotIds.length).fill(null);
  const used = new Set<string>();
  slotIds.forEach((sid, i) => {
    const e = myEntries.find((x) => x.slotId === sid && !used.has(x.key));
    if (e) { start[i] = byKey.get(e.key)!; used.add(e.key); }
  });

  const oppSeats = oppEntries.map(toSeat);
  const bankOpp = oppSeats.filter((s) => s.done).reduce((a, s) => a + s.actual, 0);
  const oppLive = oppSeats.filter((s) => !s.done).map((s) => S.get(s.pid)!).filter(Boolean);
  const bankedMine = (l: (Seat | null)[]) => l.reduce((a, s) => a + (s?.done ? s.actual : 0), 0);
  const liveMine = (l: (Seat | null)[]) => l.filter((s): s is Seat => !!s && !s.done).map((s) => S.get(s.pid)!).filter(Boolean);
  const curWp = winProb(liveMine(start), oppLive, bankedMine(start), bankOpp);
  const { lineup, wp } = optimize(slots, start, roster, oppLive, 0, bankOpp, S);

  const beforeIds = new Set(start.filter(Boolean).map((s) => s!.pid));
  const afterIds = new Set(lineup.filter(Boolean).map((s) => s!.pid));
  const tot = (l: (Seat | null)[]) => {
    const live = liveMine(l), bank = bankedMine(l);
    const sums = new Float64Array(N);
    for (let i = 0; i < N; i++) { let a = bank; for (const s of live) a += s[i]; sums[i] = a; }
    const m = mean(sums);
    return { mean: +m.toFixed(1), sd: +sdOf(sums, m).toFixed(1) };
  };
  const oppSums = new Float64Array(N);
  for (let i = 0; i < N; i++) { let a = bankOpp; for (const s of oppLive) a += s[i]; oppSums[i] = a; }
  const om = mean(oppSums);

  return {
    league: settings.settings.name, alias, week: WEEK, opponent: oppTeam?.name ?? `team ${oppId}`,
    me: tot(start), optimal: tot(lineup), opponent_total: { mean: +om.toFixed(1), sd: +sdOf(oppSums, om).toFixed(1) },
    winProbCurrent: +(curWp * 100).toFixed(1), winProbOptimal: +(wp * 100).toFixed(1),
    gainPP: +((wp - curWp) * 100).toFixed(1),
    changes: [
      ...lineup.filter((s) => s && !beforeIds.has(s.pid)).map((s) => ({ in: s!.name, mean: +(info.get(s!.pid)?.mu ?? 0).toFixed(1) })),
      ...start.filter((s) => s && !afterIds.has(s.pid)).map((s) => ({ out: s!.name, mean: +(info.get(s!.pid)?.mu ?? 0).toFixed(1) })),
    ],
    lineup: lineup.map((s, i) => s && ({
      slot: ESPN_SLOT[slotIds[i]].name, player: s.name, pos: s.pos,
      mean: +(s.done ? s.actual : info.get(s.pid)?.mu ?? 0).toFixed(1),
      platform: +(info.get(s.pid)?.plat ?? 0).toFixed(1),
      src: s.done ? 'played' : info.get(s.pid)?.src,
    })).filter(Boolean),
  };
}
for (const lg of leagues) {
  if (which !== 'all' && which !== lg.alias) continue;
  out.push(lg.platform === 'sleeper' ? await sleeperLeague(lg.alias, lg.leagueId, lg.rosterId) : await espnLeague(lg.alias, lg.leagueId, lg.teamId));
}
console.log(JSON.stringify({ sims: N, blendWeightOurs: W_OURS, widthScale: WIDTH, leagues: out }, null, 2));
