"""Rule-based candidate moment detection.

Rules are cheap and deterministic, so they run on every event. Each candidate
carries the exact facts (numbers) an agent is allowed to put on screen, and the
source events behind them.
"""

from __future__ import annotations

from dataclasses import dataclass, field

from .stats import MatchState

PRIORITY = {
    "goal": 100,
    "big_chance": 70,
    "press_spell": 60,
    "momentum_swing": 55,
    "chaos": 45,
    "hard_pass": 40,
    "sprint": 30,
    "fan_request": 65,
    "man_of_match": 90,
    "substitution": 50,
    "missed_option": 35,
}


@dataclass
class Candidate:
    id: str
    kind: str
    t: float
    minute: int
    team: str
    player_id: str | None
    title: str
    facts: dict
    source_event_ids: list[str] = field(default_factory=list)

    @property
    def priority(self) -> int:
        return PRIORITY[self.kind]

    def to_dict(self) -> dict:
        return {
            "id": self.id, "kind": self.kind, "t": self.t, "minute": self.minute, "team": self.team,
            "player_id": self.player_id, "title": self.title, "facts": self.facts,
            "source_event_ids": self.source_event_ids, "priority": self.priority,
        }


class MomentDetector:
    WINDOW_CHECK_EVERY = 30.0

    def __init__(self, state: MatchState):
        self.state = state
        self.count = 0
        self.last_fired: dict[str, float] = {}
        self._last_window_check = -1e9
        self._momentum_history: list[tuple[float, int]] = []

    def _cool(self, key: str, seconds: float) -> bool:
        last = self.last_fired.get(key)
        if last is not None and self.state.t - last < seconds:
            return False
        self.last_fired[key] = self.state.t
        return True

    def _base_facts(self, team: str) -> dict:
        s = self.state
        return {
            "minute": int(s.t // 60) + 1,
            "team": s.teams[team]["name"],
            "opponent": s.teams[s.other(team)]["name"],
            "score": f"{s.teams[s.home]['short']} {s.score[s.home]}-{s.score[s.away]} {s.teams[s.away]['short']}",
        }

    def _make(self, kind: str, team: str, player_id: str | None, title: str, facts: dict, src: list[str]) -> Candidate:
        self.count += 1
        s = self.state
        return Candidate(
            id=f"m{self.count:03d}", kind=kind, t=s.t, minute=int(s.t // 60) + 1, team=team,
            player_id=player_id, title=title, facts={**self._base_facts(team), **facts},
            source_event_ids=src,
        )

    def check(self, ev: dict) -> list[Candidate]:
        out: list[Candidate] = []
        s = self.state
        et = ev["type"]

        if et == "goal":
            shot = next(e for e in reversed(s.events) if e["type"] == "shot" and e["outcome"] == "goal")
            p = s.player(ev["player_id"])
            out.append(self._make("goal", ev["team"], ev["player_id"], f"GOAL - {ev['player']}", {
                "scorer": ev["player"],
                "shot_xg": shot["xg"],
                "shot_speed_kmh": shot["speed_kmh"],
                "shot_distance_m": shot["distance_m"],
                "scorer_goals_today": p["goals"],
                "team_shots": s.totals(ev["team"])["shots"],
            }, [shot["id"], ev["id"]]))

        elif et == "shot" and ev["outcome"] != "goal" and (ev["xg"] >= 0.3 or ev["speed_kmh"] >= 110):
            if self._cool("big_chance", 120):
                totals = s.totals(ev["team"])
                out.append(self._make("big_chance", ev["team"], ev["player_id"], f"Big chance - {ev['player']}", {
                    "shooter": ev["player"],
                    "outcome": ev["outcome"],
                    "shot_xg": ev["xg"],
                    "shot_speed_kmh": ev["speed_kmh"],
                    "shot_distance_m": ev["distance_m"],
                    "team_xg": totals["xg"],
                    "team_shots": totals["shots"],
                }, [ev["id"]]))

        elif et == "pass" and ev["outcome"] == "complete" and ev["difficulty"] >= 80:
            if self._cool("hard_pass", 360):
                p = s.player(ev["player_id"])
                out.append(self._make("hard_pass", ev["team"], ev["player_id"], f"Elite pass - {ev['player']}", {
                    "passer": ev["player"],
                    "receiver": ev["receiver"],
                    "pass_length_m": ev["length_m"],
                    "pass_difficulty": ev["difficulty"],
                    "difficulty_scale_max": 100,
                    "under_pressure": ev["under_pressure"],
                    "passer_accuracy_pct": p["pass_accuracy_pct"],
                    "passer_passes": p["passes"],
                }, [ev["id"]]))

        elif et == "carry" and ev["speed_kmh"] >= 34.0:
            if self._cool(f"sprint:{ev['player_id']}", 900) and self._cool("sprint", 720):
                out.append(self._make("sprint", ev["team"], ev["player_id"], f"Top speed - {ev['player']}", {
                    "player": ev["player"],
                    "speed_kmh": ev["speed_kmh"],
                    "speed_threshold_kmh": 34,
                }, [ev["id"]]))

        if s.t - self._last_window_check >= self.WINDOW_CHECK_EVERY and s.t > 300:
            self._last_window_check = s.t
            out.extend(self._window_checks())
        return out

    def _window_checks(self) -> list[Candidate]:
        s = self.state
        out: list[Candidate] = []

        for team in (s.home, s.away):
            w = s.window(team, 360)
            if w["high_turnovers_won"].value >= 4 and self._cool(f"press:{team}", 900):
                opp_w = s.window(s.other(team), 360)
                out.append(self._make("press_spell", team, None, f"High press - {s.teams[team]['short']}", {
                    "window_minutes": 6,
                    "high_turnovers_won": w["high_turnovers_won"].value,
                    "pressures": w["pressures"].value,
                    "opponent_pass_accuracy_pct": opp_w["pass_accuracy_pct"].value,
                    "opponent_match_pass_accuracy_pct": s.totals(s.other(team))["pass_accuracy_pct"],
                }, w["high_turnovers_won"].source_event_ids + w["pressures"].source_event_ids[-5:]))

        m = s.momentum(300)
        self._momentum_history.append((s.t, m.value))
        past = [v for t, v in self._momentum_history if s.t - 330 <= t <= s.t - 270]
        if past:
            before = past[0]
            if abs(m.value) >= 50 and (before * m.value < 0) and abs(m.value - before) >= 70:
                team = s.home if m.value > 0 else s.away
                if self._cool("momentum", 720):
                    w = s.window(team, 300)
                    out.append(self._make("momentum_swing", team, None, f"Momentum swing - {s.teams[team]['short']}", {
                        "window_minutes": 5,
                        "momentum_now": abs(m.value),
                        "momentum_5_min_ago": abs(before),
                        "momentum_5_min_ago_favoured": s.teams[s.other(team)]["name"],
                        "shots_last_5_min": w["shots"].value,
                        "final_third_entries_last_5_min": w["final_third_entries"].value,
                    }, m.source_event_ids))

        chaos = s.chaos_index(300)
        if chaos.value >= 4.4 and self._cool("chaos", 900):
            leader = s.home if s.momentum(300).value >= 0 else s.away
            out.append(self._make("chaos", leader, None, "Control vs chaos", {
                "window_minutes": 5,
                "possession_changes_per_min": chaos.value,
                "possession_changes_last_5_min": len(chaos.source_event_ids),
                "home_pass_accuracy_last_5_min_pct": s.window(s.home, 300)["pass_accuracy_pct"].value,
                "away_pass_accuracy_last_5_min_pct": s.window(s.away, 300)["pass_accuracy_pct"].value,
            }, chaos.source_event_ids))
        return out
