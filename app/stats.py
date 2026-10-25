"""Deterministic match statistics.

Code calculates the numbers; agents only explain them. Every derived value
carries the IDs of the events it was computed from so a graphic on air can be
traced back to the raw feed.
"""

from __future__ import annotations

import math
from collections import defaultdict
from dataclasses import dataclass, field


def attacking_x(meta: dict, team: str, x: float) -> float:
    return x if team == meta["home"] else 105.0 - x


def pass_length(ev: dict) -> float:
    return math.hypot(ev["end_x"] - ev["x"], ev["end_y"] - ev["y"])


def pass_difficulty(meta: dict, ev: dict) -> int:
    """0-100 rating from length, pressure, forward progress and target zone."""
    length = pass_length(ev)
    sx = attacking_x(meta, ev["team"], ev["x"])
    ex = attacking_x(meta, ev["team"], ev["end_x"])
    score = min(length / 40.0, 1.0) * 40
    score += 25 if ev.get("under_pressure") else 0
    score += 15 if ex - sx > 10 else 0
    score += 20 if ex > 88 else (10 if ex > 70 else 0)
    return int(round(min(score, 100)))


@dataclass
class Stat:
    value: float
    source_event_ids: list[str] = field(default_factory=list)

    def to_dict(self) -> dict:
        return {"value": self.value, "source_event_ids": self.source_event_ids}


