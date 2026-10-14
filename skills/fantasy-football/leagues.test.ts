import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { authHeaders, categoryForStatus, configSearchPaths, diagnose, http, loadConfig, parseConfig, redact, rejected, resolveLeague } from './leagues.ts';

const SWID = '{AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA}';
const sleeper = { alias: 'home', platform: 'sleeper', leagueId: '100000000000000001', rosterId: 4 };
const espn = { alias: 'work', platform: 'espn', leagueId: '20000001', teamId: 2, memberId: SWID };

const realFetch = globalThis.fetch;
beforeEach(() => {
  for (const k of ['SLEEPER_TOKEN', 'ESPN_S2', 'ESPN_SWID', 'FF_CONFIG']) delete process.env[k];
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

describe('config', () => {
  test('accepts a sleeper and an espn league, with the optional gateway assertion', () => {
    const got = parseConfig({ leagues: [sleeper, { ...espn, identity: 'gateway-asserted' }] });
    expect(got).toEqual([sleeper, { ...espn, identity: 'gateway-asserted' }] as any);
  });
  test.each([
    ['no leagues', {}, /leagues/],
    ['empty leagues', { leagues: [] }, /at least one/],
    ['bad alias', { leagues: [{ ...sleeper, alias: 'Home Team' }] }, /alias/],
    ['duplicate alias', { leagues: [sleeper, { ...sleeper, leagueId: '100000000000000002' }] }, /used twice/],
    ['bad platform', { leagues: [{ ...sleeper, platform: 'yahoo' }] }, /platform/],
    ['non-digit league id', { leagues: [{ ...sleeper, leagueId: 'abc' }] }, /leagueId/],
    ['missing roster', { leagues: [{ ...sleeper, rosterId: 0 }] }, /rosterId/],
    ['missing team', { leagues: [{ ...espn, teamId: '2' }] }, /teamId/],
    ['missing member', { leagues: [{ ...espn, memberId: undefined }] }, /memberId/],
    ['bad member', { leagues: [{ ...espn, memberId: 'AAAA' }] }, /memberId/],
    ['bad identity', { leagues: [{ ...espn, identity: 'trusted' }] }, /identity/],
    ['unknown key', { leagues: [{ ...sleeper, identify: 'x' }] }, /unknown key/],
    ['espn key on sleeper', { leagues: [{ ...sleeper, memberId: SWID }] }, /unknown key/],
  ])('rejects %s', (_n, raw, re) => {
    expect(() => parseConfig(raw)).toThrow(re);
  });
  test('a named config path is authoritative and a missing one fails closed', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ff-cfg-'));
    const valid = join(dir, 'valid.json');
    writeFileSync(valid, JSON.stringify({ leagues: [sleeper] }));
    process.env.FF_CONFIG = valid;
    expect(configSearchPaths('/nonexistent/explicit.json')).toEqual(['/nonexistent/explicit.json']);
    expect(() => loadConfig('/nonexistent/explicit.json')).toThrow(/^league config \/nonexistent\/explicit\.json not found$/);
    process.env.FF_CONFIG = '/nonexistent/ff.json';
    expect(configSearchPaths()).toEqual(['/nonexistent/ff.json']);
    expect(() => loadConfig()).toThrow(/^league config \/nonexistent\/ff\.json not found$/);
    delete process.env.FF_CONFIG;
    expect(configSearchPaths()).toEqual(['fantasy.config.json', `${process.env.HOME}/.config/fantasy-football/config.json`]);
  });
  test('an unreadable named config fails closed', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ff-cfg-'));
    expect(() => loadConfig(dir)).toThrow(/is not readable/);
  });
  test('loadConfig reads an explicit path and refuses bad JSON', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ff-cfg-'));
    const good = join(dir, 'good.json');
    writeFileSync(good, JSON.stringify({ leagues: [sleeper] }));
    expect(loadConfig(good)).toEqual([sleeper] as any);
    const bad = join(dir, 'bad.json');
    writeFileSync(bad, '{ not json');
    expect(() => loadConfig(bad)).toThrow(/not valid JSON/);
  });
  test('resolveLeague refuses anything outside the config', () => {
    const leagues = parseConfig({ leagues: [sleeper] });
    expect(resolveLeague('home', leagues).leagueId).toBe(sleeper.leagueId);
    expect(resolveLeague(sleeper.leagueId, leagues).alias).toBe('home');
    expect(() => resolveLeague('other', leagues)).toThrow(/not in your config/);
    expect(() => resolveLeague('100000000000000002', leagues)).toThrow(/not in your config/);
    expect(() => resolveLeague(undefined, leagues)).toThrow(/league required/);
  });
});

