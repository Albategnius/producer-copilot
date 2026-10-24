"""Multi-agent graphics pipeline built on Microsoft Agent Framework.

Workflow graph (one run per candidate moment):

    MomentScout -> StatsAnalyst -> GraphicsProducer -> FactChecker
                                         ^                 |
                                         +---- retry ------+

After a human producer approves a graphic, the FeedAdapter agent rewrites it for
each output feed, and the StudioPackage agent builds half-time / full-time
rundowns. Models come from any OpenAI-compatible chat API; responses are cached
on disk so a seeded replay is reproducible and runs offline once recorded.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import os
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Awaitable, Callable

from agent_framework import Agent, Executor, WorkflowBuilder, WorkflowContext, handler

from .factcheck import NUMBER_RE, allowed_numbers, check_graphic
from .moments import Candidate
from .templates import FEEDS, TEMPLATES, template_catalog

log = logging.getLogger(__name__)

CACHE_PATH = Path(__file__).resolve().parent.parent / "data" / "llm_cache.json"
MAX_PRODUCER_ATTEMPTS = 3

Notify = Callable[[str, dict], Awaitable[None]]


# --- model access ------------------------------------------------------------

class ModelGateway:
    """Creates agents on any OpenAI-compatible chat API and caches every response by prompt."""

    def __init__(self) -> None:
        self.base_url = os.getenv("LLM_BASE_URL") or None
        self.api_key = os.getenv("LLM_API_KEY") or None
        self.model = os.getenv("LLM_MODEL", "gpt-4.1-mini")
        self.min_interval = float(os.getenv("LLM_MIN_INTERVAL_S", "1.0"))
        self.use_cache = os.getenv("LLM_CACHE", "1") != "0"
        # GPT-5 family: "minimal" / "low" keeps replies fast enough for a live desk. Unset for other models.
        effort = os.getenv("LLM_REASONING_EFFORT", "").strip()
        self.default_options = {"reasoning_effort": effort} if effort else None
        self.client = None
        if self.api_key or self.base_url:
            from agent_framework.openai import OpenAIChatCompletionClient

            # Local servers such as Ollama ignore the key, but the client requires one.
            self.client = OpenAIChatCompletionClient(model=self.model, base_url=self.base_url,
                                                     api_key=self.api_key or "not-needed")
        self._agents: dict[str, Agent] = {}
        self._instructions: dict[str, str] = {}
        self._sem = asyncio.Semaphore(int(os.getenv("LLM_CONCURRENCY", "4")))
        self._pace = asyncio.Lock()
        self._last_call = 0.0
        self.cache: dict[str, str] = {}
        if CACHE_PATH.exists():
            self.cache = json.loads(CACHE_PATH.read_text())

    @property
    def mode(self) -> str:
        if self.client:
            return f"live ({self.model})"
        return "cache + fallback" if self.cache else "fallback templates"

    def register(self, name: str, instructions: str) -> None:
        self._instructions[name] = instructions
        if self.client:
            self._agents[name] = Agent(client=self.client, name=name, instructions=instructions,
                                       default_options=self.default_options)

    def _key(self, name: str, prompt: str) -> str:
        return hashlib.sha256(f"{self.model}\n{name}\n{self._instructions[name]}\n{prompt}".encode()).hexdigest()[:24]

    async def ask_json(self, name: str, prompt: str) -> tuple[dict | None, str]:
        """Return (parsed JSON or None, source) where source is cache / llm / fallback reason."""
        key = self._key(name, prompt)
        if self.use_cache and key in self.cache:
            parsed = _parse_json(self.cache[key])
            if parsed is not None:
                return parsed, "cache"
        agent = self._agents.get(name)
        if agent is None:
            return None, "fallback (no model configured)"
        async with self._sem:  # a few calls in parallel; optional spacing for rate-limited free tiers
            if self.min_interval > 0:
                async with self._pace:
                    wait = self.min_interval - (time.monotonic() - self._last_call)
                    if wait > 0:
                        await asyncio.sleep(wait)
                    self._last_call = time.monotonic()
            try:
                resp = await asyncio.wait_for(agent.run(prompt), timeout=45)
                text = resp.text
            except Exception as exc:  # rate limits, network, content filter
                log.warning("agent %s failed: %s", name, exc)
                return None, f"fallback ({type(exc).__name__})"
        parsed = _parse_json(text)
        if parsed is None:
            return None, "fallback (unparseable reply)"
        if self.use_cache:
            self.cache[key] = text
            CACHE_PATH.parent.mkdir(parents=True, exist_ok=True)
            CACHE_PATH.write_text(json.dumps(self.cache, indent=1))
        return parsed, "llm"


def _parse_json(text: str) -> dict | None:
    start, end = text.find("{"), text.rfind("}")
    if start == -1 or end <= start:
        return None
    try:
        value = json.loads(text[start:end + 1])
    except json.JSONDecodeError:
        return None
    return value if isinstance(value, dict) else None


# --- agent instructions --------------------------------------------------------

ANALYST = "StatsAnalyst"
PRODUCER = "GraphicsProducer"
FEED_ADAPTER = "FeedAdapter"
STUDIO = "StudioPackage"

INSTRUCTIONS = {
    ANALYST: (
        "You are the Stats Analyst in a live football broadcast graphics team. You receive one detected "
        "match moment with verified facts. Explain WHY it matters right now, not just what happened: "
        "game state, control vs chaos, pressing, rhythm, player form. Use only numbers present in the facts. "
        'Reply with JSON only: {"angle": "<=6 word label", "why_now": "<=200 chars", '
        '"key_facts": ["fact keys you relied on"]}'
    ),
    PRODUCER: (
        "You are the Graphics Producer in a live football broadcast team. Turn an analyst insight into ONE "
        "on-screen graphic. Pick exactly one template from the catalog, fill every slot, and never exceed a "
        "slot's character limit. Every number you write must come from the facts (whole-number rounding is "
        "fine). No emojis, no hashtags. Reply with JSON only: "
        '{"template": "<template name>", "slots": {"<slot>": "<text>"}}'
    ),
    FEED_ADAPTER: (
        "You adapt an approved broadcast graphic for three audiences. The three versions must be obviously "
        "different in voice and wording, not light paraphrases.\n"
        "main = TV studio: crisp, neutral, precise football vocabulary.\n"
        "casual = fan app for people new to football: everyday words, no jargon. Replace terms like xG, "
        "turnovers, pressures, final-third entries, momentum with plain explanations (e.g. 'won the ball back', "
        "'chance quality', 'got into the danger zone'). Friendly, short sentences.\n"
        "club = the chosen club's own channel, speaking AS the club: 'we', 'our', 'the lads', proud and emotional "
        "when it goes our way, defiant when it does not; still factual.\n"
        "Example (lower_third, club = Riverside Athletic). main: {headline: 'RIVERSIDE PRESS IS BITING', body: "
        "'4 high turnovers in 6 min; Northgate passing at 71%'}. casual: {headline: 'Riverside hunting the ball', "
        "body: 'They won it back near goal 4 times in 6 minutes'}. club: {headline: 'OUR PRESS IS ON FIRE', body: "
        "'We have won it back 4 times in 6 minutes. Northgate cannot breathe'}.\n"
        "Keep the same template and slot names. Every slot must stay within its character limit (count "
        "carefully; shorter is safer). Keep pure value slots (numbers, scores) exactly as given. Never add a "
        "number that is not in the facts. Reply with JSON only: "
        '{"main": {"<slot>": "<text>"}, "casual": {...}, "club": {...}}'
    ),
    STUDIO: (
        "You are the studio package editor for half-time and full-time shows. From the approved on-air "
        "graphics and match totals, pick the moments the presenter should revisit and write a short script. "
        "Use only numbers present in the input. Reply with JSON only: "
        '{"headline": "<=60 chars", "rundown": [{"id": "<suggestion id>", "why": "<=100 chars"}], '
        '"script": "60-90 words"}'
    ),
}


def build_gateway() -> ModelGateway:
    gw = ModelGateway()
    for name, text in INSTRUCTIONS.items():
        gw.register(name, text)
    return gw


# --- deterministic fallbacks ---------------------------------------------------

def _fit(text: str, limit: int) -> str:
    text = str(text)
    return text if len(text) <= limit else text[: limit - 1].rstrip() + "…"


def fallback_analysis(c: Candidate) -> dict:
    f = c.facts
    why = {
        "goal": lambda: f"{f['scorer']} scores; a {f['shot_xg']} xG chance changes the game state to {f['score']}.",
        "big_chance": lambda: f"{f['shooter']} had a {f['shot_xg']} xG chance; {f['team']} are building pressure.",
        "press_spell": lambda: f"{f['team']} have won the ball high {f['high_turnovers_won']} times in {f['window_minutes']} minutes.",
        "momentum_swing": lambda: f"Momentum has flipped to {f['team']} with {f['shots_last_5_min']} shots in 5 minutes.",
        "chaos": lambda: f"{f['possession_changes_per_min']} possession changes per minute: neither side has control.",
        "hard_pass": lambda: f"{f['passer']} completed a {f['pass_length_m']} m pass rated {f['pass_difficulty']}/100.",
        "sprint": lambda: f"{f['player']} hit {f['speed_kmh']} km/h, above the sprint threshold.",
        "missed_option": lambda: (f"{f['team']} were on the front foot, but {f['passer']} played it back; "
                                  f"{f['open_teammate']} looked free ahead (estimated positions)."),
        "fan_request": lambda: f"Fans asked: {f['fan_question']}",
    }[c.kind]()
    return {"angle": c.title, "why_now": why, "key_facts": list(f)}


def fallback_graphic(c: Candidate) -> dict:
    f = c.facts
    if c.kind == "goal":
        g = {"template": "lower_third", "slots": {
            "headline": f"GOAL - {f['scorer']}",
            "body": f"{f['score']}. {f['shot_xg']} xG chance from {round(f['shot_distance_m'])} m at {round(f['shot_speed_kmh'])} km/h."}}
    elif c.kind == "big_chance":
        g = {"template": "player_tag", "slots": {
            "player": f["shooter"], "stat_label": "Chance quality (xG)", "stat_value": str(f["shot_xg"]),
            "context": f"Shot {f['outcome'].replace('_', ' ')} from {round(f['shot_distance_m'])} m"}}
    elif c.kind == "press_spell":
        g = {"template": "lower_third", "slots": {
            "headline": f"{f['team']} press is biting",
            "body": f"{f['high_turnovers_won']} high turnovers in {f['window_minutes']} min; "
                    f"{f['opponent']} passing at {f['opponent_pass_accuracy_pct']}%"}}
    elif c.kind == "momentum_swing":
        g = {"template": "momentum_bar", "slots": {
            "headline": f"{f['team']} on top",
            "caption": f"{f['shots_last_5_min']} shots, {f['final_third_entries_last_5_min']} final-third entries in 5 min"}}
    elif c.kind == "chaos":
        g = {"template": "lower_third", "slots": {
            "headline": "Control vs chaos",
            "body": f"{f['possession_changes_per_min']} possession changes per minute over the last 5 min"}}
    elif c.kind == "hard_pass":
        g = {"template": "pass_card", "slots": {
            "player": f["passer"], "distance": f"{round(f['pass_length_m'])} m",
            "difficulty": f"{f['pass_difficulty']}/100",
            "caption": f"Found {f['receiver']}" + (" under pressure" if f["under_pressure"] else "")}}
    elif c.kind == "missed_option":
        g = {"template": "lower_third", "slots": {
            "headline": f"Decision Lens: {f['passer']}",
            "body": f"#{f['passer_number']} played back; #{f['open_teammate_number']} {f['open_teammate']} was free ahead (estimate)"}}
    elif c.kind == "fan_request":
        g = {"template": "lower_third", "slots": {"headline": "You asked", "body": f["answer_short"]}}
    else:
        g = {"template": "player_tag", "slots": {
            "player": f["player"], "stat_label": "Top speed", "stat_value": f"{f['speed_kmh']} km/h",
            "context": f"Above the {f['speed_threshold_kmh']} km/h sprint threshold"}}
    limits = TEMPLATES[g["template"]]["slots"]
    g["slots"] = {k: _fit(v, limits[k]) for k, v in g["slots"].items()}
    return g


# --- workflow messages and executors ---------------------------------------------

@dataclass
class GraphicJob:
    candidate: Candidate
    analysis: dict | None = None
    graphic: dict | None = None
    attempts: list[dict] = field(default_factory=list)
    status: str = "drafting"
    dropped_reason: str | None = None


def _inject_fault(graphic: dict, facts: dict) -> dict | None:
    """Test mode: corrupt one number so the Fact Checker's retry path is exercised."""
    g = json.loads(json.dumps(graphic))
    allowed = allowed_numbers(facts)
    for slot, text in g.get("slots", {}).items():
        m = NUMBER_RE.search(str(text))
        if m:
            bad = round(float(m.group()) * 1.5) + 3
            while any(abs(bad - a) < 0.6 for a in allowed):
                bad += 1
            wrong = str(bad)
            g["slots"][slot] = str(text)[: m.start()] + wrong + str(text)[m.end():]
            return g
    return None


