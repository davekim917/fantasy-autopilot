#!/usr/bin/env bun
/**
 * Fantasy football management CLI for the leagues in your config.
 *
 * Credentials come from SLEEPER_TOKEN / ESPN_S2 / ESPN_SWID, or from a proxy that
 * injects them when those are unset (gateway mode). Public reads (api.sleeper.app,
 * site.api.espn.com) need no credential.
 *
 * Every write is a dry run unless --confirm is passed, re-reads live state
 * first, and reads back afterwards. Trades are draft-only: nothing here can
 * send a trade proposal.
 */
import { cacheDir, credentialMode, errorText, fail, http, loadConfig, redact, rejected, resolveLeague, type EspnLeague, type League, type SleeperLeague } from './leagues.ts';

type Json = any;
declare const Bun: any;

// ---------------------------------------------------------------- helpers

function out(v: Json) {
  console.log(redact(JSON.stringify(v, null, 2)));
}

/** auth-check runs the same ownership gate a write would, without writing. */
async function writeGate(check: () => Promise<void>) {
  try {
    await check();
    return { allowed: true };
  } catch (e) {
    return { allowed: false, reason: errorText(e) };
  }
}

function parseFlags(argv: string[]) {
  const positional: string[] = [];
  const flags: Record<string, string[]> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const [k, inline] = a.slice(2).split('=', 2);
      const next = argv[i + 1];
      const v = inline ?? (next !== undefined && !next.startsWith('--') ? (i++, next) : 'true');
      (flags[k] ??= []).push(v);
    } else positional.push(a);
  }
  const one = (k: string) => flags[k]?.at(-1);
  const list = (k: string) => (flags[k] ?? []).flatMap((v) => v.split(',')).map((s) => s.trim()).filter(Boolean);
  return { positional, flags, one, list, has: (k: string) => k in flags };
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

function pickPlayer<T>(query: string, pool: T[], id: (p: T) => string, name: (p: T) => string, what: string): T {
  const byId = pool.find((p) => id(p) === query);
  if (byId) return byId;
  const q = norm(query);
  const exact = pool.filter((p) => norm(name(p)) === q);
  if (exact.length === 1) return exact[0];
  const partial = pool.filter((p) => norm(name(p)).includes(q));
  if (partial.length === 1) return partial[0];
  if (partial.length > 1) fail(`"${query}" is ambiguous in ${what}: ${partial.slice(0, 8).map((p) => `${name(p)} (${id(p)})`).join(', ')}`);
  fail(`"${query}" not found in ${what}`);
}

// ---------------------------------------------------------------- NFL game locks (public)

/** Sleeper's public schedule, keyed by Sleeper team code. A player is locked once his game is not pre_game. */
async function nflGameStates(season: string | number, week: number): Promise<Map<string, { state: string; date: string }>> {
  const games = await http(`https://api.sleeper.app/schedule/nfl/regular/${season}`);
  const m = new Map<string, { state: string; date: string }>();
  for (const g of games ?? []) {
    if (g.week !== week) continue;
    for (const t of [g.home, g.away]) m.set(t, { state: g.status, date: g.date });
  }
  if (m.size === 0) fail(`no NFL schedule for ${season} week ${week}; cannot verify game locks`);
  return m;
}

// ================================================================= SLEEPER

const SLEEPER_API = 'https://api.sleeper.app/v1';

/**
 * Sleeper's public REST API sits behind Cloudflare with s-maxage 60 (matchups) to 300 (league,
 * rosters) plus stale-while-revalidate 300, so a bare GET can return state up to ~10 minutes old —
 * including a pre-write lineup seconds after a successful write. A unique query string is a cache
 * MISS at the edge (verified: Cf-Cache-Status), so every read here carries one.
 */
function sapi(pathAndQuery: string, init?: Parameters<typeof http>[1]): Promise<Json> {
  const sep = pathAndQuery.includes('?') ? '&' : '?';
  return http(`${SLEEPER_API}${pathAndQuery}${sep}_=${Date.now()}${Math.random().toString(36).slice(2, 8)}`, { ...init, headers: { ...(init?.headers as Json), 'cache-control': 'no-cache' } });
}

/** Post-write readback: retry a fresh read a few times before declaring a mismatch. */
async function settle(check: () => Promise<boolean>, attempts = 4, delayMs = 1500): Promise<boolean> {
  for (let i = 0; i < attempts; i++) {
    if (await check()) return true;
    if (i < attempts - 1) await new Promise((r) => setTimeout(r, delayMs));
  }
  return false;
}
const SLEEPER_GQL = 'https://sleeper.com/graphql';
const SLEEPER_OPS = new Set(['me', 'league_transactions_filtered', 'update_matchup_leg', 'roster_update_reserve', 'submit_waiver_claim', 'cancel_waiver_claim', 'league_create_transaction']);
const SLEEPER_ME_QUERY = 'query me { me { user_id display_name } }';

export const sleeperDropQuery = (leagueId: string) => `mutation league_create_transaction($k_drops: [String], $v_drops: [Int]) {
        league_create_transaction(league_id: "${leagueId}",type: "free_agent",k_adds: [],v_adds: [],k_drops: $k_drops,v_drops: $v_drops){
          transaction_id status type adds drops
        }
      }`;

