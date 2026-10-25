"""Seeded synthetic football match generator.

The match is a possession state machine: the player on the ball passes, carries
or shoots, the defending team presses, and the chance of each action depends on
pitch zone, pressure and player ratings. Parameters are tuned so a full match
lands near typical top-flight averages (about 450-550 passes per team at ~80%
completion, 10-15 shots per team, 2-4 goals per match).

Pitch is 105 x 68 metres. The home team attacks towards x = 105.
"""

from __future__ import annotations

import argparse
import json
import math
import random
from dataclasses import dataclass, field
from pathlib import Path

from faker import Faker

PITCH_X, PITCH_Y = 105.0, 68.0
GOAL = (105.0, 34.0)

FORMATION_433 = [
    ("GK", 5, 34), ("RB", 32, 10), ("RCB", 24, 26), ("LCB", 24, 42), ("LB", 32, 58),
    ("DM", 45, 34), ("RCM", 55, 22), ("LCM", 55, 46),
    ("RW", 80, 10), ("ST", 88, 34), ("LW", 80, 58),
]

CLUBS = [
    {"id": "RIV", "name": "Riverside Athletic", "short": "Riverside", "color": "#d7263d"},
    {"id": "NGT", "name": "Northgate FC", "short": "Northgate", "color": "#1b98e0"},
]

FAKER_LOCALES = ["en_GB", "es_ES", "fr_FR", "pt_PT", "de_DE", "nl_NL", "it_IT", "no_NO"]


@dataclass
class Player:
    id: str
    name: str
    team: str
    number: int
    role: str
    base_x: float
    base_y: float
    passing: float
    finishing: float
    pace: float


@dataclass
class Team:
    id: str
    name: str
    short: str
    color: str
    players: list[Player] = field(default_factory=list)
    press_spells: list[tuple[float, float]] = field(default_factory=list)
    starters: list[Player] = field(default_factory=list)
    bench: list[Player] = field(default_factory=list)
    subs_plan: list[tuple[float, str]] = field(default_factory=list)   # (match seconds, player id coming off)


def _clamp(v: float, lo: float, hi: float) -> float:
    return max(lo, min(hi, v))