class MomentScout(Executor):
    """Rule-based gatekeeper: drops stale moments and repeats of what is already queued."""

    def __init__(self, clock: Callable[[], float], recent: Callable[[], list[Candidate]], notify: Notify):
        super().__init__(id="MomentScout")
        self.clock, self.recent, self.notify = clock, recent, notify

    @handler
    async def scout(self, c: Candidate, ctx: WorkflowContext[GraphicJob, GraphicJob]) -> None:
        job = GraphicJob(candidate=c)
        age = self.clock() - c.t
        if c.kind != "goal" and age > 240:
            job.status, job.dropped_reason = "dropped", f"stale: {int(age // 60)} match minutes old"
        elif c.kind != "fan_request" and any(r.kind == c.kind and r.team == c.team and c.t - r.t < 600 for r in self.recent() if r.id != c.id):
            job.status, job.dropped_reason = "dropped", "similar graphic already proposed in last 10 min"
        await self.notify("trace", {"id": c.id, "agent": "MomentScout",
                                    "detail": job.dropped_reason or f"accepted (priority {c.priority})"})
        if job.status == "dropped":
            await ctx.yield_output(job)
        else:
            await ctx.send_message(job)


class StatsAnalyst(Executor):
    def __init__(self, gw: ModelGateway, notify: Notify):
        super().__init__(id="StatsAnalyst")
        self.gw, self.notify = gw, notify

    @handler
    async def analyse(self, job: GraphicJob, ctx: WorkflowContext[GraphicJob]) -> None:
        c = job.candidate
        prompt = (f"Moment: {c.title} (minute {c.minute}, kind={c.kind})\n"
                  f"Facts (verified): {json.dumps(c.facts)}")
        result, source = await self.gw.ask_json(ANALYST, prompt)
        if not result or not result.get("why_now"):
            result = fallback_analysis(c)
        job.analysis = {"angle": str(result.get("angle", c.title)), "why_now": str(result["why_now"]), "source": source}
        await self.notify("trace", {"id": c.id, "agent": "StatsAnalyst", "detail": job.analysis["why_now"], "source": source})
        await ctx.send_message(job)