/** Refuses any GraphQL body that names a league or roster outside this allowlisted account. */
export function assertSleeperBody(body: { operationName: string; variables: Json; query: string }, lg: SleeperLeague) {
  if (!SLEEPER_OPS.has(body.operationName)) fail(`Sleeper operation "${body.operationName}" is not permitted`);
  const opInQuery = body.query.match(/^\s*(?:query|mutation)\s+(\w+)/)?.[1];
  if (opInQuery !== body.operationName) fail('Sleeper operationName does not match query');
  if (body.operationName === 'me') {
    if (body.query !== SLEEPER_ME_QUERY || Object.keys(body.variables ?? {}).length) fail('Sleeper me must be the canonical identity query');
    return;
  }
  if (body.query.includes('#')) fail('Sleeper query must not contain comments');
  for (const op of SLEEPER_OPS) if (op !== body.operationName && new RegExp(`\\b${op}[\\s,]*\\(`).test(body.query)) fail(`Sleeper ${body.operationName} body must not call ${op}`);
  for (const m of body.query.matchAll(/(league_id|roster_id)[\s,]*:[\s,]*\$(\w+)/g)) {
    const v = body.variables?.[m[2]];
    const allowed = m[1] === 'league_id' ? lg.leagueId : String(lg.rosterId);
    if (String(v) !== allowed) fail(`Sleeper ${m[1]} variable $${m[2]}=${v}; allowed ${allowed}`);
  }
  const text = body.query + JSON.stringify(body.variables ?? {});
  const leagueIds = [...text.matchAll(/league_id"?[\s,]*[:=][\s,]*\\?"(\d+)\\?"/g)].map((m) => m[1]);
  if (leagueIds.length === 0) fail('Sleeper body has no league_id');
  for (const id of leagueIds) if (id !== lg.leagueId) fail(`Sleeper body targets league ${id}; allowed ${lg.leagueId}`);
  for (const m of text.matchAll(/roster_id"?[\s,]*[:=][\s,]*(\d+)/g)) if (Number(m[1]) !== lg.rosterId) fail(`Sleeper body targets roster ${m[1]}; allowed ${lg.rosterId}`);
  for (const k of ['v_adds', 'v_drops', 'roster_id_filters']) {
    for (const v of body.variables?.[k] ?? []) if (Number(v) !== lg.rosterId) fail(`Sleeper ${k} targets roster ${v}; allowed ${lg.rosterId}`);
  }
  if (body.operationName === 'league_create_transaction') {
    if (body.query !== sleeperDropQuery(lg.leagueId)) fail('Sleeper league_create_transaction must be the canonical drop-only query');
    const { k_drops, v_drops, ...rest } = body.variables ?? {};
    if (Object.keys(rest).length) fail(`Sleeper drop takes only k_drops/v_drops, got ${Object.keys(rest).join(', ')}`);
    if (!Array.isArray(k_drops) || !k_drops.length || !Array.isArray(v_drops) || v_drops.length !== k_drops.length || k_drops.some((id) => typeof id !== 'string')) fail('Sleeper league_create_transaction needs matching k_drops/v_drops');
    return;
  }
  for (const m of body.query.matchAll(/(?<!\$)\b(v_adds|v_drops|roster_id_filters)[\s,]*:[\s,]*([^\s,)]+)/g)) if (m[2] !== `$${m[1]}`) fail(`Sleeper ${m[1]} must be bound to $${m[1]}`);
}

/** Validates a snapshot and sends exactly those bytes: the caller's objects stay reachable across the awaits. */
export async function gql(lg: SleeperLeague | null, query: string, variables: Json = {}): Promise<Json> {
  const operationName = query.match(/^\s*(?:query|mutation)\s+(\w+)/)?.[1] ?? '';
  const bytes = JSON.stringify({ operationName, variables, query });
  const body = JSON.parse(bytes);
  const league = lg && structuredClone(lg);
  if (operationName !== 'me' && !league) fail('league required');
  assertSleeperBody(body, league as SleeperLeague);
  if (/^\s*mutation\b/.test(body.query)) await ensureSleeperOwner(league as SleeperLeague);
  const j = await http(SLEEPER_GQL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-sleeper-graphql-op': operationName },
    body: bytes,
  });
  if (j?.errors?.length) rejected(SLEEPER_GQL, j.errors.map((e: Json) => String(e?.message ?? '')));
  return j.data;
}

async function ensureSleeperOwner(lg: SleeperLeague) {
  const me = (await gql(null, SLEEPER_ME_QUERY))?.me;
  if (!me?.user_id) fail('Sleeper identity unavailable: the me query returned no user; refusing to write');
  const roster = (await sapi(`/league/${lg.leagueId}/rosters`)).find((r: Json) => r.roster_id === lg.rosterId);
  if (!roster) fail(`roster ${lg.rosterId} not found in league ${lg.leagueId}`);
  if (roster.owner_id !== me.user_id && !(roster.co_owners ?? []).includes(me.user_id)) fail(`the authenticated Sleeper user does not own roster ${lg.rosterId} in league ${lg.leagueId}; refusing to write`);
}

let playersCache: Record<string, Json> | null = null;
async function sleeperPlayers(): Promise<Record<string, Json>> {
  if (playersCache) return playersCache;
  const path = `${cacheDir()}/sleeper-players-nfl.json`;
  const f = Bun.file(path);
  if ((await f.exists()) && Date.now() - f.lastModified < 12 * 3600_000) return (playersCache = await f.json());
  playersCache = await sapi(`/players/nfl`, { timeoutMs: 120_000 });
  await Bun.write(path, JSON.stringify(playersCache));
  return playersCache!;
}
const pName = (players: Record<string, Json>, id: string) => {
  const p = players[id];
  return p ? `${p.first_name} ${p.last_name}`.trim() : id;
};
const pView = (players: Record<string, Json>, id: string) => {
  const p = players[id] ?? {};
  return { id, name: pName(players, id), pos: p.position ?? (/^[A-Z]{2,3}$/.test(id) ? 'DEF' : undefined), team: p.team ?? (/^[A-Z]{2,3}$/.test(id) ? id : undefined), injury: p.injury_status ?? null };
};

async function sleeperCtx(lg: SleeperLeague, weekArg?: string) {
  const [state, league, rosters] = await Promise.all([
    sapi(`/state/nfl`),
    sapi(`/league/${lg.leagueId}`),
    sapi(`/league/${lg.leagueId}/rosters`),
  ]);
  const week = weekArg ? Number(weekArg) : Number(league.settings?.leg ?? state.leg ?? state.week);
  const mine = rosters.find((r: Json) => r.roster_id === lg.rosterId);
  if (!mine) fail(`roster ${lg.rosterId} not found in league ${lg.leagueId}`);
  return { state, league, rosters, mine, week, season: league.season as string };
}

const FLEX_ELIGIBLE: Record<string, string[]> = {
  FLEX: ['RB', 'WR', 'TE'],
  SUPER_FLEX: ['QB', 'RB', 'WR', 'TE'],
  REC_FLEX: ['WR', 'TE'],
  WRRB_FLEX: ['RB', 'WR'],
  IDP_FLEX: ['DL', 'LB', 'DB'],
};
function sleeperSlotOk(slot: string, id: string, players: Record<string, Json>) {
  const positions: string[] = players[id]?.fantasy_positions ?? (/^[A-Z]{2,3}$/.test(id) ? ['DEF'] : []);
  const allowed = FLEX_ELIGIBLE[slot] ?? [slot];
  return positions.some((p) => allowed.includes(p));
}
async function sleeperLocked(ctx: Json, ids: string[], players: Record<string, Json>) {
  const games = await nflGameStates(ctx.season, ctx.week);
  const locked: Json[] = [];
  for (const id of ids) {
    const team = players[id]?.team ?? (/^[A-Z]{2,3}$/.test(id) ? id : null);
    const g = team ? games.get(team) : undefined;
    if (g && g.state !== 'pre_game') locked.push({ ...pView(players, id), game: g.state, gameDate: g.date });
  }
  return locked;
}

const TX_FIELDS = 'adds consenter_ids created creator drops league_id leg metadata roster_ids settings status status_updated transaction_id type player_map';

async function sleeperPending(lg: SleeperLeague) {
  const q = `query league_transactions_filtered($league_id: String!, $roster_id_filters: [Int], $type_filters: [String], $leg_filters: [Int], $status_filters: [String]) {
        league_transactions_filtered(league_id: $league_id, roster_id_filters: $roster_id_filters, type_filters: $type_filters, leg_filters: $leg_filters, status_filters: $status_filters) {
          transaction_id status type leg created roster_ids adds drops settings
        }
      }`;
  const d = await gql(lg, q, { league_id: lg.leagueId, roster_id_filters: [lg.rosterId], type_filters: ['waiver'], leg_filters: [], status_filters: ['pending'] });
  return (d.league_transactions_filtered ?? []) as Json[];
}

const sleeper = {
  async state(lg: SleeperLeague) {
    const c = await sleeperCtx(lg);
    const s = c.league.settings;
    return { platform: 'sleeper', league: c.league.name, leagueId: lg.leagueId, season: c.season, status: c.league.status, week: c.week, nflState: c.state, waivers: { type: s.waiver_type === 2 ? 'FAAB' : s.waiver_type === 1 ? 'rolling' : 'reverse-standings', dayOfWeek: s.waiver_day_of_week, daily: !!s.daily_waivers, clearDays: s.waiver_clear_days }, tradeDeadlineWeek: s.trade_deadline };
  },

  async roster(lg: SleeperLeague, f: ReturnType<typeof parseFlags>) {
    const c = await sleeperCtx(lg, f.one('week'));
    const players = await sleeperPlayers();
    const matchups = await sapi(`/league/${lg.leagueId}/matchups/${c.week}`);
    const m = matchups.find((x: Json) => x.roster_id === lg.rosterId);
    const starters: string[] = m?.starters ?? c.mine.starters ?? [];
    const slots: string[] = c.league.roster_positions.filter((p: string) => p !== 'BN');
    const reserve: string[] = c.mine.reserve ?? [];
    const taxi: string[] = c.mine.taxi ?? [];
    const bench = (c.mine.players ?? []).filter((id: string) => !starters.includes(id) && !reserve.includes(id) && !taxi.includes(id));
    return {
      platform: 'sleeper', league: c.league.name, leagueId: lg.leagueId, rosterId: lg.rosterId, week: c.week,
      starters: starters.map((id, i) => ({ slot: slots[i], ...pView(players, id) })),
      bench: bench.map((id: string) => pView(players, id)),
      ir: reserve.map((id) => pView(players, id)),
      taxi: taxi.map((id) => pView(players, id)),
      rosterSize: { active: (c.mine.players ?? []).length - reserve.length - taxi.length, max: c.league.roster_positions.length, irSlots: c.league.settings.reserve_slots },
    };
  },

  async matchup(lg: SleeperLeague, f: ReturnType<typeof parseFlags>) {
    const c = await sleeperCtx(lg, f.one('week'));
    const [matchups, users, players] = await Promise.all([sapi(`/league/${lg.leagueId}/matchups/${c.week}`), sapi(`/league/${lg.leagueId}/users`), sleeperPlayers()]);
    const mine = matchups.find((x: Json) => x.roster_id === lg.rosterId);
    const opp = mine ? matchups.find((x: Json) => x.matchup_id === mine.matchup_id && x.roster_id !== lg.rosterId) : null;
    const teamName = (rid: number) => {
      const r = c.rosters.find((x: Json) => x.roster_id === rid);
      const u = users.find((x: Json) => x.user_id === r?.owner_id);
      return u?.metadata?.team_name ?? u?.display_name ?? `roster ${rid}`;
    };
    const side = (x: Json) => x && { rosterId: x.roster_id, team: teamName(x.roster_id), points: x.points, starters: (x.starters ?? []).map((id: string, i: number) => ({ ...pView(players, id), points: x.starters_points?.[i] })) };
    return { platform: 'sleeper', league: c.league.name, week: c.week, me: side(mine), opponent: side(opp) };
  },

  async scoring(lg: SleeperLeague) {
    const c = await sleeperCtx(lg);
    return { platform: 'sleeper', league: c.league.name, scoring: c.league.scoring_settings, rosterPositions: c.league.roster_positions, settings: c.league.settings };
  },

  async players(lg: SleeperLeague, f: ReturnType<typeof parseFlags>) {
    const c = await sleeperCtx(lg);
    const players = await sleeperPlayers();
    const rostered = new Set(c.rosters.flatMap((r: Json) => [...(r.players ?? []), ...(r.reserve ?? []), ...(r.taxi ?? [])]));
    const pos = f.one('pos')?.toUpperCase();
    const search = f.one('search');
    const limit = Number(f.one('limit') ?? 25);
    const leaguePositions = new Set(c.league.roster_positions.flatMap((p: string) => FLEX_ELIGIBLE[p] ?? [p]));
    let trending: Map<string, number> = new Map();
    try {
      const t = await sapi(`/players/nfl/trending/add?lookback_hours=48&limit=200`);
      trending = new Map(t.map((x: Json) => [x.player_id, x.count]));
    } catch {
      /* trending is advisory */
    }
    const avail = Object.entries(players)
      .filter(([id, p]) => !rostered.has(id) && (p.active || p.position === 'DEF') && (p.fantasy_positions ?? []).some((fp: string) => leaguePositions.has(fp)))
      .filter(([, p]) => !pos || (p.fantasy_positions ?? []).includes(pos))
      .filter(([id]) => !search || norm(pName(players, id)).includes(norm(search)))
      .map(([id, p]) => ({ ...pView(players, id), trendingAdds48h: trending.get(id) ?? 0, searchRank: p.search_rank ?? 9_999_999 }))
      .sort((a, b) => b.trendingAdds48h - a.trendingAdds48h || a.searchRank - b.searchRank)
      .slice(0, limit);
    return { platform: 'sleeper', league: c.league.name, week: c.week, available: avail };
  },

  async waivers(lg: SleeperLeague) {
    const c = await sleeperCtx(lg);
    const [users, players, pending] = await Promise.all([sapi(`/league/${lg.leagueId}/users`), sleeperPlayers(), sleeperPending(lg)]);
    const s = c.league.settings;
    const order = [...c.rosters]
      .sort((a: Json, b: Json) => a.settings.waiver_position - b.settings.waiver_position)
      .map((r: Json) => ({ position: r.settings.waiver_position, rosterId: r.roster_id, team: users.find((u: Json) => u.user_id === r.owner_id)?.display_name, me: r.roster_id === lg.rosterId }));
    return {
      platform: 'sleeper', league: c.league.name, week: c.week,
      budget: s.waiver_type === 2 ? { total: s.waiver_budget, used: c.mine.settings.waiver_budget_used, remaining: s.waiver_budget - c.mine.settings.waiver_budget_used, minBid: s.waiver_bid_min } : null,
      myWaiverPosition: c.mine.settings.waiver_position,
      order,
      pendingClaims: pending.map((t) => ({ transactionId: t.transaction_id, leg: t.leg, bid: t.settings?.waiver_bid, adds: Object.keys(t.adds ?? {}).map((id) => pView(players, id)), drops: Object.keys(t.drops ?? {}).map((id) => pView(players, id)) })),
    };
  },

  async setLineup(lg: SleeperLeague, f: ReturnType<typeof parseFlags>) {
    const c = await sleeperCtx(lg, f.one('week'));
    const players = await sleeperPlayers();
    const matchups = await sapi(`/league/${lg.leagueId}/matchups/${c.week}`);
    const m = matchups.find((x: Json) => x.roster_id === lg.rosterId);
    if (!m) fail(`no week ${c.week} matchup for roster ${lg.rosterId}`);
    const slots: string[] = c.league.roster_positions.filter((p: string) => p !== 'BN' && p !== 'IR');
    const current: string[] = [...m.starters];
    const next = [...current];
    const reserve: string[] = c.mine.reserve ?? [];
    const owned: string[] = (c.mine.players ?? []).filter((id: string) => !reserve.includes(id));
    const pool = owned.map((id) => ({ id, name: pName(players, id) }));
    const swaps = f.list('swap');
    if (!swaps.length) fail('use --swap IN:OUT (repeatable); IN is a bench player, OUT a current starter');
    for (const s of swaps) {
      const [inQ, outQ] = s.split(':');
      const pin = pickPlayer(inQ, pool, (p) => p.id, (p) => p.name, 'your active roster');
      const pout = pickPlayer(outQ, pool, (p) => p.id, (p) => p.name, 'your active roster');
      const idx = next.indexOf(pout.id);
      if (idx < 0) fail(`${pout.name} is not a starter`);
      const inIdx = next.indexOf(pin.id);
      if (inIdx >= 0) {
        if (!sleeperSlotOk(slots[inIdx], pout.id, players)) fail(`${pout.name} is not eligible for ${slots[inIdx]}`);
        next[inIdx] = pout.id;
      }
      if (!sleeperSlotOk(slots[idx], pin.id, players)) fail(`${pin.name} is not eligible for ${slots[idx]}`);
      next[idx] = pin.id;
    }
    const changed = [...new Set([...current, ...next].filter((id) => current.indexOf(id) !== next.indexOf(id)))];
    const locked = await sleeperLocked(c, changed, players);
    const plan = {
      platform: 'sleeper', league: c.league.name, week: c.week,
      changes: slots.map((slot, i) => ({ slot, from: pName(players, current[i]), to: pName(players, next[i]) })).filter((_, i) => current[i] !== next[i]),
      started: next.filter((id) => !current.includes(id)).map((id) => pView(players, id)),
      benched: current.filter((id) => !next.includes(id)).map((id) => pView(players, id)),
      lockedPlayers: locked,
    };
    if (locked.length) fail(`locked (game started): ${locked.map((p) => p.name).join(', ')}`);
    const q = `mutation update_matchup_leg($starters_games: Map) {
        update_matchup_leg(league_id: "${lg.leagueId}",roster_id: ${lg.rosterId},leg: ${c.week},round: ${c.week},starters: ${JSON.stringify(next)},starters_games: $starters_games){
          league_id leg matchup_id roster_id round starters players points
        }
      }`;
    if (!f.has('confirm')) return { dryRun: true, ...plan, note: 'rerun with --confirm to apply' };
    const d = await gql(lg, q, {});
    const same = (a: Json) => JSON.stringify(a ?? null) === JSON.stringify(next);
    const serverAck = same(d.update_matchup_leg?.starters);
    const readback = await settle(async () => same((await sapi(`/league/${lg.leagueId}/matchups/${c.week}`)).find((x: Json) => x.roster_id === lg.rosterId)?.starters));
    return { applied: true, verified: serverAck && readback, serverAck, readback, ...plan };
  },

  async ir(lg: SleeperLeague, f: ReturnType<typeof parseFlags>) {
    const c = await sleeperCtx(lg);
    const players = await sleeperPlayers();
    const s = c.league.settings;
    const reserve: string[] = [...(c.mine.reserve ?? [])];
    const all: string[] = c.mine.players ?? [];
    const pool = all.map((id) => ({ id, name: pName(players, id) }));
    const place = f.one('place');
    const activate = f.one('activate');
    if (!!place === !!activate) fail('use exactly one of --place PLAYER or --activate PLAYER');
    const matchups = await sapi(`/league/${lg.leagueId}/matchups/${c.week}`);
    const starters: string[] = matchups.find((x: Json) => x.roster_id === lg.rosterId)?.starters ?? [];
    let next: string[];
    let action: Json;
    if (place) {
      const p = pickPlayer(place, pool, (x) => x.id, (x) => x.name, 'your roster');
      if (reserve.includes(p.id)) fail(`${p.name} is already on IR`);
      if (reserve.length >= s.reserve_slots) fail(`IR full (${reserve.length}/${s.reserve_slots})`);
      if (starters.includes(p.id)) fail(`${p.name} is starting in week ${c.week}; bench him first with set-lineup`);
      const status = String(players[p.id]?.injury_status ?? '');
      const rule: Record<string, boolean> = { IR: true, Out: !!s.reserve_allow_out, Doubtful: !!s.reserve_allow_doubtful, Sus: !!s.reserve_allow_sus, NA: !!s.reserve_allow_na, PUP: !!s.reserve_allow_na, COV: !!s.reserve_allow_cov, DNR: !!s.reserve_allow_dnr };
      if (!rule[status]) fail(`${p.name} injury status "${status || 'none'}" is not IR-eligible in this league`);
      next = [...reserve, p.id];
      action = { place: pView(players, p.id) };
    } else {
      const p = pickPlayer(activate!, pool, (x) => x.id, (x) => x.name, 'your roster');
      if (!reserve.includes(p.id)) fail(`${p.name} is not on IR`);
      const active = all.length - reserve.length - (c.mine.taxi ?? []).length;
      if (active + 1 > c.league.roster_positions.length) fail(`activating ${p.name} would exceed the active roster limit (${active}/${c.league.roster_positions.length}); a drop is needed first`);
      next = reserve.filter((id) => id !== p.id);
      action = { activate: pView(players, p.id) };
    }
    const locked = await sleeperLocked(c, [place ? next.at(-1)! : reserve.find((id) => !next.includes(id))!], players);
    if (locked.length) fail(`locked (game started): ${locked.map((p) => p.name).join(', ')}`);
    const q = `mutation roster_update_reserve {
        roster_update_reserve(league_id: "${lg.leagueId}",roster_id: ${lg.rosterId},reserve: ${JSON.stringify(next)}){
          league_id roster_id players reserve starters
        }
      }`;
    const plan = { platform: 'sleeper', league: c.league.name, ...action, irAfter: next.map((id) => pView(players, id)) };
    if (!f.has('confirm')) return { dryRun: true, ...plan, note: 'rerun with --confirm to apply' };
    const d = await gql(lg, q, {});
    const same = (a: Json) => JSON.stringify([...(a ?? [])].sort()) === JSON.stringify([...next].sort());
    const serverAck = same(d.roster_update_reserve?.reserve);
    const readback = await settle(async () => same((await sapi(`/league/${lg.leagueId}/rosters`)).find((x: Json) => x.roster_id === lg.rosterId)?.reserve));
    return { applied: true, verified: serverAck && readback, serverAck, readback, ...plan };
  },

  async claim(lg: SleeperLeague, f: ReturnType<typeof parseFlags>) {
    const c = await sleeperCtx(lg);
    const players = await sleeperPlayers();
    const s = c.league.settings;
    const addQ = f.one('add') ?? fail('--add PLAYER required');
    const rostered = new Set(c.rosters.flatMap((r: Json) => [...(r.players ?? []), ...(r.reserve ?? []), ...(r.taxi ?? [])]));
    const freePool = Object.keys(players).filter((id) => !rostered.has(id) && (players[id].active || players[id].position === 'DEF')).map((id) => ({ id, name: pName(players, id) }));
    const add = pickPlayer(addQ, freePool, (p) => p.id, (p) => p.name, 'unrostered players');
    const reserve: string[] = c.mine.reserve ?? [];
    const mine: string[] = c.mine.players ?? [];
    let drop: { id: string; name: string } | undefined;
    const dropQ = f.one('drop');
    if (dropQ) drop = pickPlayer(dropQ, mine.map((id) => ({ id, name: pName(players, id) })), (p) => p.id, (p) => p.name, 'your roster');
    const active = mine.length - reserve.length - (c.mine.taxi ?? []).length;
    const dropFreesActive = drop && !reserve.includes(drop.id);
    if (!drop && active + 1 > c.league.roster_positions.length) fail(`roster full (${active}/${c.league.roster_positions.length}); pass --drop`);
    if (drop && !dropFreesActive && active + 1 > c.league.roster_positions.length) fail('dropping an IR player does not free an active spot; roster is full');
    const faab = s.waiver_type === 2;
    const remaining = faab ? s.waiver_budget - c.mine.settings.waiver_budget_used : null;
    const bid = faab ? Number(f.one('bid') ?? fail(`--bid required (FAAB; remaining $${remaining}, min $${s.waiver_bid_min})`)) : null;
    if (faab && (!Number.isInteger(bid) || bid! < s.waiver_bid_min || bid! > remaining!)) fail(`bid must be an integer in [${s.waiver_bid_min}, ${remaining}]`);
    if (drop) {
      const locked = await sleeperLocked(c, [drop.id], players);
      if (locked.length) fail(`cannot drop ${drop.name}: game started`);
    }
    const plan = { platform: 'sleeper', league: c.league.name, week: c.week, add: pView(players, add.id), drop: drop ? pView(players, drop.id) : null, bid, budgetRemaining: remaining };
    const vars: Json = { k_adds: [add.id], v_adds: [lg.rosterId], k_drops: drop ? [drop.id] : [], v_drops: drop ? [lg.rosterId] : [] };
    if (faab) Object.assign(vars, { k_settings: ['waiver_bid'], v_settings: [bid] });
    const q = `mutation submit_waiver_claim($k_adds: [String], $v_adds: [Int], $k_drops: [String], $v_drops: [Int]${faab ? ', $k_settings: [String], $v_settings: [Int]' : ''}) {
        submit_waiver_claim(league_id: "${lg.leagueId}",k_adds: $k_adds,v_adds: $v_adds,k_drops: $k_drops,v_drops: $v_drops${faab ? ',k_settings: $k_settings,v_settings: $v_settings' : ''}){
          ${TX_FIELDS}
        }
      }`;
    if (!f.has('confirm')) return { dryRun: true, ...plan, note: 'rerun with --confirm to submit' };
    const d = await gql(lg, q, vars);
    const tx = d.submit_waiver_claim;
    const readback = await settle(async () => (await sleeperPending(lg)).some((t) => t.transaction_id === tx?.transaction_id));
    return { applied: true, transactionId: tx?.transaction_id, status: tx?.status, verified: tx?.status === 'pending' && readback, ...plan };
  },

  async cancelClaim(lg: SleeperLeague, f: ReturnType<typeof parseFlags>) {
    const id = f.one('id') ?? fail('--id TRANSACTION_ID required (see waivers)');
    const pending = await sleeperPending(lg);
    const tx = pending.find((t) => t.transaction_id === id);
    if (!tx) fail(`transaction ${id} is not one of your pending claims`);
    if (!/^\d+$/.test(id)) fail('invalid transaction id');
    const players = await sleeperPlayers();
    const plan = { platform: 'sleeper', leagueId: lg.leagueId, transactionId: id, adds: Object.keys(tx.adds ?? {}).map((p) => pView(players, p)), drops: Object.keys(tx.drops ?? {}).map((p) => pView(players, p)), bid: tx.settings?.waiver_bid };
    const q = `mutation cancel_waiver_claim {
        cancel_waiver_claim(league_id: "${lg.leagueId}",leg: ${Number(tx.leg)},transaction_id: "${id}"){
          ${TX_FIELDS}
        }
      }`;
    if (!f.has('confirm')) return { dryRun: true, ...plan, note: 'rerun with --confirm to cancel' };
    const d = await gql(lg, q, {});
    const readback = await settle(async () => !(await sleeperPending(lg)).some((t) => t.transaction_id === id));
    return { applied: true, status: d.cancel_waiver_claim?.status, verified: d.cancel_waiver_claim?.status === 'cancelled' && readback, ...plan };
  },

  async drop(lg: SleeperLeague, f: ReturnType<typeof parseFlags>) {
    const c = await sleeperCtx(lg);
    const players = await sleeperPlayers();
    const mine: string[] = c.mine.players ?? [];
    const p = pickPlayer(f.one('player') ?? fail('--player PLAYER required'), mine.map((id) => ({ id, name: pName(players, id) })), (x) => x.id, (x) => x.name, 'your roster');
    const locked = await sleeperLocked(c, [p.id], players);
    if (locked.length) fail(`cannot drop ${p.name}: game started`);
    const plan = { platform: 'sleeper', league: c.league.name, week: c.week, drop: pView(players, p.id), fromIr: (c.mine.reserve ?? []).includes(p.id) };
    if (!f.has('confirm')) return { dryRun: true, ...plan, note: 'rerun with --confirm to drop (player goes to waivers; not reversible by this tool)' };
    const d = await gql(lg, sleeperDropQuery(lg.leagueId), { k_drops: [p.id], v_drops: [lg.rosterId] });
    const tx = d.league_create_transaction;
    const readback = await settle(async () => {
      const players = (await sapi(`/league/${lg.leagueId}/rosters`)).find((x: Json) => x.roster_id === lg.rosterId)?.players;
      return Array.isArray(players) && players.length > 0 && !players.includes(p.id);
    });
    return { applied: true, transactionId: tx?.transaction_id, status: tx?.status, verified: readback, ...plan };
  },

  async tradeDraft(lg: SleeperLeague, f: ReturnType<typeof parseFlags>) {
    const c = await sleeperCtx(lg);
    const players = await sleeperPlayers();
    const users = await sapi(`/league/${lg.leagueId}/users`);
    const withQ = f.one('with') ?? fail('--with ROSTER_ID|TEAM_NAME required');
    const owner = (r: Json) => users.find((u: Json) => u.user_id === r.owner_id);
    const other = c.rosters.find((r: Json) => String(r.roster_id) === withQ || norm(owner(r)?.display_name ?? '') === norm(withQ) || norm(owner(r)?.metadata?.team_name ?? '') === norm(withQ));
    if (!other || other.roster_id === lg.rosterId) fail(`trade partner "${withQ}" not found`);
    const give = f.list('give').map((q) => pickPlayer<{ id: string; name: string }>(q, (c.mine.players ?? []).map((id: string) => ({ id, name: pName(players, id) })), (p) => p.id, (p) => p.name, 'your roster'));
    const get = f.list('get').map((q) => pickPlayer<{ id: string; name: string }>(q, (other.players ?? []).map((id: string) => ({ id, name: pName(players, id) })), (p) => p.id, (p) => p.name, "partner's roster"));
    if (!give.length && !get.length) fail('--give and/or --get required');
    if (c.league.settings.disable_trades) fail('trades are disabled in this league');
    if (c.week > c.league.settings.trade_deadline) fail(`past trade deadline (week ${c.league.settings.trade_deadline})`);
    return {
      draftOnly: true, sent: false, platform: 'sleeper', league: c.league.name, week: c.week,
      partner: { rosterId: other.roster_id, owner: users.find((u: Json) => u.user_id === other.owner_id)?.display_name },
      youGive: give.map((p) => pView(players, p.id)), youGet: get.map((p) => pView(players, p.id)),
      note: 'Draft only. This tool cannot send trades; sending needs the owner\'s explicit authorization for this specific trade.',
    };
  },

  async authCheck(lg: SleeperLeague) {
    const me = (await gql(null, SLEEPER_ME_QUERY)).me;
    if (!me?.user_id) fail('Sleeper me returned no user: credential missing or expired');
    const c = await sleeperCtx(lg);
    const pending = await sleeperPending(lg);
    const writes = await writeGate(() => ensureSleeperOwner(lg));
    return { platform: 'sleeper', alias: lg.alias, league: c.league.name, leagueId: lg.leagueId, rosterId: lg.rosterId, credentialMode: credentialMode('sleeper'), authenticatedAs: me.display_name, writes, privatePendingClaimsRead: true, pendingClaimCount: pending.length };
  },
};

// ================================================================= ESPN

const ESPN_SLOTS: Record<number, string> = { 0: 'QB', 1: 'TQB', 2: 'RB', 3: 'RB/WR', 4: 'WR', 5: 'WR/TE', 6: 'TE', 7: 'OP', 16: 'D/ST', 17: 'K', 20: 'Bench', 21: 'IR', 23: 'FLEX', 24: 'ER', 25: 'Rookie' };
const ESPN_POS: Record<number, string> = { 1: 'QB', 2: 'RB', 3: 'WR', 4: 'TE', 5: 'K', 16: 'D/ST' };
const ESPN_POS_SLOT: Record<string, number> = { QB: 0, RB: 2, WR: 4, TE: 6, K: 17, DST: 16, 'D/ST': 16, DEF: 16, FLEX: 23 };
const ESPN_PLATFORM_VERSION = '5a90d30cd38deb765f269b68b6109e99dd51d6b3';
const ESPN_HEADERS = { 'x-fantasy-platform': 'espn-fantasy-web', 'x-fantasy-source': 'kona', accept: 'application/json' };

async function espnSeason(): Promise<number> {
  const j = await http('https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl');
  return Number(j.currentSeasonId);
}
function espnReadUrl(lg: EspnLeague, season: number, params: string) {
  return `https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/${season}/segments/0/leagues/${lg.leagueId}?${params}`;
}
async function espnRead(lg: EspnLeague, season: number, params: string, filter?: Json) {
  return http(espnReadUrl(lg, season, params), { headers: { ...ESPN_HEADERS, ...(filter ? { 'x-fantasy-filter': JSON.stringify(filter) } : {}) } });
}

/** Refuses any ESPN transaction body not scoped to this team. */
export function assertEspnBody(body: Json, lg: EspnLeague, memberId: string | null) {
  if (body.teamId !== lg.teamId) fail(`ESPN body teamId ${body.teamId}; allowed ${lg.teamId}`);
  if (body.isLeagueManager !== false) fail('ESPN body must not act as league manager');
  if (!['ROSTER', 'WAIVER', 'FREEAGENT'].includes(body.type)) fail(`ESPN transaction type ${body.type} not permitted`);
  if (body.type === 'FREEAGENT' && (!body.items?.length || body.items.some((it: Json) => it.type !== 'DROP'))) fail('ESPN FREEAGENT transactions are drop-only');
  if (body.memberId !== undefined && body.memberId !== memberId) fail('ESPN memberId mismatch');
  for (const it of body.items ?? []) {
    for (const k of ['toTeamId', 'fromTeamId']) if (it[k] !== undefined && it[k] !== 0 && it[k] !== lg.teamId) fail(`ESPN item ${k} ${it[k]} not permitted`);
    if (!['LINEUP', 'ADD', 'DROP'].includes(it.type)) fail(`ESPN item type ${it.type} not permitted`);
  }
}

const espnOwners = async (lg: EspnLeague, season: number): Promise<string[]> =>
  ((await espnRead(lg, season, 'view=mTeam')).teams?.find((t: Json) => t.id === lg.teamId)?.owners ?? []).map((o: Json) => String(o).toUpperCase());

/**
 * Binds the credential to the configured member. With cookies in the environment the
 * SWID is the member id. In gateway mode the proxy's cookie is invisible here, so the
 * config entry must assert whose cookie it injects; the live owners list is checked either way.
 */
async function ensureEspnIdentity(lg: EspnLeague, season: number) {
  if (credentialMode('espn') === 'env') {
    if (process.env.ESPN_SWID!.toUpperCase() !== lg.memberId.toUpperCase()) fail(`ESPN_SWID is not the memberId configured for ${lg.alias}; refusing to write`);
  } else if (lg.identity !== 'gateway-asserted') {
    fail(`ESPN writes for ${lg.alias} need ESPN_S2 + ESPN_SWID in the environment, or "identity": "gateway-asserted" in its config entry when a proxy injects the cookie`);
  }
  if (!(await espnOwners(lg, season)).includes(lg.memberId.toUpperCase())) fail(`memberId configured for ${lg.alias} is not an owner of team ${lg.teamId}; refusing to write`);
}

/** Same snapshot rule as gql(): validate a copy, send those bytes. */
export async function espnWrite(lg: EspnLeague, season: number, body: Json) {
  const bytes = JSON.stringify(body);
  const league = structuredClone(lg);
  assertEspnBody(JSON.parse(bytes), league, league.memberId);
  await ensureEspnIdentity(league, season);
  return http(`https://lm-api-writes.fantasy.espn.com/apis/v3/games/ffl/seasons/${season}/segments/0/leagues/${league.leagueId}/transactions/?platformVersion=${ESPN_PLATFORM_VERSION}`, {
    method: 'POST',
    headers: { ...ESPN_HEADERS, 'content-type': 'application/json', origin: 'https://fantasy.espn.com', referer: 'https://fantasy.espn.com/' },
    body: bytes,
  });
}

async function espnCtx(lg: EspnLeague) {
  const season = await espnSeason();
  const base = await espnRead(lg, season, 'view=mStatus&view=mSettings&view=mTeam');
  const team = base.teams?.find((t: Json) => t.id === lg.teamId);
  if (!team) fail(`team ${lg.teamId} not found`);
  return { season, base, team, memberId: lg.memberId, period: Number(base.scoringPeriodId), matchupPeriod: Number(base.status?.currentMatchupPeriod) };
}
async function espnRoster(lg: EspnLeague, season: number, period: number) {
  const j = await espnRead(lg, season, `view=mRoster&scoringPeriodId=${period}`);
  const entries: Json[] = j.teams?.find((t: Json) => t.id === lg.teamId)?.roster?.entries ?? [];
  return entries.map((e) => {
    const p = e.playerPoolEntry?.player ?? {};
    return { id: e.playerId as number, name: p.fullName as string, pos: ESPN_POS[p.defaultPositionId] ?? String(p.defaultPositionId), slotId: e.lineupSlotId as number, slot: ESPN_SLOTS[e.lineupSlotId] ?? String(e.lineupSlotId), injury: p.injuryStatus ?? null, locked: !!e.playerPoolEntry?.lineupLocked, eligibleSlots: (p.eligibleSlots ?? []) as number[] };
  });
}
const espnView = (p: Json) => ({ id: p.id, name: p.name, pos: p.pos, slot: p.slot, injury: p.injury, locked: p.locked });

const espn = {
  async state(lg: EspnLeague) {
    const c = await espnCtx(lg);
    const s = c.base.settings;
    return { platform: 'espn', league: s.name, leagueId: lg.leagueId, season: c.season, scoringPeriod: c.period, matchupPeriod: c.matchupPeriod, lineupLock: s.rosterSettings.lineupLocktimeType, waivers: { type: s.acquisitionSettings.acquisitionType, faab: s.acquisitionSettings.isUsingAcquisitionBudget, hours: s.acquisitionSettings.waiverHours, processDays: s.acquisitionSettings.waiverProcessDays, processHour: s.acquisitionSettings.waiverProcessHour, lastExecution: c.base.status?.waiverLastExecutionDate && new Date(c.base.status.waiverLastExecutionDate).toISOString() }, tradeDeadline: s.tradeSettings?.deadlineDate && new Date(s.tradeSettings.deadlineDate).toISOString() };
  },

  async roster(lg: EspnLeague, f: ReturnType<typeof parseFlags>) {
    const c = await espnCtx(lg);
    const period = Number(f.one('week') ?? c.period);
    const r = await espnRoster(lg, c.season, period);
    return { platform: 'espn', league: c.base.settings.name, team: c.team.name, scoringPeriod: period, lineupSlotCounts: Object.fromEntries(Object.entries(c.base.settings.rosterSettings.lineupSlotCounts).filter(([, n]) => Number(n) > 0).map(([k, n]) => [ESPN_SLOTS[Number(k)] ?? k, n])), players: r.sort((a, b) => a.slotId - b.slotId).map(espnView) };
  },

  async matchup(lg: EspnLeague, f: ReturnType<typeof parseFlags>) {
    const c = await espnCtx(lg);
    const mp = Number(f.one('week') ?? c.matchupPeriod);
    const j = await espnRead(lg, c.season, `view=mMatchupScore&view=mScoreboard&scoringPeriodId=${mp}`);
    const g = (j.schedule ?? []).find((x: Json) => x.matchupPeriodId === mp && (x.home?.teamId === lg.teamId || x.away?.teamId === lg.teamId));
    if (!g) fail(`no matchup in period ${mp}`);
    const name = (id: number) => c.base.teams.find((t: Json) => t.id === id)?.name;
    const side = (s: Json) => s && { teamId: s.teamId, team: name(s.teamId), points: s.totalPoints, livePoints: s.totalPointsLive, projected: s.totalProjectedPointsLive ?? s.totalProjectedPoints };
    const me = g.home?.teamId === lg.teamId ? g.home : g.away;
    const opp = g.home?.teamId === lg.teamId ? g.away : g.home;
    return { platform: 'espn', league: c.base.settings.name, matchupPeriod: mp, me: side(me), opponent: side(opp), winner: g.winner };
  },

  async scoring(lg: EspnLeague) {
    const c = await espnCtx(lg);
    const s = c.base.settings;
    return { platform: 'espn', league: s.name, scoringType: s.scoringSettings.scoringType, scoringItems: s.scoringSettings.scoringItems.map((i: Json) => ({ statId: i.statId, points: i.points, overrides: i.pointsOverrides })), note: 'statId map: https://github.com/cwendt94/espn-api (PLAYER_STATS_MAP)', rosterSettings: s.rosterSettings, acquisitionSettings: s.acquisitionSettings };
  },

  async players(lg: EspnLeague, f: ReturnType<typeof parseFlags>) {
    const c = await espnCtx(lg);
    const pos = f.one('pos')?.toUpperCase();
    const search = f.one('search');
    const limit = Number(f.one('limit') ?? 25);
    const filter: Json = { players: { filterStatus: { value: ['FREEAGENT', 'WAIVERS'] }, limit: search ? 400 : limit, sortPercOwned: { sortPriority: 1, sortAsc: false } } };
    if (pos) {
      if (!(pos in ESPN_POS_SLOT)) fail(`--pos one of ${Object.keys(ESPN_POS_SLOT).join(', ')}`);
      filter.players.filterSlotIds = { value: [ESPN_POS_SLOT[pos]] };
    }
    const j = await espnRead(lg, c.season, `view=kona_player_info&scoringPeriodId=${c.period}`, filter);
    const list = (j.players ?? [])
      .filter((p: Json) => !search || norm(p.player?.fullName ?? '').includes(norm(search)))
      .slice(0, limit)
      .map((p: Json) => ({ id: p.id, name: p.player?.fullName, pos: ESPN_POS[p.player?.defaultPositionId], status: p.status, waiverProcessDate: p.waiverProcessDate && new Date(p.waiverProcessDate).toISOString(), percentOwned: p.player?.ownership?.percentOwned, injury: p.player?.injuryStatus }));
    return { platform: 'espn', league: c.base.settings.name, scoringPeriod: c.period, available: list };
  },

  /**
   * ESPN never updates a claim's own record: it stays status PENDING and the outcome
   * (EXECUTED / FAILED_* / CANCELED) is a separate PROCESS or CANCEL transaction whose
   * relatedTransactionId points back at it. A claim is pending only if nothing resolves it.
   */
  async pending(lg: EspnLeague, season: number, period: number) {
    const periods = [...new Set([period - 1, period].filter((p) => p >= 1))];
    const all: Json[] = [];
    for (const p of periods) {
      const j = await espnRead(lg, season, `view=mTransactions2&scoringPeriodId=${p}`, { transactions: { filterType: { value: ['WAIVER', 'WAIVER_ERROR', 'FREEAGENT'] } } });
      all.push(...(j.transactions ?? []));
    }
    const resolved = new Set(all.filter((t) => t.relatedTransactionId && !t.isPending).map((t) => t.relatedTransactionId));
    const seen = new Set<string>();
    return all.filter((t) => t.teamId === lg.teamId && t.isPending && t.executionType === 'EXECUTE' && !resolved.has(t.id) && !seen.has(t.id) && seen.add(t.id));
  },

  async waivers(lg: EspnLeague) {
    const c = await espnCtx(lg);
    const acq = c.base.settings.acquisitionSettings;
    const pend = await espn.pending(lg, c.season, c.period);
    const names = new Map<number, string>();
    const ids = [...new Set(pend.flatMap((t) => t.items.map((i: Json) => i.playerId)))];
    if (ids.length) {
      const pj = await espnRead(lg, c.season, `view=kona_player_info&scoringPeriodId=${c.period}`, { players: { filterIds: { value: ids } } });
      for (const p of pj.players ?? []) names.set(p.id, p.player?.fullName);
    }
    return {
      platform: 'espn', league: c.base.settings.name, scoringPeriod: c.period,
      budget: acq.isUsingAcquisitionBudget ? { total: acq.acquisitionBudget, spent: c.team.transactionCounter?.acquisitionBudgetSpent, remaining: acq.acquisitionBudget - (c.team.transactionCounter?.acquisitionBudgetSpent ?? 0), minBid: acq.minimumBid } : null,
      myWaiverRank: c.team.waiverRank,
      order: [...c.base.teams].sort((a: Json, b: Json) => a.waiverRank - b.waiverRank).map((t: Json) => ({ rank: t.waiverRank, teamId: t.id, team: t.name, me: t.id === lg.teamId })),
      pendingClaims: pend.map((t) => ({ transactionId: t.id, type: t.type, bid: t.bidAmount, scoringPeriodId: t.scoringPeriodId, adds: t.items.filter((i: Json) => i.type === 'ADD').map((i: Json) => ({ id: i.playerId, name: names.get(i.playerId) })), drops: t.items.filter((i: Json) => i.type === 'DROP').map((i: Json) => ({ id: i.playerId, name: names.get(i.playerId) })) })),
    };
  },

  async setLineup(lg: EspnLeague, f: ReturnType<typeof parseFlags>) {
    const c = await espnCtx(lg);
    const roster = await espnRoster(lg, c.season, c.period);
    const counts: Record<string, number> = c.base.settings.rosterSettings.lineupSlotCounts;
    const slotOf = new Map(roster.map((p) => [p.id, p.slotId]));
    const items: Json[] = [];
    const swaps = f.list('swap');
    const moves = f.list('move');
    if (!swaps.length && !moves.length) fail('use --swap IN:OUT and/or --move PLAYER:SLOT (slot: QB RB WR TE FLEX K D/ST Bench)');
    const pick = (q: string) => pickPlayer(q, roster, (p) => String(p.id), (p) => p.name, 'your roster');
    for (const s of swaps) {
      const [inQ, outQ] = s.split(':');
      const pin = pick(inQ);
      const pout = pick(outQ);
      const inSlot = slotOf.get(pin.id)!;
      const outSlot = slotOf.get(pout.id)!;
      if (outSlot === 20 || outSlot === 21) fail(`${pout.name} is not in a starting slot`);
      if (!pin.eligibleSlots.includes(outSlot)) fail(`${pin.name} is not eligible for ${ESPN_SLOTS[outSlot]}`);
      if (inSlot !== 20 && !pout.eligibleSlots.includes(inSlot)) fail(`${pout.name} is not eligible for ${ESPN_SLOTS[inSlot]}`);
      if (inSlot === 21) fail(`${pin.name} is on IR; use ir --activate first`);
      items.push({ playerId: pin.id, type: 'LINEUP', fromLineupSlotId: inSlot, toLineupSlotId: outSlot });
      items.push({ playerId: pout.id, type: 'LINEUP', fromLineupSlotId: outSlot, toLineupSlotId: inSlot });
      slotOf.set(pin.id, outSlot);
      slotOf.set(pout.id, inSlot);
    }
    for (const m of moves) {
      const i = m.lastIndexOf(':');
      const p = pick(m.slice(0, i));
      const slotName = m.slice(i + 1).toUpperCase();
      const to = slotName === 'BENCH' || slotName === 'BN' ? 20 : ESPN_POS_SLOT[slotName] ?? fail(`unknown slot ${slotName}`);
      const from = slotOf.get(p.id)!;
      if (from === 21) fail(`${p.name} is on IR; use ir --activate`);
      if (!p.eligibleSlots.includes(to)) fail(`${p.name} is not eligible for ${ESPN_SLOTS[to]}`);
      items.push({ playerId: p.id, type: 'LINEUP', fromLineupSlotId: from, toLineupSlotId: to });
      slotOf.set(p.id, to);
    }
    const lockedP = roster.filter((p) => items.some((it) => it.playerId === p.id) && p.locked);
    if (lockedP.length) fail(`locked (game started): ${lockedP.map((p) => p.name).join(', ')}`);
    for (const [slot, n] of Object.entries(counts)) {
      const sid = Number(slot);
      if (sid === 20) continue;
      const used = [...slotOf.values()].filter((s) => s === sid).length;
      if (used > Number(n)) fail(`slot ${ESPN_SLOTS[sid]} would hold ${used} players (max ${n})`);
    }
    const body = { isLeagueManager: false, teamId: lg.teamId, type: 'ROSTER', scoringPeriodId: c.period, executionType: 'EXECUTE', items };
    const names = new Map(roster.map((p) => [p.id, p.name]));
    const plan = { platform: 'espn', league: c.base.settings.name, scoringPeriod: c.period, changes: items.map((it) => ({ player: names.get(it.playerId), from: ESPN_SLOTS[it.fromLineupSlotId], to: ESPN_SLOTS[it.toLineupSlotId] })) };
    if (!f.has('confirm')) return { dryRun: true, ...plan, note: 'rerun with --confirm to apply' };
    const res = await espnWrite(lg, c.season, body);
    const verified = await settle(async () => {
      const after = await espnRoster(lg, c.season, c.period);
      return items.every((it) => after.find((p) => p.id === it.playerId)?.slotId === slotOf.get(it.playerId));
    });
    return { applied: true, status: res?.status, verified, ...plan };
  },

  async ir(lg: EspnLeague, f: ReturnType<typeof parseFlags>) {
    const c = await espnCtx(lg);
    const roster = await espnRoster(lg, c.season, c.period);
    const counts = c.base.settings.rosterSettings.lineupSlotCounts;
    const place = f.one('place');
    const activate = f.one('activate');
    if (!!place === !!activate) fail('use exactly one of --place PLAYER or --activate PLAYER');
    const p = pickPlayer((place ?? activate)!, roster, (x) => String(x.id), (x) => x.name, 'your roster');
    if (p.locked) fail(`${p.name} is locked (game started)`);
    let item: Json;
    if (place) {
      if (p.slotId === 21) fail(`${p.name} is already on IR`);
      const used = roster.filter((x) => x.slotId === 21).length;
      if (used >= Number(counts['21'] ?? 0)) fail(`IR full (${used}/${counts['21'] ?? 0})`);
      if (!p.eligibleSlots.includes(21) || !['OUT', 'INJURY_RESERVE'].includes(String(p.injury))) fail(`${p.name} injury status "${p.injury}" is not IR-eligible (needs OUT or INJURY_RESERVE)`);
      item = { playerId: p.id, type: 'LINEUP', fromLineupSlotId: p.slotId, toLineupSlotId: 21 };
    } else {
      if (p.slotId !== 21) fail(`${p.name} is not on IR`);
      const maxActive = Object.entries(counts).filter(([k]) => k !== '21').reduce((a, [, n]) => a + Number(n), 0);
      const active = roster.filter((x) => x.slotId !== 21).length;
      if (active + 1 > maxActive) fail(`activating ${p.name} would exceed roster size (${active}/${maxActive}); a drop is needed first`);
      item = { playerId: p.id, type: 'LINEUP', fromLineupSlotId: 21, toLineupSlotId: 20 };
    }
    const body = { isLeagueManager: false, teamId: lg.teamId, type: 'ROSTER', scoringPeriodId: c.period, executionType: 'EXECUTE', items: [item] };
    const plan = { platform: 'espn', league: c.base.settings.name, player: espnView(p), from: ESPN_SLOTS[item.fromLineupSlotId], to: ESPN_SLOTS[item.toLineupSlotId] };
    if (!f.has('confirm')) return { dryRun: true, ...plan, note: 'rerun with --confirm to apply' };
    const res = await espnWrite(lg, c.season, body);
    const verified = await settle(async () => (await espnRoster(lg, c.season, c.period)).find((x) => x.id === p.id)?.slotId === item.toLineupSlotId);
    return { applied: true, status: res?.status, verified, ...plan };
  },

  async claim(lg: EspnLeague, f: ReturnType<typeof parseFlags>) {
    const c = await espnCtx(lg);
    const acq = c.base.settings.acquisitionSettings;
    const roster = await espnRoster(lg, c.season, c.period);
    const addQ = f.one('add') ?? fail('--add PLAYER (ESPN id or name) required');
    const filter: Json = { players: { filterStatus: { value: ['FREEAGENT', 'WAIVERS'] }, limit: 400, sortPercOwned: { sortPriority: 1, sortAsc: false } } };
    if (/^\d+$/.test(addQ)) filter.players = { filterIds: { value: [Number(addQ)] } };
    const pj = await espnRead(lg, c.season, `view=kona_player_info&scoringPeriodId=${c.period}`, filter);
    const pool = (pj.players ?? []).map((p: Json) => ({ id: p.id, name: p.player?.fullName, status: p.status, onTeamId: p.onTeamId }));
    const add = pickPlayer<Json>(addQ, pool, (p) => String(p.id), (p) => p.name, "available players");
    if (add.onTeamId !== 0) fail(`${add.name} is rostered (team ${add.onTeamId})`);
    // This league routes free-agent pickups through waiver claims too (observed: pending WAIVER claims on FREEAGENT players).
    if (!['WAIVERS', 'FREEAGENT'].includes(add.status)) fail(`${add.name} status ${add.status} is not claimable`);
    const dropQ = f.one('drop');
    const drop = dropQ ? pickPlayer(dropQ, roster, (p) => String(p.id), (p) => p.name, 'your roster') : undefined;
    if (drop?.locked) fail(`${drop.name} is locked (game started)`);
    const maxActive = Object.entries(c.base.settings.rosterSettings.lineupSlotCounts).filter(([k]) => k !== '21').reduce((a, [, n]) => a + Number(n), 0);
    const active = roster.filter((x) => x.slotId !== 21).length;
    if (!drop && active + 1 > maxActive) fail(`roster full (${active}/${maxActive}); pass --drop`);
    let bidAmount: number | null = null;
    if (acq.isUsingAcquisitionBudget) {
      const remaining = acq.acquisitionBudget - (c.team.transactionCounter?.acquisitionBudgetSpent ?? 0);
      bidAmount = Number(f.one('bid') ?? fail(`--bid required (remaining ${remaining}, min ${acq.minimumBid})`));
      if (!Number.isInteger(bidAmount) || bidAmount < acq.minimumBid || bidAmount > remaining) fail(`bid must be an integer in [${acq.minimumBid}, ${remaining}]`);
    }
    const items: Json[] = [{ playerId: add.id, type: 'ADD', toTeamId: lg.teamId }];
    if (drop) items.push({ playerId: drop.id, type: 'DROP', fromTeamId: lg.teamId });
    const body = { isLeagueManager: false, teamId: lg.teamId, type: 'WAIVER', memberId: c.memberId, scoringPeriodId: c.period, executionType: 'EXECUTE', items, bidAmount };
    const plan = { platform: 'espn', league: c.base.settings.name, scoringPeriod: c.period, add: { id: add.id, name: add.name }, drop: drop ? espnView(drop) : null, bidAmount, myWaiverRank: c.team.waiverRank };
    if (!f.has('confirm')) return { dryRun: true, ...plan, note: 'rerun with --confirm to submit' };
    const res = await espnWrite(lg, c.season, body);
    const verified = await settle(async () => (await espn.pending(lg, c.season, c.period)).some((t) => t.id === res?.id));
    return { applied: true, transactionId: res?.id, status: res?.status, verified, ...plan };
  },

  async cancelClaim(lg: EspnLeague, f: ReturnType<typeof parseFlags>) {
    const c = await espnCtx(lg);
    const id = f.one('id') ?? fail('--id TRANSACTION_ID required (see waivers)');
    const pend = await espn.pending(lg, c.season, c.period);
    const tx = pend.find((t) => t.id === id);
    if (!tx) fail(`transaction ${id} is not one of your pending claims`);
    const body = { isLeagueManager: false, teamId: lg.teamId, type: 'WAIVER', scoringPeriodId: tx.scoringPeriodId, executionType: 'CANCEL', relatedTransactionId: id };
    const plan = { platform: 'espn', league: c.base.settings.name, transactionId: id, items: tx.items.map((i: Json) => ({ type: i.type, playerId: i.playerId })) };
    if (!f.has('confirm')) return { dryRun: true, ...plan, note: 'rerun with --confirm to cancel' };
    const res = await espnWrite(lg, c.season, body);
    const verified = await settle(async () => !(await espn.pending(lg, c.season, c.period)).some((t) => t.id === id));
    return { applied: true, status: res?.status, verified, ...plan };
  },

  async drop(lg: EspnLeague, f: ReturnType<typeof parseFlags>) {
    const c = await espnCtx(lg);
    const roster = await espnRoster(lg, c.season, c.period);
    const p = pickPlayer(f.one('player') ?? fail('--player PLAYER required'), roster, (x) => String(x.id), (x) => x.name, 'your roster');
    if (p.locked) fail(`${p.name} is locked (game started)`);
    const body = { isLeagueManager: false, teamId: lg.teamId, type: 'FREEAGENT', memberId: c.memberId, scoringPeriodId: c.period, executionType: 'EXECUTE', items: [{ playerId: p.id, type: 'DROP', fromTeamId: lg.teamId }] };
    const plan = { platform: 'espn', league: c.base.settings.name, scoringPeriod: c.period, drop: espnView(p) };
    if (!f.has('confirm')) return { dryRun: true, ...plan, note: 'rerun with --confirm to drop (player goes to waivers; not reversible by this tool)' };
    const res = await espnWrite(lg, c.season, body);
    const verified = await settle(async () => {
      const after = await espnRoster(lg, c.season, c.period);
      return after.length > 0 && !after.some((x) => x.id === p.id);
    });
    return { applied: true, transactionId: res?.id, status: res?.status, verified, ...plan };
  },

  async tradeDraft(lg: EspnLeague, f: ReturnType<typeof parseFlags>) {
    const c = await espnCtx(lg);
    const withQ = f.one('with') ?? fail('--with TEAM_ID|TEAM_NAME required');
    const other = c.base.teams.find((t: Json) => String(t.id) === withQ || norm(t.name ?? '') === norm(withQ) || norm(t.abbrev ?? '') === norm(withQ));
    if (!other || other.id === lg.teamId) fail(`trade partner "${withQ}" not found`);
    const j = await espnRead(lg, c.season, `view=mRoster&scoringPeriodId=${c.period}`);
    const rosterOf = (tid: number): Json[] => (j.teams.find((t: Json) => t.id === tid)?.roster?.entries ?? []).map((e: Json) => ({ id: e.playerId, name: e.playerPoolEntry?.player?.fullName, locked: e.playerPoolEntry?.tradeLocked }));
    const give = f.list("give").map((q) => pickPlayer<Json>(q, rosterOf(lg.teamId), (p) => String(p.id), (p) => p.name, "your roster"));
    const get = f.list("get").map((q) => pickPlayer<Json>(q, rosterOf(other.id), (p) => String(p.id), (p) => p.name, "partner roster"));
    if (!give.length && !get.length) fail('--give and/or --get required');
    const tradeLocked = [...give, ...get].filter((p: Json) => p.locked);
    return {
      draftOnly: true, sent: false, platform: 'espn', league: c.base.settings.name, partner: { teamId: other.id, team: other.name },
      youGive: give, youGet: get, tradeLocked,
      note: 'Draft only. No ESPN trade-proposal schema was captured and this tool cannot send trades; sending needs the owner\'s explicit authorization.',
    };
  },

  async authCheck(lg: EspnLeague) {
    const c = await espnCtx(lg);
    const pend = await espn.pending(lg, c.season, c.period);
    const writes = await writeGate(() => ensureEspnIdentity(lg, c.season));
    return { platform: 'espn', alias: lg.alias, league: c.base.settings.name, leagueId: lg.leagueId, teamId: lg.teamId, team: c.team.name, privateLeagueRead: true, leagueIsPublic: !!c.base.settings.isPublic, credentialMode: credentialMode('espn'), writes, privatePendingClaimsRead: true, pendingClaimCount: pend.length };
  },
};

// ================================================================= dispatch

const HELP = `fantasy [--config PATH] <command> <league> [flags]
Config: --config, else $FF_CONFIG, ./fantasy.config.json, ~/.config/fantasy-football/config.json
Credentials: SLEEPER_TOKEN, ESPN_S2 + ESPN_SWID (unset = a proxy injects them)

Reads
  leagues                                   leagues in your config
  auth-check [league|all]                   private, account-specific reads (proves credentials)
  state <league>                            season, current week/period, waiver + lock rules
  roster <league> [--week N]                lineup, bench, IR (with injury + lock status)
  matchup <league> [--week N]               my matchup and opponent
  scoring <league>                          scoring + roster settings
  players <league> [--pos RB] [--search name] [--limit 25]   available players
  waivers <league>                          FAAB budget, waiver order, my pending claims

Writes (dry run unless --confirm; live state re-read first; read back after)
  set-lineup <league> --swap IN:OUT [--swap ...]      (ESPN also: --move PLAYER:SLOT)
  ir <league> --place PLAYER | --activate PLAYER
  claim <league> --add PLAYER [--drop PLAYER] [--bid N]
  drop <league> --player PLAYER                       release a player with no add
  cancel-claim <league> --id TRANSACTION_ID

Trades (never sent)
  trade-draft <league> --with ROSTER|TEAM --give P1,P2 --get P3

PLAYER = platform player id or unambiguous name.`;

export async function main(argv: string[]): Promise<number> {
  const f = parseFlags(argv);
  const [cmd, leagueArg] = f.positional;
  if (!cmd || cmd === 'help' || f.has('help')) {
    console.log(HELP);
    return 0;
  }
  const leagues: League[] = loadConfig(f.one('config'));
  if (cmd === 'leagues') {
    out(leagues);
    return 0;
  }
  if (cmd === 'auth-check' && (!leagueArg || leagueArg === 'all')) {
    const results: Json[] = [];
    for (const lg of leagues) {
      try {
        results.push(await (lg.platform === 'sleeper' ? sleeper.authCheck(lg) : espn.authCheck(lg)));
      } catch (e) {
        results.push({ platform: lg.platform, alias: lg.alias, ok: false, error: errorText(e) });
      }
    }
    out(results);
    return results.some((r) => r.ok === false) ? 1 : 0;
  }
  const lg = resolveLeague(leagueArg, leagues);
  const impl: Json = lg.platform === 'sleeper' ? sleeper : espn;
  const map: Record<string, string> = { 'auth-check': 'authCheck', state: 'state', roster: 'roster', matchup: 'matchup', scoring: 'scoring', players: 'players', waivers: 'waivers', 'set-lineup': 'setLineup', ir: 'ir', claim: 'claim', drop: 'drop', 'cancel-claim': 'cancelClaim', 'trade-draft': 'tradeDraft' };
  const fn = map[cmd];
  if (!fn) fail(`unknown command "${cmd}"\n\n${HELP}`);
  out(await impl[fn](lg, f));
  return 0;
}

export async function cli(argv: string[]): Promise<number> {
  try {
    return await main(argv);
  } catch (e) {
    console.error(`error: ${errorText(e)}`);
    return 1;
  }
}

if (import.meta.main) cli(process.argv.slice(2)).then((code) => process.exit(code));
