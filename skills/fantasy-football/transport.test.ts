/**
 * Runs real commands and the real write boundary against a scripted fetch.
 * Asserts on what left the process: mutation requests made, and text printed.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { cli, espnWrite, gql, sleeperDropQuery } from './fantasy.ts';
import type { EspnLeague, SleeperLeague } from './leagues.ts';

const dir = mkdtempSync(join(tmpdir(), 'ff-transport-'));
process.env.FF_CACHE_DIR = dir;

const S_LEAGUE = '100000000000000001';
const S_OTHER = '100000000000000002';
const E_LEAGUE = '20000001';
const SWID = '{AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA}';
const OTHER_SWID = '{BBBBBBBB-BBBB-BBBB-BBBB-BBBBBBBBBBBB}';
const home: SleeperLeague = { platform: 'sleeper', alias: 'home', leagueId: S_LEAGUE, rosterId: 4 };
const work: EspnLeague = { platform: 'espn', alias: 'work', leagueId: E_LEAGUE, teamId: 2, memberId: SWID, identity: 'gateway-asserted' };

const config = (leagues: unknown[]) => {
  const p = join(dir, `cfg-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(p, JSON.stringify({ leagues }));
  return p;
};
const CFG = config([home, work]);

// ---------------------------------------------------------------- fixtures

const player = (first: string, pos: string, team: string, injury: string | null = null) => ({ first_name: first, last_name: 'Synth', full_name: `${first} Synth`, position: pos, fantasy_positions: [pos], team, active: true, search_rank: 1, injury_status: injury });
const players = { p1: player('Aa', 'RB', 'KC'), p2: player('Bb', 'WR', 'SF'), p3: player('Cc', 'RB', 'DAL', 'Out'), p4: player('Dd', 'WR', 'NYG') };
const sleeperState = { week: 3, leg: 3, season: '2026' };
const sleeperLeague = (name: string) => ({ league_id: S_LEAGUE, name, season: '2026', status: 'in_season', roster_positions: ['RB', 'WR', 'BN'], settings: { leg: 3, reserve_slots: 1, reserve_allow_out: true, waiver_type: 2, waiver_budget: 100, waiver_bid_min: 0, trade_deadline: 13 }, scoring_settings: { rec: 1 } });
const rosters = (owner: string) => [{ roster_id: 4, owner_id: owner, co_owners: [], players: ['p1', 'p2', 'p3'], starters: ['p1', 'p2'], reserve: [], taxi: [], settings: { waiver_position: 1, waiver_budget_used: 0 } }];
const matchups = [{ roster_id: 4, matchup_id: 1, starters: ['p1', 'p2'], starters_points: [0, 0], points: 0 }];
const pendingClaim = { transaction_id: '123', status: 'pending', type: 'waiver', leg: 3, created: 0, roster_ids: [4], adds: { p4: 4 }, drops: {}, settings: { waiver_bid: 5 } };
const schedule = [
  { week: 3, home: 'KC', away: 'SF', status: 'pre_game', date: '2026-09-27' },
  { week: 3, home: 'DAL', away: 'NYG', status: 'pre_game', date: '2026-09-27' },
];
const espnBase = (owners: string[]) => ({
  scoringPeriodId: 3, status: { currentMatchupPeriod: 3 },
  settings: { name: 'Synthetic ESPN', isPublic: false, rosterSettings: { lineupSlotCounts: { '0': 1, '20': 2, '21': 1 } }, acquisitionSettings: { isUsingAcquisitionBudget: false }, scoringSettings: { scoringItems: [] } },
  teams: [{ id: 2, name: 'Team Two', owners, primaryOwner: owners[0], waiverRank: 1 }],
  members: owners.map((id) => ({ id })),
});
const espnEntry = (id: number, slot: number, injury = 'ACTIVE', eligible = [0, 20]) => ({ playerId: id, lineupSlotId: slot, playerPoolEntry: { lineupLocked: false, player: { id, fullName: `Qb ${id}`, defaultPositionId: 1, eligibleSlots: eligible, injuryStatus: injury } } });
const espnRoster = { teams: [{ id: 2, roster: { entries: [espnEntry(11, 0), espnEntry(12, 20), espnEntry(13, 20, 'OUT', [0, 20, 21])] } }] };
const espnFreeAgents = { players: [{ id: 99, status: 'FREEAGENT', onTeamId: 0, player: { id: 99, fullName: 'Fa Ninetynine', defaultPositionId: 1, injuryStatus: 'ACTIVE', ownership: { percentOwned: 1 } } }] };
const espnTransactions = { transactions: [{ id: 't1', teamId: 2, isPending: true, executionType: 'EXECUTE', type: 'WAIVER', scoringPeriodId: 3, bidAmount: 0, items: [{ type: 'ADD', playerId: 99 }] }] };

// ---------------------------------------------------------------- scripted fetch

type Call = { url: URL; method: string; body: any };
let calls: Call[] = [];
type Script = {
  me?: any;
  meErrors?: string[];
  owner?: string;
  espnOwners?: string[];
  gqlErrors?: string[];
  leagueName?: string;
  status?: (u: URL) => number | undefined;
  throwOn?: (u: URL) => boolean;
  reflect?: string;
  beforeResponse?: (u: URL, body: any) => void;
};
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });

function script(s: Script = {}) {
  calls = [];
  globalThis.fetch = (async (input: any, init: any = {}) => {
    const url = new URL(typeof input === 'string' ? input : input.url);
    const method = String(init.method ?? 'GET').toUpperCase();
    let body: any = null;
    if (init.body) {
      try {
        body = JSON.parse(init.body);
      } catch {
        /* not JSON */
      }
    }
    calls.push({ url, method, body });
    s.beforeResponse?.(url, body);
    if (s.throwOn?.(url)) throw new Error(`connect failed ${s.reflect ?? ''}`);
    const st = s.status?.(url);
    if (st) return json({ messages: [`Unauthorized ${s.reflect ?? ''}`] }, st);
    const p = url.pathname;
    if (url.host === 'api.sleeper.app') {
      if (p === '/v1/state/nfl') return json(sleeperState);
      if (p === `/v1/league/${S_LEAGUE}`) return json(sleeperLeague(s.leagueName ?? 'Synthetic League'));
      if (p === `/v1/league/${S_LEAGUE}/rosters`) return json(rosters(s.owner ?? 'u1'));
      if (p === `/v1/league/${S_LEAGUE}/matchups/3`) return json(matchups);
      if (p === `/v1/league/${S_LEAGUE}/users`) return json([{ user_id: 'u1', display_name: 'Me' }]);
      if (p === '/v1/players/nfl') return json(players);
      if (p.startsWith('/v1/players/nfl/trending')) return json([]);
      if (p === '/schedule/nfl/regular/2026') return json(schedule);
    }
    if (url.host === 'sleeper.com' && p === '/graphql') {
      const op = body?.operationName;
      if (op === 'me') return json(s.meErrors ? { errors: s.meErrors.map((message) => ({ message })) } : { data: { me: s.me ?? { user_id: 'u1', display_name: 'Me' } } });
      if (s.gqlErrors) return json({ errors: s.gqlErrors.map((message) => ({ message })) });
      if (op === 'league_transactions_filtered') return json({ data: { league_transactions_filtered: [pendingClaim] } });
      if (op === 'update_matchup_leg') return json({ data: { update_matchup_leg: { starters: JSON.parse(body.query.match(/starters: (\[[^\]]*\])/)[1]) } } });
      return json({ data: {} });
    }
    if (url.host === 'lm-api-reads.fantasy.espn.com') {
      if (p.endsWith('/games/ffl')) return json({ currentSeasonId: 2026 });
      if (url.search.includes('view=mRoster')) return json(espnRoster);
      if (url.search.includes('view=kona_player_info')) return json(espnFreeAgents);
      if (url.search.includes('view=mTransactions2')) return json(espnTransactions);
      return json(espnBase(s.espnOwners ?? [SWID]));
    }
    if (url.host === 'lm-api-writes.fantasy.espn.com') return json({ status: 'EXECUTED', id: 'tx1' });
    return json({}, 404);
  }) as any;
}