class GraphicsProducer(Executor):
    def __init__(self, gw: ModelGateway, notify: Notify, inject_faults: bool):
        super().__init__(id="GraphicsProducer")
        self.gw, self.notify, self.inject_faults = gw, notify, inject_faults

    @handler
    async def produce(self, job: GraphicJob, ctx: WorkflowContext[GraphicJob]) -> None:
        c = job.candidate
        prompt = (f"Moment: {c.title} (minute {c.minute})\nFacts (verified): {json.dumps(c.facts)}\n"
                  f"Analyst insight: {job.analysis['why_now']}\n\nTemplate catalog:\n{template_catalog()}")
        if job.attempts:
            last = job.attempts[-1]
            prompt += (f"\n\nYour previous draft was REJECTED by the Fact Checker.\nDraft: {json.dumps(last['graphic'])}\n"
                       f"Issues: {'; '.join(last['issues'])}\nFix every issue.")
        result, source = await self.gw.ask_json(PRODUCER, prompt)
        if not result or "template" not in result:
            result, source = fallback_graphic(c), source if source.startswith("fallback") else "fallback (bad shape)"
        note = None
        if self.inject_faults and not job.attempts:
            corrupted = _inject_fault(result, c.facts)
            if corrupted:
                result, note = corrupted, "fault injected (test mode)"
        job.graphic = {"template": result.get("template"), "slots": result.get("slots", {}), "source": source}
        await self.notify("trace", {"id": c.id, "agent": "GraphicsProducer",
                                    "detail": f"draft {len(job.attempts) + 1}: {job.graphic['template']}"
                                              + (f" - {note}" if note else ""), "source": source,
                                    "graphic": job.graphic})
        await ctx.send_message(job)


