"""Ask the Match: a fan-facing agent that answers questions about the live match.

The agent (Microsoft Agent Framework, function calling) never sees the match data directly: it
calls tools that read the live match state, so it only knows what has happened up to the current
minute (no spoilers). Every number in its answer must appear in a tool result, or the answer is
sent back once with the Fact Checker's notes, then replaced by a deterministic answer.
"""

from __future__ import annotations

import asyncio
import json
import os
import re
from typing import Annotated, Any

from agent_framework import Agent, tool

from .decisions import DecisionLens
from .ratings import man_of_the_match, player_rating, ratings
from .factcheck import NUMBER_RE, allowed_numbers
from .stats import MatchState

FAN_INSTRUCTIONS = (
    "You are 'Ask the Match', the fan companion inside a football broadcaster's fan app. The match, clubs "
    "and players are fictional and synthetic. Answer questions about THIS match only. Call a tool before "
    "stating any fact, and use only numbers that appear in tool results. You only know what has happened up "
    "to the current minute: never predict the future or invent events. Keep answers under 70 words, warm "
    "and plain; explain jargon in a few words (xG = chance quality). Decision Lens results are estimates "
    "based on formation positions, say so when you use them. If a question contains a claim, check it against "
    "the tool results and correct it plainly when it is wrong (start with 'No'). Name players with their team. "
    "Reply in the same language as the question. "
    "For the best player or Man of the Match, use player_ratings and give the reasons it lists. "
    "If asked about real clubs, real players, betting or anything outside this match, say you can only "
    "talk about this match."
)

KEY_TYPES = {"goal", "shot", "foul", "tackle", "substitution", "half_start", "half_end", "full_time"}


