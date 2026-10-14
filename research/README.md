# Research: can a bottom-up projection beat the platform's?

The optimizer that ships (`skills/fantasy-football/optimize.ts`) takes the platform's
projection as each player's mean and fits only the spread around it. The sit/start
decision is therefore the platform's opinion with a variance model bolted on. This
folder is the attempt to replace the mean too, and the honest measurement of how
far that got. It was built in Week 2 of the 2026 season by an agent working from
public Sleeper data, and the numbers below are its own backtest, not a claim.

## What the engine does

`engine.ts` rebuilds every QB/RB/WR/TE projection from raw weekly usage (target
share, carry share, red-zone share, snap share) and raw team volume, then
simulates the week:

```
team TDs (Vegas implied total)  ->  game script  ->  pass/rush attempts  ->  yards
  ->  Dirichlet usage shares carve the team's volume among its players
  ->  each simulated stat line scored in THAT league's own scoring
```

QB-receiver, RB-game-script and cross-matchup correlation are structural: they fall
out of players sharing one simulated team, not from a hand-set correlation matrix.
`lineup.ts` then counts P(win) over paired draws of your lineup and your opponent's,
so there is no normal approximation anywhere in the decision. K and D/ST keep the
platform number; there is no kicking or defense model, and the output tags them.

`odds.ts` pulls spreads and totals from ESPN's public scoreboard, skipping the
in-game "Live Odds" provider so a past-week line cannot leak the result.

## The backtest

`backtest.ts` scores the model out of sample on 2025 weeks 5-18: 2,482 player-weeks,
usage for week W built only from games before week W, PPR scoring, Vegas lines on,
800 simulations per week, deterministic seed. `backtest-2025.json` is its output,
regenerated from cached public data when this folder was published.

| metric | ours alone | platform alone | blend 0.4 ours / 0.6 platform |
|---|---|---|---|
| MAE | 5.731 | 5.675 | **5.567** |
| RMSE | 7.512 | 7.229 | **7.177** |
| corr with actual | 0.473 | 0.528 | 0.527 |
| bias | -0.47 | +0.82 | -0.05 |

**Verdict: standalone, the model loses to the platform on point accuracy.** It wins
on bias only. With Vegas lines in, QB beats the platform outright (MAE 6.53 vs
6.61) and RB draws level (5.73 vs 5.74); WR and TE are the whole remaining
deficit. The 0.4 blend beats both alone on MAE and RMSE and matches the
platform's correlation, and that measurement is what sets the `W_OURS` default in
`lineup.ts`. Calibration: the simulated 80% interval contained about 68% of
actuals, so marginals were roughly 1.24x too narrow; `WIDTH` rescales them around
the mean without touching correlation.

![MAE by position](../docs/backtest-mae.svg)

## What was found along the way

- **Cross-season staleness** is the root cause of the gap. At an early week, team
  profiles are mostly last season's games, so a team whose offense changed over the
  offseason is projected as its old self. Vegas absorbs part of this; it is not gone.
  `SEASON_DECAY` exists but is unvalidated: fitting it needs a backtest across a
  season boundary, which 2025-only data cannot provide.
- **Scoring bug.** The platform baseline was first read as `pts_ppr`/`pts_half_ppr`
  rather than the projected stat line rescored in each league's settings. In a
  league scoring 0.2 per yard that understated the baseline by about 20% and dragged
  every blended projection with it. `sim.test.ts` now pins that one stat line scores
  differently under each league's rules.
- **Join bug.** Sleeper's `espn_id` is null for many current players, so the ESPN
  join silently fell back to ESPN's own projection for a whole team; name and
  position now backstop the id.

## Running it

```bash
cd research
bun test                       # unit tests for the rng, Dirichlet, scoring
SIMS=800 bun backtest.ts       # rebuilds backtest-2025.json from public Sleeper + ESPN data (slow)
bun simulate.ts all            # live sit/start for the leagues in your config
```

The engine caches the public data it fetches under `FF_CACHE_DIR` (default: a
`ff-cache` folder in your temp dir). `simulate.ts` reads your league config the
same way the CLI does. `lineup.ts` is frozen at the week it was built; set
`SEASON` and `WEEK` in the environment to point it elsewhere. Tunables in `T`
(`engine.ts`) and `W_OURS`/`WIDTH` are the values the sweep selected; changing
one without re-running the backtest is a guess.

## Status

Research, not the shipped decision tool. It is published because the negative
result is the useful part: a usage-based model built in a week does not beat a
platform projection, and knowing where it loses (WR/TE, early-season staleness)
is what the next attempt would start from.