class FactChecker(Executor):
    def __init__(self, notify: Notify):
        super().__init__(id="FactChecker")
        self.notify = notify

    @handler
    async def check(self, job: GraphicJob, ctx: WorkflowContext[GraphicJob, GraphicJob]) -> None:
        c = job.candidate
        issues = check_graphic(job.graphic, c.facts)
        job.attempts.append({"graphic": job.graphic, "issues": issues})
        await self.notify("trace", {"id": c.id, "agent": "FactChecker",
                                    "detail": "passed" if not issues else "rejected: " + "; ".join(issues),
                                    "ok": not issues})
        if not issues:
            job.status = "pending"
            await ctx.yield_output(job)
        elif len(job.attempts) < MAX_PRODUCER_ATTEMPTS:
            await ctx.send_message(job)
        else:
            job.graphic = {**fallback_graphic(c), "source": "fallback (fact check failed 3x)"}
            job.attempts.append({"graphic": job.graphic, "issues": check_graphic(job.graphic, c.facts)})
            job.status = "pending"
            await self.notify("trace", {"id": c.id, "agent": "FactChecker",
                                        "detail": "3 drafts rejected; using verified template fallback", "ok": True})
            await ctx.yield_output(job)


async def run_graphic_pipeline(c: Candidate, gw: ModelGateway, *, clock, recent, notify: Notify,
                               inject_faults: bool = False) -> GraphicJob:
    scout = MomentScout(clock, recent, notify)
    analyst = StatsAnalyst(gw, notify)
    producer = GraphicsProducer(gw, notify, inject_faults)
    checker = FactChecker(notify)
    workflow = (
        WorkflowBuilder(start_executor=scout, max_iterations=20)
        .add_edge(scout, analyst)
        .add_edge(analyst, producer)
        .add_edge(producer, checker)
        .add_edge(checker, producer)
        .build()
    )
    result = await workflow.run(c)
    outputs = result.get_outputs()
    return outputs[-1]