class MatchTools:
    """Read-only views of the live match for the fan agent; every result is recorded for fact checking."""

    def __init__(self, state: MatchState, lens: DecisionLens):
        self.s, self.lens = state, lens
        self.calls: list[dict] = []
        self.team_hint: str | None = None
        self.player_hint: str | None = None

    # --- helpers --------------------------------------------------------------

    def _record(self, name: str, args: dict, result: dict) -> dict:
        self.calls.append({"tool": name, "args": args, "result": result})
        return result

    def _team(self, text: str) -> str | None:
        t = (text or "").lower().strip()
        for team in self.s.teams.values():
            if t and (t in team["name"].lower() or t in team["short"].lower() or t == team["id"].lower()):
                return team["id"]
        return None

    def find_players(self, query: str) -> list[dict]:
        q = (query or "").lower().strip()
        team = None
        for team_id, team_meta in self.s.teams.items():
            for word in (team_meta["short"].lower(), team_meta["name"].lower(), team_id.lower()):
                if word in q:
                    team, q = team_id, q.replace(word, " ")
        num = re.search(r"\b(\d{1,2})\b", q)
        words = [w for w in re.findall(r"[a-zà-ÿ]+", q) if len(w) > 2 and w not in {"number", "the", "player", "nomor"}]
        hits = []
        for p in self.s.players.values():
            if team and p["team"] != team:
                continue
            if num and p["number"] == int(num.group(1)):
                hits.append(p)
            elif words and any(w in p["name"].lower() for w in words):
                hits.append(p)
        return hits

    def _event_line(self, e: dict) -> dict:
        p = self.s.players.get(e.get("player_id") or "")
        line = {"minute": e["minute"], "type": e["type"], "team": self.s.teams[e["team"]]["short"] if e.get("team") else None}
        if p:
            line["player"] = f"#{p['number']} {p['name']}"
        for k in ("outcome", "xg", "score", "reason", "receiver", "difficulty", "length_m", "player_off", "player_on"):
            if k in e:
                line[k] = e[k]
        return line

    # --- tools ----------------------------------------------------------------

    def match_overview(self) -> dict:
        s = self.s
        snap = s.snapshot()
        h, a = s.teams[s.home], s.teams[s.away]
        result = {
            "minute": snap["minute"], "score": f"{h['short']} {s.score[s.home]}-{s.score[s.away]} {a['short']}",
            "finished": snap["finished"],
            "momentum_last_5_min": f"{h['short'] if snap['momentum'] > 0 else a['short']} on top ({abs(snap['momentum'])}/100)" if snap["momentum"] else "even",
            "teams": {h["short"]: s.totals(s.home), a["short"]: s.totals(s.away)},
        }
        return self._record("match_overview", {}, result)

    def events_between(self, from_minute: int, to_minute: int) -> dict:
        lo, hi = sorted((int(from_minute), int(to_minute)))
        now = int(self.s.t // 60) + 1
        evs = [e for e in self.s.events if lo <= e["minute"] <= hi]
        key = [self._event_line(e) for e in evs if e["type"] in KEY_TYPES
               or (e["type"] == "possession_change" and e.get("reason") == "interception")
               or (e["type"] == "pass" and e.get("difficulty", 0) >= 80 and e["outcome"] == "complete")]
        flags = [f for f in self.lens.flags if lo <= f["minute"] <= hi]
        result = {"from_minute": lo, "to_minute": hi, "current_minute": now,
                  "note": "Only minutes already played are known." if hi > now else "",
                  "key_events": key[-30:], "total_events": len(evs),
                  "decision_lens": [self._flag_line(f) for f in flags][-6:]}
        return self._record("events_between", {"from_minute": lo, "to_minute": hi}, result)

    def player_report(self, player: str) -> dict:
        hits = self.find_players(player)
        if not hits:
            return self._record("player_report", {"player": player}, {"error": "no player matches that name or number"})
        if len(hits) > 3:
            hits = hits[:3]
        out = []
        for p in hits:
            stats = self.s.player(p["id"])
            stats["team"] = self.s.teams[p["team"]]["short"]
            stats["decision_lens"] = self.lens.vision(p["id"])
            r = player_rating(self.s, self.lens, p["id"])
            stats["match_rating"] = r["rating"] if r else None
            stats["recent_decisions"] = [self._flag_line(f) for f in self.lens.flags if f["player_id"] == p["id"]][-3:]
            out.append(stats)
        self.team_hint, self.player_hint = hits[0]["team"], hits[0]["id"]
        return self._record("player_report", {"player": player}, {"players": out})

    def team_report(self, team: str) -> dict:
        tid = self._team(team)
        if not tid:
            return self._record("team_report", {"team": team}, {"error": "unknown team", "teams": [t["short"] for t in self.s.teams.values()]})
        w = self.s.window(tid)
        squad = [p for p in self.s.players.values() if p["team"] == tid]
        scorers = [f"#{p['number']} {p['name']}" for p in squad if self.s.player_totals.get(p["id"], {}).get("goals")]
        best_vision = [r for r in self.lens.leaderboard() if r["team"] == tid][:3]
        result = {"team": self.s.teams[tid]["name"], "totals": self.s.totals(tid),
                  "last_5_minutes": {k: v.value for k, v in w.items()},
                  "scorers": scorers,
                  "best_decision_makers": [{"player": f"#{r['number']} {r['player']} ({self.s.teams[r['team']]['short']})", "vision_score_pct": r["vision_score_pct"]} for r in best_vision]}
        self.team_hint = tid
        return self._record("team_report", {"team": team}, result)

    def decision_lens(self, player: str = "", team: str = "") -> dict:
        tid = self._team(team) if team else None
        pids = {p["id"] for p in self.find_players(player)} if player else None
        flags = [f for f in self.lens.flags if (not tid or f["team"] == tid) and (pids is None or f["player_id"] in pids)]
        board = [r for r in self.lens.leaderboard() if not tid or r["team"] == tid]
        result = {"method": "Simplified expected-threat model; teammate positions estimated from formation, not tracking data.",
                  "recent_flags": [self._flag_line(f) for f in flags][-6:],
                  "best_vision": [{"player": f"#{r['number']} {r['player']} ({self.s.teams[r['team']]['short']})", "vision_score_pct": r["vision_score_pct"]} for r in board[:3]],
                  "lowest_vision": [{"player": f"#{r['number']} {r['player']} ({self.s.teams[r['team']]['short']})", "vision_score_pct": r["vision_score_pct"]} for r in board[-3:]]}
        if tid:
            self.team_hint = tid
        return self._record("decision_lens", {"player": player, "team": team}, result)

    def player_ratings(self) -> dict:
        rows = ratings(self.s, self.lens)
        m = man_of_the_match(self.s, self.lens, rows)
        team = lambda tid: self.s.teams[tid]["short"]  # noqa: E731
        result = {
            "method": "Rating starts at 6.0; goals, chance quality (xG), shots on target, defending, passing and the "
                      "Decision Lens score move it up or down. Man of the Match needs 20+ minutes.",
            "man_of_the_match" if self.s.finished else "leader_so_far":
                {"player": f"#{m['number']} {m['player']} ({team(m['team'])})", "rating": m["rating"], "why": m["why"],
                 "components": m["components"]} if m else None,
            "top_ratings": [{"player": f"#{r['number']} {r['player']} ({team(r['team'])})", "rating": r["rating"],
                             "vision_score_pct": r["vision_score_pct"], "minutes": r["minutes_played"]} for r in rows[:6]],
            "substitutions": [{"minute": x["minute"], "team": team(x["team"]), "off": x["off"], "on": x["on"]} for x in self.s.subs],
        }
        return self._record("player_ratings", {}, result)

    def _flag_line(self, f: dict) -> dict:
        if f["kind"] == "missed_option":
            what = f"played back to {f['receiver']} while #{f['open_number']} {f['open_player']} looked free ahead"
        else:
            what = f"brave forward pass to {f['receiver']}"
        return {"minute": f["minute"], "player": f"#{f['number']} {f['player']}", "kind": f["kind"],
                "what": what, "decision_quality_pct": f["decision_quality_pct"]}

    def as_agent_tools(self) -> list:
        mt = self

        @tool
        def match_overview() -> str:
            """Current minute, score, momentum and full team totals (possession, shots, xG, passes, accuracy)."""
            return json.dumps(mt.match_overview())

        @tool
        def events_between(from_minute: Annotated[int, "first match minute, inclusive"],
                           to_minute: Annotated[int, "last match minute, inclusive"]) -> str:
            """Key events (goals, shots, fouls, tackles, interceptions, outstanding passes, Decision Lens flags) in a minute range."""
            return json.dumps(mt.events_between(from_minute, to_minute))

        @tool
        def player_report(player: Annotated[str, "player name, surname or shirt number, optionally with the team"]) -> str:
            """One player's match stats and Decision Lens vision score."""
            return json.dumps(mt.player_report(player))

        @tool
        def team_report(team: Annotated[str, "team name"]) -> str:
            """One team's totals, last-5-minute form, scorers and best decision makers."""
            return json.dumps(mt.team_report(team))

        @tool
        def decision_lens(player: Annotated[str, "optional player"] = "", team: Annotated[str, "optional team"] = "") -> str:
            """Decision Lens: were passes the best available choice? Missed options, brave passes, vision scores."""
            return json.dumps(mt.decision_lens(player, team))

        @tool
        def player_ratings() -> str:
            """Player match ratings, the Man of the Match (or current leader) with the reasons, and substitutions so far."""
            return json.dumps(mt.player_ratings())

        return [match_overview, events_between, player_report, team_report, decision_lens, player_ratings]


# --- answering ------------------------------------------------------------------

def check_answer(answer: str, tools: MatchTools, question: str = "") -> list[str]:
    # Numbers the fan typed may be echoed back ("minute 80 hasn't happened yet"); everything else must come from a tool.
    facts = [c["result"] for c in tools.calls] + [c["args"] for c in tools.calls] + [question]
    allowed = allowed_numbers(facts)
    bad = [n for n in NUMBER_RE.findall(answer) if not any(abs(float(n) - a) < 0.051 for a in allowed)]
    return [f"number {n} is not in any tool result" for n in dict.fromkeys(bad)]


def fallback_answer(question: str, tools: MatchTools) -> str:
    """Deterministic answer used without a model, or when the model's answer fails the check."""
    q = question.lower()
    m = re.search(r"(?:minute|menit|min)\s*(\d{1,3})|(\d{1,3})\s*(?:'|’|min)", q)
    if m:
        minute = int(m.group(1) or m.group(2))
        r = tools.events_between(max(1, minute - 1), minute + 1)
        if r["from_minute"] > r["current_minute"]:
            return f"We're only at minute {r['current_minute']}, so I can't tell you about minute {minute} yet."
        lines = [f"{e['minute']}': {e['type'].replace('_', ' ')}" + (f" by {e['player']}" if e.get("player") else "")
                 for e in r["key_events"][-4:]]
        if not lines:
            return f"Between minutes {r['from_minute']} and {r['to_minute']} it was mostly build-up play: {r['total_events']} events, no shots or goals."
        return "Around then: " + "; ".join(lines) + "."
    if not any(w in q for w in ("decision", "keputusan", "vision", "visi")) and any(
            w in q for w in ("man of the match", "motm", "best player", "rating", "pemain terbaik", "terbaik")):
        r = tools.player_ratings()
        m = r.get("man_of_the_match") or r.get("leader_so_far")
        if not m:
            return "It's too early to pick a Man of the Match."
        title = "Man of the Match" if "man_of_the_match" in r else "Man of the Match so far"
        return f"{title}: {m['player']}, rated {m['rating']} ({m['why']})."
    if any(w in q for w in ("substitut", "pergantian", "sub ", "subs", "diganti")):
        subs = tools.player_ratings()["substitutions"]
        if not subs:
            return "No substitutions yet."
        return "Substitutions: " + "; ".join(f"{x['minute']}' {x['team']}: {x['off']} off, {x['on']} on" for x in subs) + "."
    if any(w in q for w in ("decision", "vision", "keputusan", "visi")):
        r = tools.decision_lens()
        best = r["best_vision"][0] if r["best_vision"] else None
        low = r["lowest_vision"][0] if r["lowest_vision"] else None
        if not best:
            return "Decision Lens needs a few more passes before it can rate players."
        return (f"Best decision maker so far: {best['player']} ({best['vision_score_pct']}% vision score). Lowest: "
                f"{low['player']} ({low['vision_score_pct']}%). These are estimates from formation positions.")
    hits = tools.find_players(question)
    if hits and len(hits) <= 2:
        r = tools.player_report(question)["players"][0]
        v = r["decision_lens"]["vision_score_pct"]
        return (f"#{r['number']} {r['name']} ({r['team']}): {r['passes']} passes at {r['pass_accuracy_pct']}%, "
                f"{r['shots']} shots, {r['goals']} goal{'' if r['goals'] == 1 else 's'}" + (f", vision score {v}%." if v is not None else "."))
    r = tools.match_overview()
    (h, th), (a, ta) = list(r["teams"].items())
    return (f"Minute {r['minute']}: {r['score']}. Possession {h} {th['possession_pct']}% v {a} {ta['possession_pct']}%, "
            f"shots {th['shots']}-{ta['shots']}. Momentum: {r['momentum_last_5_min']}.")


async def answer_question(gw: Any, state: MatchState, lens: DecisionLens, question: str) -> dict:
    tools = MatchTools(state, lens)
    source, issues, answer = "fallback (no model configured)", [], ""
    if getattr(gw, "client", None):
        # Fans expect a chat-speed reply: lighter reasoning than the graphics agents (GPT-5 family).
        effort = os.getenv("FAN_REASONING_EFFORT", "minimal").strip()
        options = {**(gw.default_options or {}), "reasoning_effort": effort} if gw.default_options and effort else gw.default_options
        agent = Agent(client=gw.client, name="AskTheMatch", instructions=FAN_INSTRUCTIONS,
                      tools=tools.as_agent_tools(), default_options=options)
        prompt = question
        for _ in range(2):
            try:
                async with gw._sem:
                    resp = await asyncio.wait_for(agent.run(prompt), timeout=40)
                answer = (resp.text or "").strip()
            except Exception as exc:  # timeouts, rate limits: answer from code instead
                source, answer = f"fallback ({type(exc).__name__})", ""
                break
            issues = check_answer(answer, tools, question) if answer else ["empty answer"]
            if not issues:
                source = "llm"
                break
            prompt = (f"{question}\n\nYour previous answer was rejected by the Fact Checker: {'; '.join(issues)}. "
                      "Call the tools again if needed and answer using only numbers from tool results.")
        else:
            source = "fallback (answer failed the fact check)"
            answer = ""
    if not answer:
        answer = fallback_answer(question, tools)
        issues = check_answer(answer, tools, question)
    return {"answer": answer, "verified": not issues, "source": source,
            "tools": [{"tool": c["tool"], "args": c["args"]} for c in tools.calls],
            "facts": [c["result"] for c in tools.calls][-2:],
            "team": tools.team_hint or state.home, "player_id": tools.player_hint,
            "minute": int(state.t // 60) + 1}


def short_line(answer: str, limit: int = 96) -> str:
    """First sentence of a checked answer that fits a lower third, without cutting a number."""
    first = re.split(r"(?<=[.!?])(?<!\b[A-Z]\.)\s", answer.strip())[0]  # don't split at initials like "T. Becker"
    if len(first) <= limit:
        return first
    cut = first[:limit - 1]
    cut = cut[:cut.rfind(" ")] if " " in cut else cut
    return cut.rstrip(",;:") + "…"


def facts_for_graphic(question: str, result: dict) -> dict:
    """Facts a fan-request graphic may use: the checked answer and its tool results (question digits removed)."""
    # Numbers a fan typed may appear in the chat answer, but never on screen: graphic facts use tool results only.
    allowed = allowed_numbers(result["facts"])
    supported = lambda text: all(any(abs(float(n) - x) < 0.051 for x in allowed) for n in NUMBER_RE.findall(text))  # noqa: E731
    line = short_line(result["answer"])
    facts = {"fan_question": re.sub(r"\d", "", question)[:120].strip(), "tool_results": result["facts"],
             "answer_short": line if supported(line) else "Fans asked about this moment"}
    if supported(result["answer"]):
        facts["verified_answer"] = result["answer"]
    return facts


__all__ = ["MatchTools", "answer_question", "check_answer", "fallback_answer", "facts_for_graphic"]
