---
name: fantasy-football
description: Manage the user's own Sleeper and ESPN fantasy football teams (the leagues in their config) — rosters, matchups, scoring rules, available players/free agents, waiver budget/order, pending claims, setting lineups, IR moves, submitting or cancelling waiver claims, a win-probability lineup optimizer, and drafting (never sending) trades.
---

# Fantasy football

One CLI does everything. It only acts on the leagues in the user's config file, and
only with the user's own credentials. Never ask for, print, or handle tokens or cookies;
if a credential is missing or expired the tool says so and the user fixes it.

```bash
F="bun fantasy.ts"           # from this directory; add --config PATH if the user keeps the config elsewhere
$F leagues                   # the leagues this tool will touch, by alias
$F auth-check all            # private reads for every league — run first if anything reports auth
```

Config: `--config PATH`, else `$FF_CONFIG`, `./fantasy.config.json`,
`~/.config/fantasy-football/config.json` (see `fantasy.config.example.json`).
Credentials: `SLEEPER_TOKEN`, `ESPN_S2` + `ESPN_SWID` in the environment or a local
`.env`; when unset, a proxy the user runs may inject them. Any league or team not in the
config is refused.

## Reads

`state`, `roster [--week N]`, `matchup [--week N]`, `scoring`,
`players [--pos RB] [--search name] [--limit N]`, `waivers` (budget, order, my
pending claims). Every write re-reads live state itself; still show the user the
relevant read before proposing a move.

## Who to start (win probability, not projected points)

```bash
O="bun optimize.ts"
$O all              # or: $O <alias>  [--week N]  [--config PATH]
```

Read-only. It projects every player, fits each player's SD from historical weekly
(actual − projected) in that league's own scoring, adds correlation (QB↔his pass
catchers, D/ST↔opposing offense), and picks the lineup that maximizes
P(my total > opponent total) — not the one with the most projected points.

- `posture` says whether you are favored (protect the floor) or an underdog (buy
  variance). The rule behind it: a swap is right iff Δmean > z · Δsd.
- Each change carries its own `winProbGainPP`. A change marked **dead band**
  (under 1.5pp) is one the math cannot separate — that is a judgment call on
  injury news and beat reports, not a math call. Say so rather than presenting it
  as the optimizer's verdict.
- Players whose games have finished show `state: played (banked)` with their real
  points and are never moved.
- Injury handling is a stated constant (`STATUS` in `optimize.ts`), not a fitted
  value.

Apply its output with `set-lineup` below; the optimizer never writes.

## Writes — dry run first, then `--confirm`

```bash
$F set-lineup <league> --swap IN:OUT          # ESPN also: --move PLAYER:SLOT
$F ir <league> --place PLAYER | --activate PLAYER
$F claim <league> --add PLAYER [--drop PLAYER] [--bid N]
$F drop <league> --player PLAYER              # release with no add
$F cancel-claim <league> --id TRANSACTION_ID
```

`drop` frees a roster spot on its own, e.g. to activate a healthy player stuck in IR
(Sleeper freezes every transaction and lineup change while an IR slot holds an
ineligible player). A drop is immediate and sends the player to waivers; this tool
cannot undo it. The drop request shapes have not been sent live by this tool:
Sleeper's matches several independent clients, ESPN's is inferred from the claim
shape. Check `verified` on the first real use.

1. Run without `--confirm`; show the user the plan (players, slots, bid, drop).
2. Apply with `--confirm` only when the user asked for that specific move. Output
   includes `verified` from a post-write readback — report it; if `false`, re-read
   and say what state the team is in.
3. Never make a move just to test access. `auth-check` proves access.

Before any write the tool also proves the credential owns the configured team
(Sleeper: the authenticated user owns the roster; ESPN: the cookie's SWID is the
configured `memberId`, or in proxy mode the config entry asserts
`"identity": "gateway-asserted"`), and refuses otherwise.

Refusals (locked game, ineligible slot, IR status, full roster, bid out of range,
ownership) are the tool enforcing league rules — report them, don't work around
them. Never hand-craft requests to sleeper.com/graphql or
lm-api-writes.fantasy.espn.com; the tool's config allowlist and body guard are the
safety layer.

## Trades

`trade-draft <league> --with ROSTER|TEAM --give P1,P2 --get P3` validates and
summarizes a proposal. Nothing sends trades. If the user explicitly authorizes
sending a specific trade, tell them it must be sent in the app.

## Errors

Errors from the platforms are reported as a category (`auth`, `forbidden`,
`not-found`, `rate-limited`, `server`, `transport`, `platform-rejected`) plus a fixed
explanation; raw platform text is withheld so a credential can never be echoed.
`auth` means the credential is missing or expired: the user refreshes it (new
browser login, new token/cookies) — do not try to work around it.