# --- post-approval agents ---------------------------------------------------------

async def adapt_feeds(gw: ModelGateway, c: Candidate, graphic: dict, club: str) -> tuple[dict[str, dict], str]:
    """Rewrite an approved graphic for each feed; each feed version is fact-checked."""
    tpl = graphic["template"]
    limits = TEMPLATES[tpl]["slots"]
    feeds_desc = "\n".join(f"- {k}: {v}" for k, v in FEEDS.items())
    prompt = (f"Approved graphic (template {tpl}, slot limits {json.dumps(limits)}):\n{json.dumps(graphic['slots'])}\n"
              f"Facts: {json.dumps(c.facts)}\nChosen club for the club feed: {club}\nFeeds:\n{feeds_desc}")
    result, source = await gw.ask_json(FEED_ADAPTER, prompt)
    original = graphic["slots"]

    def evaluate(slots: dict) -> tuple[dict, list[str], dict[str, str]]:
        """Merge a feed's proposal slot by slot; return (slots, rewritten keys, {blocked key: reason})."""
        merged = {k: str(slots.get(k, "")).strip() or v for k, v in original.items()}
        issues = check_graphic({"template": tpl, "slots": merged}, c.facts)
        blocked = {k: next(i for i in issues if f"'{k}'" in i) for k in merged if any(f"'{k}'" in i for i in issues)}
        for k in blocked:
            merged[k] = original[k]
        rewritten = [k for k in merged if k not in blocked and merged[k] != original[k]]
        return merged, rewritten, blocked

    proposals = {f: (result or {}).get(f) for f in FEEDS}
    done = {f: evaluate(v) for f, v in proposals.items() if isinstance(v, dict)}

    # One repair round, like the drafting loop: the Fact Checker's notes go back to the FeedAdapter.
    notes = [f"{f}.{k}: {why}" for f, (_, _, blocked) in done.items() if f != "main" for k, why in blocked.items()]
    if notes:
        repair = (prompt + f"\nYour previous versions: {json.dumps({f: proposals[f] for f in done})}\n"
                  "The Fact Checker rejected these lines:\n" + "\n".join(notes) +
                  "\nRewrite only those lines, keeping each feed's voice. Same JSON shape with all three feeds.")
        fixed, src2 = await gw.ask_json(FEED_ADAPTER, repair)
        for f, (merged, rewritten, blocked) in list(done.items()):
            again = (fixed or {}).get(f)
            if f == "main" or not blocked or not isinstance(again, dict):
                continue
            retry = {**merged, **{k: again.get(k, "") for k in blocked}}
            m2, r2, b2 = evaluate(retry)
            if len(b2) < len(blocked):
                done[f] = (m2, r2, b2)

    feeds: dict[str, dict] = {}
    for feed in FEEDS:
        if feed not in done:
            feeds[feed] = {"slots": dict(original), "source": f"approved graphic ({source})", "rewritten": []}
            continue
        merged, rewritten, blocked = done[feed]
        feeds[feed] = {"slots": merged, "source": source if rewritten else "approved graphic", "rewritten": rewritten,
                       "blocked": list(blocked)}
    return feeds, source


