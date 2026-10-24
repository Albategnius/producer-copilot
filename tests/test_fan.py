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
