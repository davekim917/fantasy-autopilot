import { describe, expect, test } from 'bun:test';

import { assertEspnBody, assertSleeperBody, sleeperDropQuery } from './fantasy.ts';

const home = { platform: 'sleeper' as const, alias: 'home', leagueId: '100000000000000001', rosterId: 7 };
const work = { platform: 'espn' as const, alias: 'work', leagueId: '20000001', teamId: 8, memberId: '{AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA}' };

const claim = (leagueId: string, roster: number) => ({
  operationName: 'submit_waiver_claim',
  variables: { k_adds: ['10867'], v_adds: [roster], k_drops: [], v_drops: [] },
  query: `mutation submit_waiver_claim($k_adds: [String], $v_adds: [Int], $k_drops: [String], $v_drops: [Int]) {
        submit_waiver_claim(league_id: "${leagueId}",k_adds: $k_adds,v_adds: $v_adds,k_drops: $k_drops,v_drops: $v_drops){ status }
      }`,
});

describe('Sleeper allowlist guard', () => {
  test('accepts the allowlisted league and roster', () => {
    expect(() => assertSleeperBody(claim(home.leagueId, 7), home)).not.toThrow();
  });
  test('rejects another league id inside the GraphQL body', () => {
    expect(() => assertSleeperBody(claim('100000000000000002', 7), home)).toThrow(/targets league/);
  });
  test('rejects another roster in variables', () => {
    expect(() => assertSleeperBody(claim(home.leagueId, 3), home)).toThrow(/roster/);
  });
  test('rejects a league id bound through a variable', () => {
    const body = {
      operationName: 'league_transactions_filtered',
      variables: { league_id: '999' },
      query: 'query league_transactions_filtered($league_id: String!) { league_transactions_filtered(league_id: $league_id) { status } }',
    };
    expect(() => assertSleeperBody(body, home)).toThrow(/variable/);
  });
  test('rejects a decoy comment and a smuggled second league id', () => {
    const b = claim(home.leagueId, 7);
    expect(() => assertSleeperBody({ ...b, query: b.query + ' # league_id: "1"' }, home)).toThrow();
    expect(() => assertSleeperBody({ ...b, query: b.query.replace('){ status }', '){ status } other: submit_waiver_claim(league_id: "1"){ status }') }, home)).toThrow(/targets league/);
  });
  test('only the canonical identity query is exempt; a mutation named me is not', () => {
    expect(() => assertSleeperBody({ operationName: 'me', variables: {}, query: 'query me { me { user_id display_name } }' }, home)).not.toThrow();
    expect(() => assertSleeperBody({ operationName: 'me', variables: {}, query: `mutation me { league_create_transaction(league_id: "999", type: "free_agent") { status } }` }, home)).toThrow(/canonical identity query/);
    expect(() => assertSleeperBody({ operationName: 'me', variables: { x: 1 }, query: 'query me { me { user_id display_name } }' }, home)).toThrow(/canonical identity query/);
  });
  test('rejects trade proposals and unknown operations', () => {
    expect(() => assertSleeperBody({ operationName: 'propose_trade', variables: {}, query: `mutation propose_trade { propose_trade(league_id: "${home.leagueId}") { status } }` }, home)).toThrow(/not permitted/);
  });
  test('rejects a roster_id literal for another team', () => {
    const q = `mutation update_matchup_leg { update_matchup_leg(league_id: "${home.leagueId}",roster_id: 3,leg: 2,round: 2,starters: []){ starters } }`;
    expect(() => assertSleeperBody({ operationName: 'update_matchup_leg', variables: {}, query: q }, home)).toThrow(/roster 3/);
  });
});

