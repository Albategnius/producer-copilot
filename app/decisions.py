"""Decision Lens: was each pass the best available choice?

For every pass we compare the option the player chose with the other options they had, using a
simplified expected-threat (xT) model: how likely a possession is to lead to a goal from a given
spot. Teammate positions are ESTIMATED from the team's formation shifted with the ball, because the
synthetic feed (like most event data) has no tracking of off-ball players. Everything here is
deterministic code; agents only explain the results.
"""

from __future__ import annotations

import math
from collections import defaultdict

PITCH_X, PITCH_Y = 105.0, 68.0
LOSS_COST = 0.02        # value lost when a pass is intercepted
MARGIN_MISSED = 0.012   # a better forward option by at least this much is a missed option
GOOD_QUALITY = 0.6      # decision quality (0 worst option .. 1 best option) that counts as a good choice
MIN_PASSES = 8          # passes before a player gets a vision score


def xt(ax: float, ay: float) -> float:
    """Simplified expected threat in the attacking frame (0 = own goal line, 105 = opponent's)."""
    central = math.exp(-((ay - 34.0) / 16.0) ** 2)
    near_box = 1.0 / (1.0 + math.exp(-(ax - 88.0) / 6.0))
    return 0.006 + 0.004 * ax / PITCH_X + 0.32 * near_box * central + 0.03 * (ax / PITCH_X) ** 3


def completion_chance(dist: float, pressured: bool, target_ax: float) -> float:
    # Longer passes, pressure and passes into the opponent's defensive line are harder to complete.
    p = 0.95 - dist / 70.0 - (0.08 if pressured else 0.0) - (0.12 if target_ax > 80 else 0.0) - (0.10 if target_ax > 90 else 0.0)
    return max(0.15, min(0.95, p))


def option_value(sx: float, sy: float, tx: float, ty: float, pressured: bool) -> float:
    p = completion_chance(math.hypot(tx - sx, ty - sy), pressured, tx)
    return p * xt(tx, ty) - (1 - p) * LOSS_COST


