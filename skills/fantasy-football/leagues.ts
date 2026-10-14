/**
 * Shared by fantasy.ts and optimize.ts: league config, credentials, the one HTTP
 * transport, and the only diagnostics allowed to reach stdout or stderr.
 */
import { existsSync, readFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';

type Json = any;

export type SleeperLeague = { platform: 'sleeper'; alias: string; leagueId: string; rosterId: number };
export type EspnLeague = { platform: 'espn'; alias: string; leagueId: string; teamId: number; memberId: string; identity?: 'gateway-asserted' };
export type League = SleeperLeague | EspnLeague;

export class CliError extends Error {}
export function fail(msg: string): never {
  throw new CliError(msg);
}

// ---------------------------------------------------------------- config

/** An explicit path is authoritative, then $FF_CONFIG; a named path that is missing never falls through to another file. */
export function configSearchPaths(explicit?: string): string[] {
  if (explicit !== undefined) return [explicit];
  if (process.env.FF_CONFIG !== undefined) return [process.env.FF_CONFIG];
  return ['fantasy.config.json', `${homedir()}/.config/fantasy-football/config.json`];
}

export function loadConfig(explicit?: string): League[] {
  const paths = configSearchPaths(explicit);
  if (paths.length === 1 && !paths[0].trim()) fail('league config path is empty');
  const path = paths.find((p) => existsSync(p));
  if (!path) fail(paths.length === 1 ? `league config ${paths[0]} not found` : `no league config found; looked for ${paths.join(', ')} (copy fantasy.config.example.json)`);
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    fail(`league config ${path} is not readable`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    fail(`${path} is not valid JSON`);
  }
  return parseConfig(raw, path);
}

const ALIAS_RE = /^[a-z0-9-]+$/;
const SWID_RE = /^\{[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}\}$/i;
const KEYS: Record<string, string[]> = {
  sleeper: ['alias', 'platform', 'leagueId', 'rosterId'],
  espn: ['alias', 'platform', 'leagueId', 'teamId', 'memberId', 'identity'],
};

export function parseConfig(raw: unknown, source = 'config'): League[] {
  const leagues = (raw as Json)?.leagues;
  if (!Array.isArray(leagues) || leagues.length === 0) fail(`${source}: expected { "leagues": [ ... ] } with at least one league`);
  const seen = new Set<string>();
  return leagues.map((l: Json, i: number): League => {
    const at = `${source}: leagues[${i}]`;
    if (!l || typeof l !== 'object') fail(`${at} must be an object`);
    if (typeof l.alias !== 'string' || !ALIAS_RE.test(l.alias)) fail(`${at}.alias must match ${ALIAS_RE}`);
    if (seen.has(l.alias)) fail(`${at}.alias "${l.alias}" is used twice`);
    seen.add(l.alias);
    if (l.platform !== 'sleeper' && l.platform !== 'espn') fail(`${at}.platform must be "sleeper" or "espn"`);
    if (typeof l.leagueId !== 'string' || !/^\d+$/.test(l.leagueId)) fail(`${at}.leagueId must be a string of digits`);
    for (const k of Object.keys(l)) if (!KEYS[l.platform].includes(k)) fail(`${at}: unknown key "${k}"`);
    const posInt = (v: Json) => Number.isInteger(v) && v > 0;
    if (l.platform === 'sleeper') {
      if (!posInt(l.rosterId)) fail(`${at}.rosterId must be a positive integer`);
      return { platform: 'sleeper', alias: l.alias, leagueId: l.leagueId, rosterId: l.rosterId };
    }
    if (!posInt(l.teamId)) fail(`${at}.teamId must be a positive integer`);
    if (typeof l.memberId !== 'string' || !SWID_RE.test(l.memberId)) fail(`${at}.memberId must be your SWID, a brace-wrapped GUID`);
    if (l.identity !== undefined && l.identity !== 'gateway-asserted') fail(`${at}.identity may only be "gateway-asserted"`);
    return { platform: 'espn', alias: l.alias, leagueId: l.leagueId, teamId: l.teamId, memberId: l.memberId, ...(l.identity ? { identity: l.identity } : {}) };
  });
}

export function resolveLeague(arg: string | undefined, leagues: League[]): League {
  if (!arg) fail('league required: one of ' + leagues.map((l) => l.alias).join(', '));
  const league = leagues.find((l) => l.alias === arg.toLowerCase() || l.leagueId === arg);
  if (!league) fail(`league "${arg}" is not in your config`);
  return league;
}

export const cacheDir = () => process.env.FF_CACHE_DIR || tmpdir();

// ---------------------------------------------------------------- credentials

const isSleeperAuthHost = (host: string) => host === 'sleeper.com';
const isEspnAuthHost = (host: string) => /(^|\.)fantasy\.espn\.com$/.test(host);
export const isAuthenticatedHost = (host: string) => isSleeperAuthHost(host) || isEspnAuthHost(host);

const secrets = () => ({ sleeper: process.env.SLEEPER_TOKEN, s2: process.env.ESPN_S2, swid: process.env.ESPN_SWID });

export function credentialMode(platform: 'sleeper' | 'espn'): 'env' | 'gateway' {
  const s = secrets();
  if (platform === 'sleeper') return s.sleeper ? 'env' : 'gateway';
  if (!!s.s2 !== !!s.swid) fail('set both ESPN_S2 and ESPN_SWID, or neither');
  return s.s2 ? 'env' : 'gateway';
}

/** Nothing is added when the variables are unset: a proxy may inject the credential instead. */
export function authHeaders(url: string): Record<string, string> {
  const host = new URL(url).host;
  const s = secrets();
  if (isSleeperAuthHost(host) && credentialMode('sleeper') === 'env') return { authorization: s.sleeper! };
  if (isEspnAuthHost(host) && credentialMode('espn') === 'env') return { cookie: `espn_s2=${s.s2}; SWID=${s.swid}` };
  return {};
}

const decodeOrSelf = (v: string) => {
  try {
    return decodeURIComponent(v);
  } catch {
    return v;
  }
};

/** Defense in depth only; it cannot see a credential a proxy injected. */
export function redact(text: string): string {
  let out = text;
  for (const v of Object.values(secrets())) {
    if (!v || v.length < 8) continue;
    for (const form of new Set([v, encodeURIComponent(v), decodeOrSelf(v)])) out = out.split(form).join('[redacted]');
  }
  return out;
}

// ---------------------------------------------------------------- diagnostics

export type Category = 'auth' | 'forbidden' | 'not-found' | 'rate-limited' | 'server' | 'transport' | 'platform-rejected';

const HINT: Record<Category, string> = {
  auth: 'credential missing or expired; set SLEEPER_TOKEN or ESPN_S2 + ESPN_SWID, or let your proxy inject them',
  forbidden: 'the platform refused this account for that league or team',
  'not-found': 'league, team or endpoint not found',
  'rate-limited': 'rate limited; retry later',
  server: 'platform error; retry later',
  transport: 'no response (network, DNS or timeout)',
  'platform-rejected': 'the platform rejected the request; upstream detail withheld',
};

/** Upstream text is only ever matched against these; the fixed `text` is what gets printed. */
const KNOWN: Array<{ re: RegExp; category?: Category; text: string }> = [
  { re: /unauthori[sz]ed|not authenticated|login required|invalid token/i, category: 'auth', text: HINT.auth },
  { re: /no longer ir eligible/i, text: 'an IR slot holds a player who is no longer IR-eligible; fix IR in the app before any transaction' },
  { re: /\block(ed)?\b|game (has |already )*started|in progress/i, text: 'player locked: game started' },
  { re: /roster (is )?full|exceeds? (the )?roster|too many players/i, text: 'roster full' },
  { re: /not eligible|ineligible/i, text: 'player not eligible for that slot or move' },
  { re: /\bbid\b|budget|faab/i, text: 'bid rejected: invalid amount or over budget' },
  { re: /already (has|have|exists|pending)|duplicate|pending claim/i, text: 'duplicate claim' },
  { re: /deadline|trades? (are )?disabled/i, text: 'past the trade deadline or trades disabled' },
  { re: /not on (your |the )?roster|does not own|not owned|invalid player|player not found/i, text: 'player not on the roster or not available' },
];

export function categoryForStatus(status: number): Category {
  if (status === 401) return 'auth';
  if (status === 403) return 'forbidden';
  if (status === 404) return 'not-found';
  if (status === 429) return 'rate-limited';
  if (status >= 500) return 'server';
  return 'platform-rejected';
}

export function diagnose(category: Category, url: URL, upstream: string[] = []): string {
  const where = `${url.host}${url.pathname}`;
  for (const m of upstream) for (const k of KNOWN) if (k.re.test(m)) return `${k.category ?? category} from ${where}: ${k.text}`;
  return `${category} from ${where}: ${HINT[category]}`;
}

export function errorText(e: unknown): string {
  if (e instanceof CliError) return redact(e.message);
  const err = e as Error | undefined;
  return `unexpected ${err?.name ?? 'error'}: ${redact(String(err?.message ?? e))}`;
}

// ---------------------------------------------------------------- transport

const upstreamMessages = (body: Json, text: string): string[] => {
  const out: string[] = [];
  for (const m of body?.messages ?? []) out.push(String(m));
  for (const k of ['message', 'error', 'details']) if (body?.[k] !== undefined) out.push(typeof body[k] === 'string' ? body[k] : JSON.stringify(body[k]));
  if (!out.length && text) out.push(text.slice(0, 500));
  return out;
};

export async function http(url: string, init: RequestInit & { timeoutMs?: number } = {}): Promise<Json> {
  const u = new URL(url);
  const authed = isAuthenticatedHost(u.host);
  let res: Response;
  let text: string;
  try {
    res = await fetch(url, { ...init, headers: { ...authHeaders(url), ...(init.headers as Json) }, signal: AbortSignal.timeout(init.timeoutMs ?? 30_000) });
    text = await res.text();
  } catch (e) {
    fail(authed ? diagnose('transport', u) : `transport error to ${u.host}${u.pathname}: ${redact(String((e as Error)?.message ?? e))}`);
  }
  let body: Json = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    /* non-JSON */
  }
  if (!res.ok) {
    if (authed) fail(diagnose(categoryForStatus(res.status), u, upstreamMessages(body, text)));
    fail(`HTTP ${res.status} from ${u.host}${u.pathname}: ${redact(upstreamMessages(body, text)[0] ?? '').slice(0, 200)}`);
  }
  return body;
}

/** For HTTP-200 bodies that still carry an error, e.g. GraphQL `errors`. */
export function rejected(url: string, upstream: string[]): never {
  fail(diagnose('platform-rejected', new URL(url), upstream));
}
