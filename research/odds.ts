#!/usr/bin/env bun
/**
 * Vegas lines from ESPN's public endpoints, cached to disk.
 * Live week: site scoreboard. Past weeks: core API per event (pregame book only —
 * the "Live Odds" provider is an in-game line and would leak the result).
 */
declare const Bun: any;
const DIR = process.env.FF_CACHE_DIR ?? `${require('os').tmpdir()}/ff-cache`;
/** ESPN abbreviations that differ from Sleeper's. */
const FIX: Record<string, string> = { WSH: 'WAS', LAR: 'LAR', LAC: 'LAC', JAX: 'JAX' };
export const norm = (t: string) => FIX[t] ?? t;

export type GameOdds = { home: string; away: string; spreadHome: number; total: number };

async function j(url: string): Promise<any> {
  const r = await fetch(url, {
    headers: { 'user-agent': 'curl/8.5.0', accept: 'application/json' },
    signal: AbortSignal.timeout(30_000),
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

async function fetchWeek(season: number, week: number): Promise<GameOdds[]> {
  const sb = await j(`https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard?dates=${season}&seasontype=2&week=${week}`);
  const out: GameOdds[] = [];
  const jobs = (sb.events ?? []).map((e: any) => async () => {
    const c = e.competitions[0];
    const home = norm(c.competitors.find((x: any) => x.homeAway === 'home').team.abbreviation);
    const away = norm(c.competitors.find((x: any) => x.homeAway === 'away').team.abbreviation);
    let spreadHome: number | null = null, total: number | null = null;

    const inline = (c.odds ?? []).find((o: any) => !/live/i.test(o.provider?.name ?? ''));
    if (inline && typeof inline.spread === 'number' && typeof inline.overUnder === 'number') {
      spreadHome = inline.spread; total = inline.overUnder;
    } else {
      try {
        const od = await j(`https://sports.core.api.espn.com/v2/sports/football/leagues/nfl/events/${e.id}/competitions/${e.id}/odds`);
        const it = (od.items ?? []).find((x: any) => !/live/i.test(x.provider?.name ?? '') && typeof x.spread === 'number' && typeof x.overUnder === 'number');
        if (it) { spreadHome = it.spread; total = it.overUnder; }
      } catch { /* no line for this game; caller falls back to the EWMA prior */ }
    }
    if (spreadHome !== null && total !== null) out.push({ home, away, spreadHome, total });
  });
  // modest concurrency — this is someone else's public endpoint
  for (let i = 0; i < jobs.length; i += 8) await Promise.all(jobs.slice(i, i + 8).map((f: any) => f()));
  return out;
}

export async function oddsFor(season: number, week: number): Promise<Map<string, { implied: number; spread: number; total: number }>> {
  const path = `${DIR}/odds-${season}-${week}.json`;
  const f = Bun.file(path);
  const ttl = season === 2026 && week >= 2 ? 20 * 60_000 : 30 * 24 * 3600_000;
  let games: GameOdds[];
  if ((await f.exists()) && Date.now() - f.lastModified < ttl) games = await f.json();
  else { games = await fetchWeek(season, week); await Bun.write(path, JSON.stringify(games)); }

  const m = new Map<string, { implied: number; spread: number; total: number }>();
  for (const g of games) {
    // implied team total: half the total, shifted by half the spread
    m.set(g.home, { implied: g.total / 2 - g.spreadHome / 2, spread: g.spreadHome, total: g.total });
    m.set(g.away, { implied: g.total / 2 + g.spreadHome / 2, spread: -g.spreadHome, total: g.total });
  }
  return m;
}

if (import.meta.main) {
  const season = Number(process.argv[2]), from = Number(process.argv[3]), to = Number(process.argv[4] ?? process.argv[3]);
  for (let w = from; w <= to; w++) {
    const m = await oddsFor(season, w);
    process.stderr.write(`${season} w${w}: ${m.size / 2} games\n`);
  }
}