describe('credentials', () => {
  test('no env means no header on any host (gateway mode)', () => {
    expect(authHeaders('https://sleeper.com/graphql')).toEqual({});
    expect(authHeaders('https://lm-api-writes.fantasy.espn.com/x')).toEqual({});
  });
  test('SLEEPER_TOKEN goes out raw, only to sleeper.com', () => {
    process.env.SLEEPER_TOKEN = 'tok.en.value';
    expect(authHeaders('https://sleeper.com/graphql')).toEqual({ authorization: 'tok.en.value' });
    expect(authHeaders('https://api.sleeper.app/v1/state/nfl')).toEqual({});
  });
  test('ESPN cookies go out as a cookie pair, and one without the other is refused', () => {
    process.env.ESPN_S2 = 'AEB%2Fabc';
    process.env.ESPN_SWID = SWID;
    expect(authHeaders('https://lm-api-reads.fantasy.espn.com/apis')).toEqual({ cookie: `espn_s2=AEB%2Fabc; SWID=${SWID}` });
    expect(authHeaders('https://site.api.espn.com/apis')).toEqual({});
    delete process.env.ESPN_SWID;
    expect(() => authHeaders('https://lm-api-reads.fantasy.espn.com/apis')).toThrow(/both ESPN_S2 and ESPN_SWID/);
  });
  test('redact removes known values in raw, encoded and decoded forms', () => {
    process.env.ESPN_S2 = 'AEB%2Fsecret%2Bvalue';
    expect(redact('got AEB%2Fsecret%2Bvalue and AEB/secret+value and AEB%252Fsecret%252Bvalue')).toBe('got [redacted] and [redacted] and [redacted]');
    expect(redact('plain text')).toBe('plain text');
  });
});

const SECRET = 'AEBopaque7Cookie9Value%2Fwith%2Bslash';
const forms = [SECRET, encodeURIComponent(SECRET), decodeURIComponent(SECRET)];
const expectClean = (text: string) => {
  for (const f of forms) expect(text).not.toContain(f);
};

describe('diagnostics own every word they print', () => {
  test('status maps to a category', () => {
    expect(categoryForStatus(401)).toBe('auth');
    expect(categoryForStatus(403)).toBe('forbidden');
    expect(categoryForStatus(404)).toBe('not-found');
    expect(categoryForStatus(429)).toBe('rate-limited');
    expect(categoryForStatus(503)).toBe('server');
    expect(categoryForStatus(400)).toBe('platform-rejected');
  });
  const url = new URL('https://sleeper.com/graphql');
  test.each([
    ['Unauthorized', /auth from sleeper\.com\/graphql: credential missing or expired/],
    ['You have players on your IR slot that are no longer IR eligible', /IR slot holds a player/],
    ['Player is locked', /locked: game started/],
    ['Roster is full', /roster full/],
    ['Player is not eligible for slot', /not eligible for that slot/],
    ['Bid exceeds budget', /bid rejected/],
    ['You already have a pending claim', /duplicate claim/],
    ['Trade deadline has passed', /trade deadline/],
    ['Player not found', /not on the roster or not available/],
  ])('recognized rejection "%s" prints a fixed string, never the upstream text', (upstream, re) => {
    const withSecret = `${upstream} ${SECRET} tail`;
    const msg = diagnose('platform-rejected', url, [withSecret]);
    expect(msg).toMatch(re);
    expectClean(msg);
    expect(msg).not.toContain('tail');
  });
  test('an unrecognized rejection prints only the category', () => {
    const msg = diagnose('platform-rejected', url, [`something new ${SECRET}`]);
    expect(msg).toBe('platform-rejected from sleeper.com/graphql: the platform rejected the request; upstream detail withheld');
  });
  test('rejected() throws the same shape', () => {
    expect(() => rejected('https://sleeper.com/graphql', [`weird ${SECRET}`])).toThrow(/platform-rejected from sleeper\.com\/graphql/);
  });
});

const respond = (status: number, body: string) => (async () => new Response(body, { status })) as any;

describe('http transport', () => {
  test('authenticated host non-2xx: category and host only, body dropped', async () => {
    globalThis.fetch = respond(401, JSON.stringify({ messages: [`Unauthorized ${SECRET}`] }));
    let msg = '';
    await http('https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl').catch((e) => (msg = e.message));
    expect(msg).toMatch(/^auth from lm-api-reads\.fantasy\.espn\.com\/apis\/v3\/games\/ffl: credential missing/);
    expectClean(msg);
  });
  test('authenticated host 500 with a raw text body', async () => {
    globalThis.fetch = respond(500, `<html>${SECRET}</html>`);
    let msg = '';
    await http('https://sleeper.com/graphql', { method: 'POST' }).catch((e) => (msg = e.message));
    expect(msg).toMatch(/^server from sleeper\.com\/graphql/);
    expectClean(msg);
  });
  test('authenticated host transport failure never surfaces the exception text', async () => {
    globalThis.fetch = (async () => {
      throw new Error(`socket hang up ${SECRET}`);
    }) as any;
    let msg = '';
    await http('https://sleeper.com/graphql').catch((e) => (msg = e.message));
    expect(msg).toBe('transport from sleeper.com/graphql: no response (network, DNS or timeout)');
  });
  test('public host keeps a short excerpt, redacted', async () => {
    process.env.SLEEPER_TOKEN = 'tok.en.value1';
    globalThis.fetch = respond(404, JSON.stringify({ message: 'league tok.en.value1 missing' }));
    let msg = '';
    await http('https://api.sleeper.app/v1/league/1').catch((e) => (msg = e.message));
    expect(msg).toBe('HTTP 404 from api.sleeper.app/v1/league/1: league [redacted] missing');
  });
  test('2xx returns parsed JSON, or null for an empty or non-JSON body', async () => {
    globalThis.fetch = respond(200, '{"ok":1}');
    expect(await http('https://api.sleeper.app/v1/state/nfl')).toEqual({ ok: 1 });
    globalThis.fetch = respond(200, '');
    expect(await http('https://api.sleeper.app/v1/state/nfl')).toBeNull();
  });
});