async def studio_package(gw: ModelGateway, phase: str, approved: list[dict], totals: dict, score: str) -> dict:
    items = [{"id": a["id"], "minute": a["candidate"]["minute"], "title": a["candidate"]["title"],
              "on_air": a["graphic"]["slots"], "why": a["analysis"]["why_now"]} for a in approved]
    facts = {"score": score, "totals": totals, "items": items}
    prompt = f"Phase: {phase}\nScore: {score}\nMatch totals: {json.dumps(totals)}\nApproved graphics: {json.dumps(items)}"
    result, source = await gw.ask_json(STUDIO, prompt) if items else (None, "fallback (nothing approved yet)")
    allowed = allowed_numbers(facts)
    ok = bool(result) and isinstance(result.get("rundown"), list) and all(
        any(abs(float(n) - a) < 0.051 for a in allowed)
        for n in NUMBER_RE.findall(str(result.get("script", "")) + str(result.get("headline", "")))
    )
    if not ok:
        ranked = sorted(approved, key=lambda a: -a["candidate"]["priority"])[:5]
        result = {
            "headline": f"{phase.replace('_', ' ').title()}: {score}",
            "rundown": [{"id": a["id"], "why": a["analysis"]["why_now"][:100]} for a in ranked],
            "script": f"{score}. " + " ".join(a["analysis"]["why_now"] for a in ranked[:3]),
        }
        source = source if source.startswith("fallback") else "fallback (script failed fact check)"
    result["source"] = source
    result["phase"] = phase
    return result
