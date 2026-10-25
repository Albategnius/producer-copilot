import asyncio
import json

from app.decisions import DecisionLens
from app.fan import MatchTools, answer_question, check_answer, facts_for_graphic
from app.factcheck import check_graphic
from app.stats import MatchState


def _state(until_minute=30):
    m = json.load(open("data/match_1.json"))
    st, lens = MatchState(m["meta"]), DecisionLens(m["meta"])
    for ev in m["events"]:
        if ev["minute"] > until_minute:
            break
        st.apply(ev)
        lens.observe(ev, True)
    return st, lens


class NoModel:
    client = None


def test_fan_answers_are_grounded_and_spoiler_free():
    st, lens = _state(30)
    r = asyncio.run(answer_question(NoModel(), st, lens, "What happens at minute 80?"))
    assert "minute 80" in r["answer"] and r["verified"]          # admits it can't know the future
    r = asyncio.run(answer_question(NoModel(), st, lens, "How is Becker playing?"))
    assert r["verified"] and r["tools"][0]["tool"] == "player_report"


def test_invented_numbers_fail_the_answer_check():
    st, lens = _state(30)
    tools = MatchTools(st, lens)
    tools.match_overview()
    assert check_answer("Riverside have 999 shots", tools)


def test_question_numbers_never_reach_the_graphic():
    st, lens = _state(30)
    result = {"answer": "No, Becker has not scored 99 goals.", "facts": [{"goals": 1}]}
    facts = facts_for_graphic("Did Becker score 99 goals?", result)
    assert "99" not in json.dumps(facts)
    bad = {"template": "lower_third", "slots": {"headline": "You asked", "body": "Becker 99 goals"}}
    assert check_graphic(bad, facts)


def test_decision_lens_rates_every_pass_and_flags_some():
    st, lens = _state(95)
    kinds = {f["kind"] for f in lens.flags}
    assert {"missed_option", "brave_pass"} <= kinds
    board = lens.leaderboard()
    assert board and all(0 <= r["vision_score_pct"] <= 100 for r in board)
    assert all(f["estimated"] for f in lens.flags)


def test_new_moment_kinds_have_fallbacks_that_pass_the_fact_check():
    from app.agents import fallback_analysis, fallback_graphic
    from app.moments import MomentDetector

    st, lens = _state(95)
    det = MomentDetector(st)
    f = next(x for x in lens.flags if x["kind"] == "missed_option")
    c1 = det._make("missed_option", f["team"], f["player_id"], "Decision Lens", {
        "passer": f["player"], "passer_number": f["number"], "receiver": f["receiver"],
        "open_teammate": f["open_player"], "open_teammate_number": f["open_number"],
        "decision_quality_pct": f["decision_quality_pct"]}, [f["event_id"]])
    result = asyncio.run(answer_question(NoModel(), st, lens, "How is Becker playing?"))
    c2 = det._make("fan_request", st.home, None, "Fan request", facts_for_graphic("How is Becker playing?", result), [])
    for c in (c1, c2):
        assert fallback_analysis(c)["why_now"]
        assert not check_graphic(fallback_graphic(c), c.facts)


def _full_match():
    from app.stats import attacking_x
    m = json.load(open("data/match_1.json"))
    st, lens = MatchState(m["meta"]), DecisionLens(m["meta"])
    for ev in m["events"]:
        st.apply(ev)
        if ev["type"] == "substitution":
            lens.substitute(ev)
        if ev["type"] == "pass":
            lens.observe(ev, attacking_x(st.meta, ev["team"], ev["x"]) >= 55)
    return m, st, lens


def test_substitutions_are_real_players_who_then_play():
    m, st, lens = _full_match()
    subs = [e for e in m["events"] if e["type"] == "substitution"]
    assert 4 <= len(subs) <= 6 and all(e["minute"] >= 57 for e in subs)
    for e in subs:
        later = [x for x in m["events"] if x["t"] > e["t"]]
        assert not any(x.get("player_id") == e["player_off_id"] for x in later)   # off means off
        assert st.minutes_played(e["player_on_id"]) > 0 and not st.on_pitch(e["player_off_id"])
        assert all(p["id"] != e["player_off_id"] for p in lens.squads[e["team"]])  # not a passing option any more


def test_man_of_the_match_is_consistent_with_decision_lens():
    from app.ratings import man_of_the_match, ratings
    _, st, lens = _full_match()
    rows = ratings(st, lens)
    motm = man_of_the_match(st, lens, rows)
    assert motm["final"] and motm["player_id"] == rows[0]["player_id"]
    assert motm["vision_score_pct"] == lens.vision(motm["player_id"])["vision_score_pct"]
    # the Decision Lens component is exactly what the lens reports
    v = lens.vision(motm["player_id"])
    expected = max(-1.2, min(1.2, (v["vision_score_pct"] - 60) / 25 + 0.1 * v["brave_passes"] - 0.2 * v["missed_options"]))
    assert abs(motm["components"]["decision_lens"] - round(expected, 2)) < 0.01


def test_substitution_and_motm_graphics_pass_the_fact_check():
    from app.agents import fallback_graphic
    from app.moments import MomentDetector
    from app.ratings import man_of_the_match
    m, st, lens = _full_match()
    det = MomentDetector(st)
    e = next(x for x in m["events"] if x["type"] == "substitution")
    off, on = st.players[e["player_off_id"]], st.players[e["player_on_id"]]
    c1 = det._make("substitution", e["team"], e["player_on_id"], "Sub", {"player_off": e["player_off"], "player_off_number": off["number"],
                   "player_on": e["player_on"], "player_on_number": on["number"], "position": e["role"]}, [e["id"]])
    mm = man_of_the_match(st, lens)
    c2 = det._make("man_of_match", mm["team"], mm["player_id"], "MOTM", {"player": mm["player"], "match_rating": mm["rating"],
                   "goals": mm["goals"], "xg": mm["xg"], "vision_score_pct": mm["vision_score_pct"],
                   "brave_passes": mm["brave_passes"], "why": mm["why"]}, [])
    for c in (c1, c2):
        assert not check_graphic(fallback_graphic(c), c.facts)