class MatchState:
    """Incrementally updated match state fed by the live event stream."""

    def __init__(self, meta: dict):
        self.meta = meta
        self.home, self.away = meta["home"], meta["away"]
        self.teams = {t["id"]: t for t in meta["teams"]}
        self.players = {p["id"]: p for t in meta["teams"] for p in t["players"]}
        self.events: list[dict] = []
        self.score = {self.home: 0, self.away: 0}
        self.possession_seconds = {self.home: 0.0, self.away: 0.0}
        self.in_possession: str | None = None
        self._possession_since = 0.0
        self.t = 0.0
        self.period = 1
        self.finished = False
        self.player_totals: dict[str, dict] = defaultdict(lambda: defaultdict(float))
        # Who is on the pitch: starters from kick-off, substitutes from the moment they come on.
        self.on_since = {p["id"]: 0.0 for t in meta["teams"] for p in t["players"] if not p.get("bench")}
        self.off_at: dict[str, float] = {}
        self.subs: list[dict] = []

    def other(self, team: str) -> str:
        return self.away if team == self.home else self.home

    def apply(self, ev: dict) -> dict:
        """Add an event, enrich it with derived fields and update running totals."""
        self.t = ev["t"]
        self.period = ev["period"]
        if ev["type"] == "half_start":
            self._possession_since = ev["t"]
        if ev["type"] in ("kickoff", "possession_change"):
            self._switch_possession(ev["team"], ev["t"])
        if ev["type"] == "pass":
            ev["length_m"] = round(pass_length(ev), 1)
            ev["difficulty"] = pass_difficulty(self.meta, ev)
        if ev["type"] == "goal":
            self.score = dict(ev["score"])
        if ev["type"] == "substitution":
            self.off_at[ev["player_off_id"]] = ev["t"]
            self.on_since[ev["player_on_id"]] = ev["t"]
            self.subs.append({"minute": ev["minute"], "team": ev["team"], "off_id": ev["player_off_id"], "off": ev["player_off"],
                              "on_id": ev["player_on_id"], "on": ev["player_on"], "event_id": ev["id"]})
        if ev["type"] in ("half_end", "full_time"):
            self._switch_possession(None, ev["t"])
            self.finished = ev["type"] == "full_time"

        pid = ev.get("player_id")
        if pid:
            pt = self.player_totals[pid]
            if ev["type"] == "pass":
                pt["passes"] += 1
                pt["passes_completed"] += ev["outcome"] == "complete"
            elif ev["type"] == "shot":
                pt["shots"] += 1
                pt["shots_on_target"] += ev["outcome"] in ("goal", "saved")
                pt["xg"] += ev["xg"]
            elif ev["type"] == "goal":
                pt["goals"] += 1
            elif ev["type"] == "tackle":
                pt["tackles"] += 1
            elif ev["type"] == "pressure":
                pt["pressures"] += 1
            elif ev["type"] == "possession_change" and ev.get("reason") == "interception":
                pt["interceptions"] += 1
            elif ev["type"] == "carry":
                pt["top_speed_kmh"] = max(pt["top_speed_kmh"], ev["speed_kmh"])
        self.events.append(ev)
        return ev

    def _switch_possession(self, team: str | None, t: float) -> None:
        if self.in_possession:
            self.possession_seconds[self.in_possession] += max(0.0, t - self._possession_since)
        self.in_possession = team
        self._possession_since = t

    # --- queries ------------------------------------------------------------

    def possession_pct(self) -> dict[str, float]:
        secs = dict(self.possession_seconds)
        if self.in_possession:
            secs[self.in_possession] += max(0.0, self.t - self._possession_since)
        total = sum(secs.values()) or 1.0
        return {k: round(100 * v / total) for k, v in secs.items()}

    def totals(self, team: str) -> dict:
        passes = [e for e in self.events if e["type"] == "pass" and e["team"] == team]
        completed = [e for e in passes if e["outcome"] == "complete"]
        shots = [e for e in self.events if e["type"] == "shot" and e["team"] == team]
        on_target = [e for e in shots if e["outcome"] in ("goal", "saved")]
        return {
            "goals": self.score[team],
            "passes": len(passes),
            "pass_accuracy_pct": round(100 * len(completed) / len(passes)) if passes else 0,
            "shots": len(shots),
            "shots_on_target": len(on_target),
            "xg": round(sum(e["xg"] for e in shots), 2),
            "tackles": sum(1 for e in self.events if e["type"] == "tackle" and e["team"] == team),
            "fouls": sum(1 for e in self.events if e["type"] == "foul" and e["team"] == team),
            "possession_pct": self.possession_pct()[team],
        }

    def window(self, team: str, seconds: float = 300, end_t: float | None = None) -> dict[str, Stat]:
        """Rolling stats for one team over the last `seconds` of match time."""
        end_t = self.t if end_t is None else end_t
        start_t = end_t - seconds
        evs = [e for e in self.events if start_t < e["t"] <= end_t]
        own = [e for e in evs if e["team"] == team]
        passes = [e for e in own if e["type"] == "pass"]
        completed = [e for e in passes if e["outcome"] == "complete"]
        shots = [e for e in own if e["type"] == "shot"]
        pressures = [e for e in own if e["type"] == "pressure"]
        won_back = [e for e in own if e["type"] == "possession_change" and e["reason"] in ("tackle", "interception")]
        high_turnovers = [e for e in won_back if attacking_x(self.meta, team, e["x"]) > 52.5]
        entries = [
            e for e in completed
            if attacking_x(self.meta, team, e["x"]) <= 70 < attacking_x(self.meta, team, e["end_x"])
        ]
        changes = [e for e in evs if e["type"] == "possession_change"]
        ids = lambda xs: [e["id"] for e in xs]  # noqa: E731
        return {
            "passes": Stat(len(passes), ids(passes)),
            "pass_accuracy_pct": Stat(round(100 * len(completed) / len(passes)) if passes else 0, ids(passes)),
            "shots": Stat(len(shots), ids(shots)),
            "pressures": Stat(len(pressures), ids(pressures)),
            "turnovers_won": Stat(len(won_back), ids(won_back)),
            "high_turnovers_won": Stat(len(high_turnovers), ids(high_turnovers)),
            "final_third_entries": Stat(len(entries), ids(entries)),
            "possession_changes": Stat(len(changes), ids(changes)),
        }

    def momentum(self, seconds: float = 300, end_t: float | None = None) -> Stat:
        """-100 (away dominant) .. +100 (home dominant) over the window."""
        def threat(w: dict[str, Stat]) -> float:
            return (3 * w["shots"].value + 1.0 * w["final_third_entries"].value
                    + 1.5 * w["high_turnovers_won"].value + 0.02 * w["passes"].value)
        wh = self.window(self.home, seconds, end_t)
        wa = self.window(self.away, seconds, end_t)
        diff = threat(wh) - threat(wa)
        src = (wh["shots"].source_event_ids + wa["shots"].source_event_ids
               + wh["final_third_entries"].source_event_ids + wa["final_third_entries"].source_event_ids)
        return Stat(int(round(100 * math.tanh(diff / 10))), sorted(src))

    def chaos_index(self, seconds: float = 300, end_t: float | None = None) -> Stat:
        """Possession changes per minute across both teams: control vs chaos."""
        changes = self.window(self.home, seconds, end_t)["possession_changes"]
        return Stat(round(changes.value / (seconds / 60), 1), changes.source_event_ids)

    def minutes_played(self, player_id: str) -> int:
        if player_id not in self.on_since:
            return 0
        end = self.off_at.get(player_id, self.t)
        return max(0, int(round((end - self.on_since[player_id]) / 60)))

    def on_pitch(self, player_id: str) -> bool:
        return player_id in self.on_since and player_id not in self.off_at

    def player(self, player_id: str) -> dict:
        p = self.players[player_id]
        pt = self.player_totals.get(player_id, {})
        passes = pt.get("passes", 0)
        return {
            "name": p["name"],
            "team": p["team"],
            "role": p["role"],
            "number": p["number"],
            "passes": int(passes),
            "pass_accuracy_pct": round(100 * pt.get("passes_completed", 0) / passes) if passes else 0,
            "shots": int(pt.get("shots", 0)),
            "goals": int(pt.get("goals", 0)),
            "tackles": int(pt.get("tackles", 0)),
            "pressures": int(pt.get("pressures", 0)),
            "top_speed_kmh": round(pt.get("top_speed_kmh", 0.0), 1),
            "interceptions": int(pt.get("interceptions", 0)),
            "minutes_played": self.minutes_played(player_id),
            "status": "on the pitch" if self.on_pitch(player_id) else ("substituted off" if player_id in self.off_at else "on the bench"),
        }

    def snapshot(self) -> dict:
        """Compact live state for the UI."""
        return {
            "t": self.t,
            "minute": int(self.t // 60) + 1,
            "period": self.period,
            "score": self.score,
            "in_possession": self.in_possession,
            "totals": {self.home: self.totals(self.home), self.away: self.totals(self.away)},
            "momentum": self.momentum().value,
            "chaos": self.chaos_index().value,
            "finished": self.finished,
            "subs": self.subs,
        }