const isMutation = (c: Call) => (c.url.host === 'sleeper.com' && /^\s*mutation\b/.test(c.body?.query ?? '')) || c.url.host === 'lm-api-writes.fantasy.espn.com';
const mutations = () => calls.filter(isMutation);

async function run(argv: string[]) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const log = console.log;
  const error = console.error;
  console.log = (...a: unknown[]) => stdout.push(a.join(' '));
  console.error = (...a: unknown[]) => stderr.push(a.join(' '));
  try {
    const code = await cli(argv);
    return { code, stdout: stdout.join('\n'), stderr: stderr.join('\n') };
  } finally {
    console.log = log;
    console.error = error;
  }
}

const realFetch = globalThis.fetch;
beforeEach(() => {
  for (const k of ['SLEEPER_TOKEN', 'ESPN_S2', 'ESPN_SWID', 'FF_CONFIG']) delete process.env[k];
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

const lineupMutation = (leagueId: string, rosterId: number) => `mutation update_matchup_leg($starters_games: Map) {
        update_matchup_leg(league_id: "${leagueId}",roster_id: ${rosterId},leg: 3,round: 3,starters: ["p3","p2"],starters_games: $starters_games){
          league_id leg matchup_id roster_id round starters players points
        }
      }`;
const espnLineup = (teamId: number) => ({ isLeagueManager: false, teamId, type: 'ROSTER', scoringPeriodId: 3, executionType: 'EXECUTE', items: [{ playerId: 12, type: 'LINEUP', fromLineupSlotId: 20, toLineupSlotId: 0 }] });

// ---------------------------------------------------------------- boundary

describe('write boundary: the guard runs inside gql() and espnWrite()', () => {
  test('a mismatched Sleeper body never reaches the network', async () => {
    script();
    await expect(gql(home, lineupMutation(S_OTHER, 4), {})).rejects.toThrow(/targets league/);
    await expect(gql(home, lineupMutation(S_LEAGUE, 3), {})).rejects.toThrow(/roster 3/);
    expect(mutations()).toHaveLength(0);
  });
  test('a mutation named me is not the identity query and never reaches the network', async () => {
    script();
    const spoof = `mutation me { league_create_transaction(league_id: "${S_OTHER}", type: "free_agent", k_adds: [], v_adds: [], k_drops: ["p1"], v_drops: [9]) { status } }`;
    await expect(gql(null, spoof, {})).rejects.toThrow(/canonical identity query/);
    await expect(gql(home, spoof, {})).rejects.toThrow(/canonical identity query/);
    expect(calls).toHaveLength(0);
  });
  test('a mismatched ESPN body never reaches the network', async () => {
    script();
    await expect(espnWrite(work, 2026, espnLineup(3))).rejects.toThrow(/teamId/);
    await expect(espnWrite(work, 2026, { ...espnLineup(2), isLeagueManager: true })).rejects.toThrow(/manager/);
    expect(mutations()).toHaveLength(0);
  });
  test('the same fixtures let a matching body through, so the refusals above are the guard', async () => {
    script();
    await gql(home, lineupMutation(S_LEAGUE, 4), {});
    await espnWrite(work, 2026, espnLineup(2));
    expect(mutations()).toHaveLength(2);
  });
});

describe('write boundary: what was validated is what gets sent', () => {
  test('Sleeper: inputs mutated during the ownership read do not reach the wire', async () => {
    const lg = { ...home };
    const vars = { k_drops: ['p3'], v_drops: [4] };
    const validated = JSON.parse(JSON.stringify({ operationName: 'league_create_transaction', variables: vars, query: sleeperDropQuery(S_LEAGUE) }));
    script({
      beforeResponse: (u) => {
        if (u.pathname.endsWith('/rosters')) {
          vars.k_drops.push('p1');
          vars.v_drops[0] = 9;
          lg.leagueId = S_OTHER;
          lg.rosterId = 9;
        }
      },
    });
    await gql(lg, sleeperDropQuery(S_LEAGUE), vars);
    expect(vars.k_drops).toEqual(['p3', 'p1']);
    const sent = mutations();
    expect(sent).toHaveLength(1);
    expect(sent[0].body).toEqual(validated);
    expect(calls.some((c) => c.url.pathname === `/v1/league/${S_LEAGUE}/rosters`)).toBe(true);
    expect(calls.some((c) => c.url.pathname.includes(S_OTHER))).toBe(false);
  });
  test('ESPN: inputs mutated during the owners read do not reach the wire', async () => {
    const lg = { ...work };
    const body = espnLineup(2);
    const validated = JSON.parse(JSON.stringify(body));
    script({
      beforeResponse: (u) => {
        if (u.host === 'lm-api-reads.fantasy.espn.com') {
          body.teamId = 3;
          body.items[0].toLineupSlotId = 99;
          (body as any).isLeagueManager = true;
          lg.leagueId = '20000009';
        }
      },
    });
    await espnWrite(lg, 2026, body);
    expect(body.teamId).toBe(3);
    const sent = mutations();
    expect(sent).toHaveLength(1);
    expect(sent[0].body).toEqual(validated);
    expect(sent[0].url.pathname).toContain(`/leagues/${E_LEAGUE}/`);
  });
});

describe('ownership is checked at the boundary before any mutation', () => {
  test('Sleeper: another user, no user, or an auth error', async () => {
    script({ me: { user_id: 'u2' } });
    await expect(gql(home, lineupMutation(S_LEAGUE, 4), {})).rejects.toThrow(/does not own roster 4/);
    script({ me: {} });
    await expect(gql(home, lineupMutation(S_LEAGUE, 4), {})).rejects.toThrow(/no user/);
    script({ meErrors: ['Unauthorized'] });
    await expect(gql(home, lineupMutation(S_LEAGUE, 4), {})).rejects.toThrow(/auth from sleeper\.com/);
    expect(mutations()).toHaveLength(0);
  });
  test('ESPN gateway mode without the assertion refuses', async () => {
    script();
    const { identity, ...unasserted } = work;
    await expect(espnWrite(unasserted, 2026, espnLineup(2))).rejects.toThrow(/gateway-asserted/);
    expect(mutations()).toHaveLength(0);
  });
  test('ESPN gateway mode with the assertion but a member who is not an owner refuses', async () => {
    script({ espnOwners: [OTHER_SWID] });
    await expect(espnWrite(work, 2026, espnLineup(2))).rejects.toThrow(/not an owner of team 2/);
    expect(mutations()).toHaveLength(0);
  });
  test('ESPN cookie mode with a SWID that is not the configured member refuses', async () => {
    process.env.ESPN_S2 = 'AEBcookievalue1234';
    process.env.ESPN_SWID = OTHER_SWID;
    script();
    await expect(espnWrite(work, 2026, espnLineup(2))).rejects.toThrow(/ESPN_SWID is not the memberId/);
    expect(mutations()).toHaveLength(0);
  });
  test('ESPN gateway mode without the assertion still reads and dry-runs through the CLI', async () => {
    script();
    const { identity, ...unasserted } = work;
    const cfg = config([unasserted]);
    const roster = await run(['--config', cfg, 'roster', 'work']);
    expect(roster.code).toBe(0);
    expect(roster.stdout).toContain('Qb 11');
    const dry = await run(['--config', cfg, 'set-lineup', 'work', '--swap', '12:11']);
    expect(dry.stdout).toContain('"dryRun": true');
    const confirmed = await run(['--config', cfg, 'set-lineup', 'work', '--swap', '12:11', '--confirm']);
    expect(confirmed.stderr).toMatch(/gateway-asserted/);
    expect(mutations()).toHaveLength(0);
  });
});

// ---------------------------------------------------------------- config resolution

describe('config resolution fails closed: a named path that is missing never falls through', () => {
  const decoy = config([{ ...home, alias: 'home', rosterId: 9 }]);
  const cwdWith = (file: string | null) => {
    const d = mkdtempSync(join(dir, 'cwd-'));
    if (file) writeFileSync(join(d, 'fantasy.config.json'), JSON.stringify({ leagues: [home, work] }));
    return d;
  };
  const inCwd = async <T,>(d: string, f: () => Promise<T>) => {
    const prev = process.cwd();
    process.chdir(d);
    try {
      return await f();
    } finally {
      process.chdir(prev);
    }
  };
  test('(a) --config missing while FF_CONFIG is valid: non-zero exit, zero fetch calls, even for a confirmed write', async () => {
    process.env.FF_CONFIG = decoy;
    script();
    const r = await run(['--config', join(dir, 'missing.json'), 'set-lineup', 'home', '--swap', 'p3:p1', '--confirm']);
    expect(r.code).toBe(1);
    expect(r.stderr).toBe(`error: league config ${join(dir, 'missing.json')} not found`);
    expect(calls).toHaveLength(0);
  });
  test('(b) FF_CONFIG missing while ./fantasy.config.json is valid: same', async () => {
    process.env.FF_CONFIG = join(dir, 'missing-env.json');
    script();
    const r = await inCwd(cwdWith('fantasy.config.json'), () => run(['set-lineup', 'home', '--swap', 'p3:p1', '--confirm']));
    expect(r.code).toBe(1);
    expect(r.stderr).toBe(`error: league config ${join(dir, 'missing-env.json')} not found`);
    expect(calls).toHaveLength(0);
  });
  test('(d) an empty --config or FF_CONFIG is refused, never treated as unset', async () => {
    process.env.FF_CONFIG = decoy;
    for (const args of [['--config=', 'set-lineup'], ['--config', '', 'set-lineup']]) {
      script();
      const r = await run([...args, 'home', '--swap', 'p3:p1', '--confirm']);
      expect(r.code).toBe(1);
      expect(r.stderr).toBe('error: league config path is empty');
      expect(calls).toHaveLength(0);
    }
    process.env.FF_CONFIG = '';
    script();
    const r = await inCwd(cwdWith('fantasy.config.json'), () => run(['set-lineup', 'home', '--swap', 'p3:p1', '--confirm']));
    expect(r.code).toBe(1);
    expect(r.stderr).toBe('error: league config path is empty');
    expect(calls).toHaveLength(0);
  });
  test('(c) with neither set, ./fantasy.config.json is found', async () => {
    script();
    const r = await inCwd(cwdWith('fantasy.config.json'), () => run(['leagues']));
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(`"leagueId": "${S_LEAGUE}"`);
    const none = await inCwd(cwdWith(null), () => run(['leagues']));
    expect(none.code).toBe(1);
    expect(none.stderr).toMatch(/no league config found; looked for fantasy\.config\.json, .*\/\.config\/fantasy-football\/config\.json/);
  });
});

// ---------------------------------------------------------------- commands

describe('commands: dry run by default', () => {
  test.each([
    ['sleeper set-lineup', ['set-lineup', 'home', '--swap', 'p3:p1']],
    ['sleeper ir', ['ir', 'home', '--place', 'p3']],
    ['sleeper claim', ['claim', 'home', '--add', 'p4', '--drop', 'p3', '--bid', '5']],
    ['sleeper drop', ['drop', 'home', '--player', 'p3']],
    ['sleeper cancel-claim', ['cancel-claim', 'home', '--id', '123']],
    ['espn set-lineup', ['set-lineup', 'work', '--swap', '12:11']],
    ['espn ir', ['ir', 'work', '--place', '13']],
    ['espn claim', ['claim', 'work', '--add', '99', '--drop', '12']],
    ['espn drop', ['drop', 'work', '--player', '12']],
    ['espn cancel-claim', ['cancel-claim', 'work', '--id', 't1']],
  ])('%s without --confirm sends no mutation', async (_n, argv) => {
    script();
    const r = await run(['--config', CFG, ...argv]);
    expect(r.stderr).toBe('');
    expect(r.stdout).toContain('"dryRun": true');
    expect(mutations()).toHaveLength(0);
  });
});

describe('commands: confirmed writes report the readback honestly', () => {
  test('sleeper set-lineup whose readback still shows the old lineup is verified: false', async () => {
    script();
    const r = await run(['--config', CFG, 'set-lineup', 'home', '--swap', 'p3:p1', '--confirm']);
    expect(r.stderr).toBe('');
    expect(r.stdout).toContain('"applied": true');
    expect(r.stdout).toContain('"serverAck": true');
    expect(r.stdout).toContain('"verified": false');
    expect(mutations()).toHaveLength(1);
  }, 20_000);
  test('espn set-lineup whose readback still shows the old slots is verified: false', async () => {
    script();
    const r = await run(['--config', CFG, 'set-lineup', 'work', '--swap', '12:11', '--confirm']);
    expect(r.stderr).toBe('');
    expect(r.stdout).toContain('"applied": true');
    expect(r.stdout).toContain('"verified": false');
    expect(mutations()).toHaveLength(1);
  }, 20_000);
});

// ---------------------------------------------------------------- secrets

const SECRET = 'AEBopaque7Cookie9Value%2Fwith%2Bslash';
const forms = [SECRET, encodeURIComponent(SECRET), decodeURIComponent(SECRET)];
const expectClean = (r: { stdout: string; stderr: string }) => {
  for (const f of forms) {
    expect(r.stdout).not.toContain(f);
    expect(r.stderr).not.toContain(f);
  }
};

describe('a credential reflected by the platform never reaches stdout or stderr (no env set)', () => {
  test('authenticated non-2xx on both platforms, through auth-check all', async () => {
    script({ status: (u) => (u.host === 'sleeper.com' || u.host.endsWith('fantasy.espn.com') ? 401 : undefined), reflect: SECRET });
    const r = await run(['--config', CFG, 'auth-check', 'all']);
    expect(r.code).toBe(1);
    expect(r.stdout).toContain('auth from sleeper.com/graphql');
    expect(r.stdout).toContain('auth from lm-api-reads.fantasy.espn.com');
    expectClean(r);
  });
  test('HTTP-200 GraphQL errors', async () => {
    script({ gqlErrors: [`weird failure ${SECRET}`] });
    const r = await run(['--config', CFG, 'waivers', 'home']);
    expect(r.stderr).toContain('platform-rejected from sleeper.com/graphql');
    expectClean(r);
  });
  test('a thrown fetch error', async () => {
    script({ throwOn: (u) => u.host === 'lm-api-reads.fantasy.espn.com', reflect: SECRET });
    const r = await run(['--config', CFG, 'roster', 'work']);
    expect(r.stderr).toContain('transport from lm-api-reads.fantasy.espn.com');
    expectClean(r);
  });
  test.each([
    'Unauthorized',
    'You have players on your IR slot that are no longer IR eligible',
    'Player is locked',
    'Roster is full',
    'Player is not eligible for slot',
    'Bid exceeds budget',
    'You already have a pending claim',
    'Trade deadline has passed',
    'Player not found',
  ])('recognized rejection "%s" with the credential embedded prints only the fixed text', async (template) => {
    script({ gqlErrors: [`${template} ${SECRET}`] });
    const r = await run(['--config', CFG, 'waivers', 'home']);
    expect(r.stderr).toMatch(/^error: (auth|platform-rejected) from sleeper\.com\/graphql: /);
    expectClean(r);
  });
  test('with the token in env the same reflection is still absent', async () => {
    process.env.SLEEPER_TOKEN = SECRET;
    script({ status: (u) => (u.host === 'sleeper.com' ? 401 : undefined), reflect: SECRET });
    const r = await run(['--config', CFG, 'auth-check', 'home']);
    expectClean(r);
  });
});

describe('a known credential value is redacted wherever it shows up in output (env set)', () => {
  beforeEach(() => {
    process.env.SLEEPER_TOKEN = SECRET;
    process.env.ESPN_S2 = SECRET;
    process.env.ESPN_SWID = SWID;
  });
  test('as an unknown league alias', async () => {
    script();
    const r = await run(['--config', CFG, 'roster', SECRET]);
    expect(r.stderr).toContain('league "[redacted]" is not in your config');
    expectClean(r);
  });
  test('as a player name on either platform', async () => {
    script();
    const s = await run(['--config', CFG, 'set-lineup', 'home', '--swap', `${SECRET}:p1`]);
    expect(s.stderr).toContain('"[redacted]" not found');
    expectClean(s);
    const e = await run(['--config', CFG, 'set-lineup', 'work', '--swap', `${SECRET}:11`]);
    expect(e.stderr).toContain('"[redacted]" not found');
    expectClean(e);
  });
  test('inside a returned field', async () => {
    script({ leagueName: `League ${SECRET}` });
    const r = await run(['--config', CFG, 'roster', 'home']);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('"league": "League [redacted]"');
    expectClean(r);
  });
});
