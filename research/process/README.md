# How agents ran a season with this tool

The CLI was built to be driven by an AI agent that manages the owner's teams
autonomously, with the owner's standing approval for lineup, IR, free-agent and
waiver moves. This folder is the minimal record of how that worked: the weekly
cadence, the gate that wakes the agent before each kickoff, and the verification
loop that every piece of advice went through before a person acted on it.

## One game week

| When | What runs | What it does |
|---|---|---|
| Wednesday morning, after waivers clear and Sleeper rolls to the new week | weekly waiver/IR pass | reads rosters, budgets and results; places IR moves, drops dead roster spots for real upgrades, submits claims with a researched FAAB bid; logs every move with its transaction id and readback result |
| 10 to 85 minutes before every kickoff slot (inactives post about 90 minutes out) | `kickoff_gate.py` wakes the agent | agent reads rosters, checks official inactives for every starter and bench player in that slot, runs the optimizer, applies math-call swaps and any swap that benches an inactive player; dead-band swaps only with news support |
| any time | the owner asks in chat | same tools, same dry-run then `--confirm` discipline |

Every write follows the sequence in the README's safety diagram: dry run, show the
plan, `--confirm`, report `verified` from the readback. The agent messages the owner
only when it changed a lineup or a starter is out and cannot be fixed; a clean check
is logged, not announced.

`kickoff_gate.py` is the per-kickoff gate as it ran, with the scheduler's helper
replaced by plain prints. It polls ESPN's public scoreboard, groups the pre-game
events by kickoff time, and prints a wake line for the first slot that is inside
the window and not yet acknowledged; the agent acknowledges a slot only after its
work is verified, so a crashed run is retried on the next poll.

## The verification loop

Advice about real money and real lineups went out only after an independent
verifier, running on a different model with a fresh context, checked every claim
against live sources. The brief is `verifier-brief.md`. The worked example is one
waiver question from Week 3 of 2026:

- `reply.md` is the final advice as sent.
- `claims.json` is its ledger: every factual claim, the source that supports it, and
  the quote.
- `verify-r1.md` is the verifier's first-round report (verdict: changes), with the
  two further rounds that followed collapsing to clear once the overstated and
  unsupported items were fixed.
- `runtime-read.txt` is the sanitized diagnostic the reply cites for "my private
  reads failed", so that an operational claim is on the record too.

The pattern is the point: a reply is a set of claims, each claim is bound to a
source, a second model tries to break it, and the author fixes rather than argues.
League names, identifiers and the owner's name have been removed; NFL player names
and team pages are public.
