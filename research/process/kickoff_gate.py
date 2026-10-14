#!/usr/bin/env python3
"""Wake once per NFL kickoff slot, 10-85 min before kickoff (inactives post ~90 min before).
`kickoff_gate.py` = gate; `kickoff_gate.py ack <slotISO>` = record a slot as handled."""
import json, os, sys, urllib.request
from datetime import datetime, timezone, timedelta

# The scheduler this ran under treats the last stdout line as the gate's verdict:
# a WAKE line starts the agent with that data, anything else is a quiet observation.
def observation_line(kind, evidence, bound):
    return f"observation {kind}: {evidence} (recheck within {bound})"
def wake_line(data):
    return "WAKE " + json.dumps(data)

STATE = os.environ.get("KICKOFF_ACKS", "kickoff-acks.json")
URL = "https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard"
EARLIEST, LATEST = timedelta(minutes=85), timedelta(minutes=10)

def load():
    try:
        with open(STATE) as f: return json.load(f)
    except FileNotFoundError: return {}

def main():
    acks = load()
    if len(sys.argv) == 3 and sys.argv[1] == "ack":
        acks[sys.argv[2]] = datetime.now(timezone.utc).isoformat()
        tmp = STATE + ".tmp"
        with open(tmp, "w") as f: json.dump(acks, f, indent=1)
        os.replace(tmp, STATE)
        print(f"acked {sys.argv[2]}"); return
    try:
        with urllib.request.urlopen(URL, timeout=20) as r: events = json.load(r)["events"]
    except Exception as e:
        print(observation_line(kind="unreadable", evidence=f"ESPN scoreboard read failed: {e}"[:200], bound="3h")); return
    now = datetime.now(timezone.utc)
    slots = {}
    for e in events:
        if e["status"]["type"]["state"] != "pre": continue
        slots.setdefault(e["date"], []).append(e["shortName"])
    due = sorted(s for s in slots if s not in acks and LATEST <= datetime.fromisoformat(s.replace("Z", "+00:00")) - now <= EARLIEST)
    if due:
        s = due[0]
        print(wake_line(data={"kickoffSlotUTC": s, "games": slots[s], "laterSlotsThisWeek": sorted(x for x in slots if x > s)}))
    else:
        nxt = min(slots) if slots else "none this week"
        print(observation_line(kind="empty", evidence=f"no kickoff slot due; next {nxt}", bound="3h"))

main()
