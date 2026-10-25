"""Player match ratings and Man of the Match, computed in code.

A rating starts at 6.0 and moves with what the player did. Decision Lens is one of the
components (vision score, brave passes, missed options), so the Man of the Match is always
consistent with what Decision Lens shows. Every component is returned, so a graphic or an
agent can say exactly why a player rated as they did.
"""

from __future__ import annotations

from .decisions import DecisionLens
from .stats import MatchState

MIN_MINUTES = 20  # to be considered for Man of the Match


def player_rating(state: MatchState, lens: DecisionLens, player_id: str) -> dict | None:
    minutes = state.minutes_played(player_id)
    if minutes <= 0:
        return None
    s = state.player(player_id)
    pt = state.player_totals.get(player_id, {})
    v = lens.vision(player_id)
    xg = float(pt.get("xg", 0.0))
    parts = {
        "goals": 1.0 * s["goals"],
        "chances_xg": min(0.8, 0.8 * xg),
        "shots_on_target": 0.15 * int(pt.get("shots_on_target", 0)),
        "defending": min(1.2, 0.05 * (s["tackles"] + s["interceptions"])),
        "passing": max(-0.5, min(0.5, (s["pass_accuracy_pct"] - 80) / 50)) if s["passes"] >= 10 else 0.0,
        # Decision Lens: vision score around a 60% baseline, plus brave passes, minus missed options.
        "decision_lens": max(-1.2, min(1.2, ((v["vision_score_pct"] - 60) / 25 if v["vision_score_pct"] is not None else 0.0)
                                       + 0.1 * v["brave_passes"] - 0.2 * v["missed_options"])),
    }
    rating = max(3.0, min(10.0, 6.0 + sum(parts.values())))
    return {
        "player_id": player_id, "player": s["name"], "number": s["number"], "team": s["team"], "role": s["role"],
        "rating": round(rating, 1), "minutes_played": minutes, "status": s["status"],
        "goals": s["goals"], "xg": round(xg, 2), "vision_score_pct": v["vision_score_pct"],
        "brave_passes": v["brave_passes"], "missed_options": v["missed_options"],
        "components": {k: round(val, 2) for k, val in parts.items()},
    }


def ratings(state: MatchState, lens: DecisionLens) -> list[dict]:
    rows = [r for pid in state.players if (r := player_rating(state, lens, pid))]
    return sorted(rows, key=lambda r: (-r["rating"], -(r["vision_score_pct"] or 0)))


def man_of_the_match(state: MatchState, lens: DecisionLens, rows: list[dict] | None = None) -> dict | None:
    rows = rows if rows is not None else ratings(state, lens)
    eligible = [r for r in rows if r["minutes_played"] >= MIN_MINUTES]
    if not eligible:
        return None
    best = dict(eligible[0])
    best["final"] = state.finished
    best["why"] = _why(best)
    return best


def _why(r: dict) -> str:
    bits = []
    if r["goals"]:
        bits.append(f"{r['goals']} goal{'s' if r['goals'] > 1 else ''}")
    if r["vision_score_pct"] is not None:
        bits.append(f"vision score {r['vision_score_pct']}%")
    if r["brave_passes"]:
        bits.append(f"{r['brave_passes']} brave pass{'es' if r['brave_passes'] > 1 else ''}")
    if r["xg"] >= 0.3:
        bits.append(f"{r['xg']} xG")
    return ", ".join(bits) or "steady all-round game"