class DecisionLens:
    def __init__(self, meta: dict):
        self.meta = meta
        self.home = meta["home"]
        self.players = {p["id"]: p for t in meta["teams"] for p in t["players"]}
        # Only players on the pitch can be passing options; substitutions update this.
        self.squads = {t["id"]: [p for p in t["players"] if not p.get("bench")] for t in meta["teams"]}
        self.flags: list[dict] = []
        self.per_player: dict[str, dict] = defaultdict(lambda: {"passes": 0, "good": 0, "missed": 0, "brave": 0, "quality_sum": 0.0})

    # --- frames ---------------------------------------------------------------

    def _att(self, team: str, x: float, y: float) -> tuple[float, float]:
        return (x, y) if team == self.home else (PITCH_X - x, PITCH_Y - y)

    def _abs(self, team: str, ax: float, ay: float) -> tuple[float, float]:
        return (round(ax, 1), round(ay, 1)) if team == self.home else (round(PITCH_X - ax, 1), round(PITCH_Y - ay, 1))

    def estimated_teammates(self, team: str, ball_ax: float, ball_ay: float, exclude: str | None) -> list[dict]:
        """Formation positions shifted with the ball: an estimate, not tracking data."""
        out = []
        for p in self.squads[team]:
            if p["id"] == exclude or p["role"] == "GK":
                continue
            # The team block compresses around the ball; nobody is estimated beyond the defensive line.
            ax = min(92.0, max(3.0, ball_ax + (p["base_x"] - 50.0) * 0.55))
            ay = min(66.0, max(2.0, p["base_y"] + (ball_ay - 34.0) * 0.3))
            out.append({"player_id": p["id"], "ax": ax, "ay": ay})
        return out

    def substitute(self, ev: dict) -> None:
        squad = self.squads[ev["team"]]
        for i, p in enumerate(squad):
            if p["id"] == ev["player_off_id"]:
                on = dict(self.players[ev["player_on_id"]])
                on.update(role=p["role"], base_x=p["base_x"], base_y=p["base_y"])
                squad[i] = on

    # --- per event -------------------------------------------------------------

    def observe(self, ev: dict, attacking_moment: bool) -> dict | None:
        """Rate one pass. Returns a flag dict for a missed option or a brave pass, else None."""
        if ev.get("type") != "pass" or "end_x" not in ev or not ev.get("player_id"):
            return None
        team, pid = ev["team"], ev["player_id"]
        sx, sy = self._att(team, ev["x"], ev["y"])
        ex, ey = self._att(team, ev["end_x"], ev["end_y"])
        pressured = bool(ev.get("under_pressure"))
        chosen = option_value(sx, sy, ex, ey, pressured)

        options = self.estimated_teammates(team, sx, sy, pid)
        for o in options:
            o["value"] = option_value(sx, sy, o["ax"], o["ay"], pressured)
            o["p"] = completion_chance(math.hypot(o["ax"] - sx, o["ay"] - sy), pressured, o["ax"])
        best = max(options, key=lambda o: o["value"])
        worst = min(o["value"] for o in options)
        quality = 1.0 if best["value"] - worst < 1e-6 else max(0.0, min(1.0, (chosen - worst) / (best["value"] - worst)))

        stats = self.per_player[pid]
        stats["passes"] += 1
        stats["quality_sum"] += quality
        good = quality >= GOOD_QUALITY
        stats["good"] += good

        flag = None
        went_back = ex < sx - 1
        best_ahead = best["ax"] > sx + 6
        if went_back and best_ahead and attacking_moment and best["p"] >= 0.55 and best["value"] - chosen >= MARGIN_MISSED:
            stats["missed"] += 1
            flag = "missed_option"
        elif ev.get("outcome") == "complete" and quality >= 0.9 and xt(ex, ey) - xt(sx, sy) >= 0.06 and math.hypot(ex - sx, ey - sy) >= 15:
            stats["brave"] += 1
            flag = "brave_pass"
        if not flag:
            return None

        passer = self.players[pid]
        open_p = self.players[best["player_id"]]
        bx, by = self._abs(team, best["ax"], best["ay"])
        out = {
            "event_id": ev["id"], "kind": flag, "t": ev["t"], "minute": ev["minute"], "team": team,
            "player_id": pid, "player": passer["name"], "number": passer["number"],
            "receiver": ev.get("receiver"), "outcome": ev.get("outcome"),
            "decision_quality_pct": round(100 * quality),
            "chosen_threat": round(chosen, 3),
            "best_threat": round(best["value"], 3),
            "threat_gain": round(xt(ex, ey) - xt(sx, sy), 3),
            "open_player_id": best["player_id"], "open_player": open_p["name"], "open_number": open_p["number"],
            "open_x": bx, "open_y": by,
            "from_x": ev["x"], "from_y": ev["y"], "to_x": ev["end_x"], "to_y": ev["end_y"],
            "estimated": True,
        }
        self.flags.append(out)
        return out

    # --- queries -------------------------------------------------------------

    def vision(self, player_id: str) -> dict:
        s = self.per_player.get(player_id, {"passes": 0, "good": 0, "missed": 0, "brave": 0, "quality_sum": 0.0})
        rated = s["passes"] >= MIN_PASSES
        return {"passes_rated": s["passes"],
                "vision_score_pct": round(100 * s["quality_sum"] / s["passes"]) if rated else None,
                "good_decisions_pct": round(100 * s["good"] / s["passes"]) if rated else None,
                "missed_options": s["missed"], "brave_passes": s["brave"]}

    def leaderboard(self) -> list[dict]:
        rows = []
        for pid, s in self.per_player.items():
            if s["passes"] < MIN_PASSES:
                continue
            p = self.players[pid]
            rows.append({"player_id": pid, "player": p["name"], "number": p["number"], "team": p["team"],
                         **self.vision(pid)})
        return sorted(rows, key=lambda r: (-r["vision_score_pct"], -r["passes_rated"]))