describe('ESPN allowlist guard', () => {
  const base = { isLeagueManager: false, teamId: 8, type: 'ROSTER', scoringPeriodId: 2, executionType: 'EXECUTE', items: [{ playerId: 1, type: 'LINEUP', fromLineupSlotId: 20, toLineupSlotId: 0 }] };
  test('accepts own-team lineup move', () => expect(() => assertEspnBody(base, work, 'm')).not.toThrow());
  test('rejects other team', () => expect(() => assertEspnBody({ ...base, teamId: 3 }, work, 'm')).toThrow(/teamId/));
  test('rejects league-manager action', () => expect(() => assertEspnBody({ ...base, isLeagueManager: true }, work, 'm')).toThrow(/manager/));
  test('rejects trade types and cross-team items', () => {
    expect(() => assertEspnBody({ ...base, type: 'TRADE_PROPOSAL' }, work, 'm')).toThrow(/not permitted/);
    expect(() => assertEspnBody({ ...base, type: 'WAIVER', memberId: 'm', items: [{ playerId: 1, type: 'ADD', toTeamId: 5 }] }, work, 'm')).toThrow(/toTeamId/);
  });
  test('rejects a memberId that is not the resolved owner', () => {
    expect(() => assertEspnBody({ ...base, type: 'WAIVER', memberId: 'other' }, work, 'm')).toThrow(/memberId/);
  });
});

describe('drop-only transactions', () => {
  const canonical = sleeperDropQuery(home.leagueId);
  const drop = (query = canonical, variables: Record<string, unknown> = { k_drops: ['2307'], v_drops: [7] }) => ({ operationName: 'league_create_transaction', variables, query });
  test('accepts the canonical free-agent drop from the allowlisted roster', () => expect(() => assertSleeperBody(drop(), home)).not.toThrow());
  test.each([
    ['commissioner type', canonical.replace('"free_agent"', '"commissioner"')],
    ['literal add', canonical.replace('k_adds: []', 'k_adds: ["10867"]')],
    ['comma-split add', canonical.replace('k_adds: []', 'k_adds , : ["10867"]')],
    ['literal other-roster drop', canonical.replace('v_drops: $v_drops', 'v_drops: [3]')],
    ['another league', sleeperDropQuery('100000000000000002')],
  ])('rejects any non-canonical query: %s', (_name, query) => {
    expect(() => assertSleeperBody(drop(query), home)).toThrow();
  });
  test('rejects adds, other rosters and empty drops in variables', () => {
    expect(() => assertSleeperBody(drop(canonical, { k_drops: ['2307'], v_drops: [7], k_adds: ['10867'] }), home)).toThrow(/only k_drops/);
    expect(() => assertSleeperBody(drop(canonical, { k_drops: ['2307'], v_drops: [3] }), home)).toThrow(/roster 3/);
    expect(() => assertSleeperBody(drop(canonical, { k_drops: [], v_drops: [] }), home)).toThrow(/matching k_drops/);
  });
  test('rejects a drop transaction smuggled under another operation name', () => {
    const b = claim(home.leagueId, 7);
    const spoof = b.query.replace('){ status }', '){ status } x: league_create_transaction(league_id: "' + home.leagueId + '", type: "commissioner"){ status }');
    expect(() => assertSleeperBody({ ...b, query: spoof }, home)).toThrow(/must not call league_create_transaction/);
  });
  test('ESPN FREEAGENT is accepted only as an own-team drop', () => {
    const body = { isLeagueManager: false, teamId: 8, type: 'FREEAGENT', memberId: 'm', scoringPeriodId: 5, executionType: 'EXECUTE', items: [{ playerId: 1, type: 'DROP', fromTeamId: 8 }] };
    expect(() => assertEspnBody(body, work, 'm')).not.toThrow();
    expect(() => assertEspnBody({ ...body, items: [{ playerId: 1, type: 'ADD', toTeamId: 8 }] }, work, 'm')).toThrow(/drop-only/);
    expect(() => assertEspnBody({ ...body, items: [] }, work, 'm')).toThrow(/drop-only/);
    expect(() => assertEspnBody({ ...body, items: [{ playerId: 1, type: 'DROP', fromTeamId: 3 }] }, work, 'm')).toThrow(/fromTeamId/);
  });
});

describe('Sleeper guard tolerates GraphQL commas', () => {
  test('a comma before a league id literal still names that league', () => {
    const b = claim(home.leagueId, 7);
    expect(() => assertSleeperBody({ ...b, query: b.query.replace(`league_id: "${home.leagueId}"`, 'league_id:, "999"') }, home)).toThrow(/targets league 999/);
  });
  test('a literal roster list in a claim is refused', () => {
    const b = claim(home.leagueId, 7);
    expect(() => assertSleeperBody({ ...b, query: b.query.replace('v_adds: $v_adds', 'v_adds: [3]') }, home)).toThrow(/bound to \$v_adds/);
  });
});