class MatchGenerator:
    def __init__(self, seed: int = 42):
        self.seed = seed
        self.rng = random.Random(seed)
        self.events: list[dict] = []
        self.t = 0.0
        self.period = 1
        self.score = {}
        self.teams = self._build_teams()
        self.score = {t.id: 0 for t in self.teams}
        # Benches and substitutions use their own random stream, so adding them leaves the match itself
        # (every pass, shot and goal) exactly as before; only who is on the pitch changes.
        self.sub_rng = random.Random(seed * 7919 + 13)
        self._plan_substitutions()

    def _build_teams(self) -> list[Team]:
        teams = []
        for ci, club in enumerate(CLUBS):
            team = Team(**club)
            numbers = [1, 2, 5, 6, 3, 4, 8, 10, 7, 9, 11]
            for (role, bx, by), num in zip(FORMATION_433, numbers):
                fake = Faker(self.rng.choice(FAKER_LOCALES))
                fake.seed_instance(self.rng.randint(0, 10**9))
                attacker = role in ("RW", "ST", "LW")
                team.players.append(Player(
                    id=f"{club['id']}-{num}",
                    name=f"{fake.first_name_male()[0]}. {fake.last_name()}",
                    team=club["id"],
                    number=num,
                    role=role,
                    base_x=bx,
                    base_y=by,
                    passing=round(self.rng.uniform(0.55, 0.95), 2),
                    finishing=round(self.rng.uniform(0.6, 0.95) if attacker else self.rng.uniform(0.2, 0.6), 2),
                    pace=round(self.rng.uniform(0.65, 0.98) if role in ("RW", "LW", "RB", "LB", "ST") else self.rng.uniform(0.4, 0.8), 2),
                ))
            # One guaranteed high-press spell per half, plus an optional extra one.
            for half_start in (0, 2700):
                start = half_start + self.rng.uniform(8 * 60, 34 * 60)
                team.press_spells.append((start, start + self.rng.uniform(5 * 60, 8 * 60)))
            if self.rng.random() < 0.5:
                start = self.rng.uniform(10 * 60, 80 * 60)
                team.press_spells.append((start, start + self.rng.uniform(4 * 60, 6 * 60)))
            teams.append(team)
        return teams

    def _plan_substitutions(self) -> None:
        for team in self.teams:
            team.starters = list(team.players)
            numbers = self.sub_rng.sample(range(12, 24), 5)
            for num in sorted(numbers):
                fake = Faker(self.sub_rng.choice(FAKER_LOCALES))
                fake.seed_instance(self.sub_rng.randint(0, 10**9))
                team.bench.append(Player(id=f"{team.id}-{num}", name=f"{fake.first_name_male()[0]}. {fake.last_name()}",
                                         team=team.id, number=num, role="SUB", base_x=0.0, base_y=0.0,
                                         passing=0.0, finishing=0.0, pace=0.0))
            by_role = {r: [p for p in team.players if p.role in r] for r in (("RW", "ST", "LW"), ("DM", "RCM", "LCM"))}
            outfield = [p for p in team.players if p.role != "GK"]
            off = [self.sub_rng.choice(by_role[("RW", "ST", "LW")]), self.sub_rng.choice(by_role[("DM", "RCM", "LCM")])]
            off.append(self.sub_rng.choice([p for p in outfield if p not in off]))
            times = sorted(self.sub_rng.uniform(57 * 60, 84 * 60) for _ in off)
            team.subs_plan = list(zip(times, [p.id for p in off]))

    def _maybe_substitute(self, carrier: Player) -> Player:
        """Make any substitution that is due; the player coming on takes the same role and position."""
        for team in self.teams:
            while team.subs_plan and team.subs_plan[0][0] <= self.t:
                _, off_id = team.subs_plan.pop(0)
                idx = next(i for i, p in enumerate(team.players) if p.id == off_id)
                off_p = team.players[idx]
                on_p = next(p for p in team.bench if p.role == "SUB")
                on_p.role, on_p.base_x, on_p.base_y = off_p.role, off_p.base_x, off_p.base_y
                on_p.passing, on_p.finishing, on_p.pace = off_p.passing, off_p.finishing, off_p.pace
                team.players[idx] = on_p
                self._emit("substitution", team.id, on_p, player_off_id=off_p.id, player_off=off_p.name,
                           player_on_id=on_p.id, player_on=on_p.name, role=off_p.role)
                if carrier is off_p:
                    carrier = on_p
        return carrier

    # --- coordinate helpers -------------------------------------------------

    def _abs(self, team_id: str, ax: float, ay: float) -> tuple[float, float]:
        """Attacking-frame coordinates -> absolute pitch coordinates."""
        if team_id == self.teams[0].id:
            return round(ax, 1), round(ay, 1)
        return round(PITCH_X - ax, 1), round(PITCH_Y - ay, 1)

    def _team(self, team_id: str) -> Team:
        return self.teams[0] if self.teams[0].id == team_id else self.teams[1]

    def _opp(self, team_id: str) -> Team:
        return self.teams[1] if self.teams[0].id == team_id else self.teams[0]

    def _press(self, team_id: str) -> float:
        team = self._team(team_id)
        for s, e in team.press_spells:
            if s <= self.t <= e:
                return 0.8
        return 0.3

    def _nearest(self, team: Team, ax: float, ay: float, exclude: Player | None = None, ball_ax: float = 52.5) -> Player:
        shift = (ball_ax - 52.5) * 0.45
        best, best_d = None, 1e9
        for p in team.players:
            if p is exclude:
                continue
            px = _clamp(p.base_x + (0 if p.role == "GK" else shift), 3, 100)
            d = math.hypot(px - ax, p.base_y - ay) + self.rng.uniform(0, 6)
            if d < best_d:
                best, best_d = p, d
        return best

    def _defender_near(self, attacking_team: str, ax: float, ay: float) -> Player:
        opp = self._opp(attacking_team)
        # Opponent frame is mirrored.
        return self._nearest(opp, PITCH_X - ax, PITCH_Y - ay, ball_ax=PITCH_X - ax)

    # --- event emission -----------------------------------------------------

    def _emit(self, etype: str, team: str | None, player: Player | None, **kw) -> dict:
        ev = {
            "id": f"e{len(self.events) + 1:05d}",
            "t": round(self.t, 1),
            "minute": int(self.t // 60) + 1,
            "period": self.period,
            "type": etype,
            "team": team,
            "player_id": player.id if player else None,
            "player": player.name if player else None,
        }
        ev.update(kw)
        self.events.append(ev)
        return ev

    def _change_possession(self, new_team: str, reason: str, ax: float, ay: float, player: Player | None = None) -> None:
        x, y = self._abs(new_team, ax, ay)
        self._emit("possession_change", new_team, player, reason=reason, x=x, y=y)

    # --- simulation ---------------------------------------------------------

    def _play_period(self, kickoff_team: str, end_t: float) -> None:
        team_id = kickoff_team
        carrier = self._team(team_id).players[9]
        ax, ay = 52.5, 34.0
        x, y = self._abs(team_id, ax, ay)
        self._emit("kickoff", team_id, carrier, x=x, y=y)

        while self.t < end_t:
            carrier = self._maybe_substitute(carrier)
            opp = self._opp(team_id)
            press = self._press(opp.id)
            own_half = ax < 52.5
            p_pressure = press * (0.55 + (0.35 if own_half else 0.0))
            pressured = self.rng.random() < p_pressure

            if pressured:
                defender = self._defender_near(team_id, ax, ay)
                dx, dy = self._abs(team_id, ax, ay)
                self._emit("pressure", opp.id, defender, x=dx, y=dy, on_player_id=carrier.id)
                self.t += self.rng.uniform(0.5, 1.2)
                roll = self.rng.random()
                if roll < 0.10 + 0.08 * press:
                    tx, ty = self._abs(team_id, ax, ay)
                    self._emit("tackle", opp.id, defender, x=tx, y=ty, outcome="won", on_player_id=carrier.id)
                    team_id, carrier = opp.id, defender
                    ax, ay = PITCH_X - ax, PITCH_Y - ay
                    self._change_possession(team_id, "tackle", ax, ay, carrier)
                    self.t += self.rng.uniform(1, 3)
                    continue
                if self.rng.random() < 0.065:
                    fx, fy = self._abs(team_id, ax, ay)
                    self._emit("foul", opp.id, defender, x=fx, y=fy, on_player_id=carrier.id)
                    self.t += self.rng.uniform(20, 40)
                    continue

            # Shot decision.
            dist = math.hypot(GOAL[0] - ax, GOAL[1] - ay)
            p_shot = 0.0
            if ax > 88 and abs(ay - 34) < 20:
                p_shot = 0.15
            elif ax > 74:
                p_shot = 0.035
            if self.rng.random() < p_shot * (0.7 + 0.6 * carrier.finishing):
                team_id, carrier, ax, ay = self._shot(team_id, carrier, ax, ay, dist, pressured)
                continue

            # Carry or pass.
            if self.rng.random() < 0.16 and carrier.role != "GK":
                cdx = self.rng.uniform(3, 9) + (8 * carrier.pace if self.rng.random() < 0.25 else 0)
                nax = _clamp(ax + cdx, 1, 103)
                nay = _clamp(ay + self.rng.gauss(0, 4), 1, 67)
                dur = self.rng.uniform(2.5, 5.0)
                speed = (cdx / dur) * 3.6 + 12 + 14 * carrier.pace + self.rng.gauss(0, 1.5)
                sx, sy = self._abs(team_id, ax, ay)
                ex, ey = self._abs(team_id, nax, nay)
                self._emit("carry", team_id, carrier, x=sx, y=sy, end_x=ex, end_y=ey,
                           speed_kmh=round(_clamp(speed, 12, 36.5), 1))
                ax, ay = nax, nay
                self.t += dur
                continue

            team_id, carrier, ax, ay = self._pass(team_id, carrier, ax, ay, pressured)

        self.t = end_t

    def _pass(self, team_id: str, carrier: Player, ax: float, ay: float, pressured: bool):
        team, opp = self._team(team_id), self._opp(team_id)
        if self.rng.random() < 0.09:
            fwd = self.rng.uniform(25, 45)
        elif ax < 35:
            fwd = self.rng.gauss(9, 8)
        elif ax < 70:
            fwd = self.rng.gauss(5, 9)
        else:
            fwd = self.rng.gauss(1, 8)
        eax = _clamp(ax + fwd, 2, 103)
        eay = _clamp(ay + self.rng.gauss(0, 13), 1, 67)
        receiver = self._nearest(team, eax, eay, exclude=carrier, ball_ax=eax)
        length = math.hypot(eax - ax, eay - ay)

        p_complete = (0.94 - 0.0045 * length - 0.13 * pressured
                      - (0.13 if eax > 85 else 0.0) + 0.15 * (carrier.passing - 0.75))
        complete = self.rng.random() < _clamp(p_complete, 0.2, 0.99)
        sx, sy = self._abs(team_id, ax, ay)
        ex, ey = self._abs(team_id, eax, eay)
        self._emit("pass", team_id, carrier, x=sx, y=sy, end_x=ex, end_y=ey,
                   receiver_id=receiver.id if complete else None,
                   receiver=receiver.name if complete else None,
                   outcome="complete" if complete else "incomplete",
                   under_pressure=pressured)
        self.t += self.rng.uniform(1.7, 3.1) + length / 20
        if complete:
            return team_id, receiver, eax, eay

        oax, oay = PITCH_X - eax, PITCH_Y - eay
        if self.rng.random() < 0.3:
            self.t += self.rng.uniform(10, 25)
            new_carrier = self._nearest(opp, oax, oay, ball_ax=oax)
            self._change_possession(opp.id, "out_of_play", oax, oay, new_carrier)
        else:
            new_carrier = self._nearest(opp, oax, oay, ball_ax=oax)
            self._change_possession(opp.id, "interception", oax, oay, new_carrier)
            self.t += self.rng.uniform(0.5, 1.5)
        return opp.id, new_carrier, oax, oay

    def _shot(self, team_id: str, carrier: Player, ax: float, ay: float, dist: float, pressured: bool):
        opp = self._opp(team_id)
        angle = abs(ay - 34) / max(dist, 1)
        xg = _clamp(0.62 * math.exp(-0.105 * (dist - 6)) * (1 - 0.5 * angle) * (0.75 if pressured else 1.0), 0.02, 0.75)
        speed = _clamp(62 + 38 * carrier.finishing + self.rng.gauss(0, 9) + (dist - 14) * 0.6, 45, 128)
        roll = self.rng.random()
        if roll < 0.18:
            outcome = "blocked"
        elif roll < 0.18 + xg * (0.85 + 0.3 * carrier.finishing):
            outcome = "goal"
        elif roll < 0.62:
            outcome = "saved"
        else:
            outcome = "off_target"
        sx, sy = self._abs(team_id, ax, ay)
        self._emit("shot", team_id, carrier, x=sx, y=sy, outcome=outcome, xg=round(xg, 2),
                   distance_m=round(dist, 1), speed_kmh=round(speed, 1), under_pressure=pressured)
        self.t += self.rng.uniform(1, 2)
        keeper = opp.players[0]
        if outcome == "goal":
            self.score[team_id] += 1
            self._emit("goal", team_id, carrier, score=dict(self.score), xg=round(xg, 2))
            self.t += self.rng.uniform(50, 75)
            kicker = opp.players[9]
            self._emit("kickoff", opp.id, kicker, x=52.5, y=34.0)
            return opp.id, kicker, 52.5, 34.0
        if outcome == "blocked" and self.rng.random() < 0.5:
            self.t += self.rng.uniform(1, 3)
            return team_id, carrier, _clamp(ax - 6, 60, 100), ay
        self.t += self.rng.uniform(8, 25)
        self._change_possession(opp.id, f"shot_{outcome}", 6, 34, keeper)
        return opp.id, keeper, 6.0, 34.0

    def generate(self) -> dict:
        home, away = self.teams
        self.period = 1
        self._emit("half_start", None, None)
        first_end = 45 * 60 + self.rng.uniform(60, 240)
        self._play_period(home.id, first_end)
        self._emit("half_end", None, None, score=dict(self.score))
        self.period = 2
        self.t = 45 * 60
        self._emit("half_start", None, None)
        self._play_period(away.id, 90 * 60 + self.rng.uniform(120, 300))
        self._emit("full_time", None, None, score=dict(self.score))
        return {
            "meta": {
                "seed": self.seed,
                "competition": "Synthetic League (fictional)",
                "venue": "Harbourside Stadium (fictional)",
                "pitch": {"x": PITCH_X, "y": PITCH_Y},
                "home": home.id,
                "away": away.id,
                "teams": [
                    {"id": t.id, "name": t.name, "short": t.short, "color": t.color,
                     "players": [{**p.__dict__, "bench": False} for p in t.starters]
                                + [{**p.__dict__, "bench": True} for p in t.bench]}
                    for t in self.teams
                ],
            },
            "events": self.events,
        }


def generate_match(seed: int = 42) -> dict:
    return MatchGenerator(seed).generate()


def main() -> None:
    parser = argparse.ArgumentParser(description="Generate a synthetic football match.")
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--out", type=Path, default=None)
    args = parser.parse_args()
    match = generate_match(args.seed)
    out = args.out or Path(__file__).resolve().parent.parent / "data" / f"match_{args.seed}.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(match, indent=1))
    print(f"wrote {len(match['events'])} events to {out}")


if __name__ == "__main__":
    main()
