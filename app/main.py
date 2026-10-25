"""Producer Console server: replays a synthetic match and runs the agent pipeline live."""

from __future__ import annotations

import asyncio
import itertools
import json
import os
import re
import time
from datetime import datetime, timezone
from pathlib import Path

from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, Query, Request
import hashlib

from fastapi.responses import HTMLResponse, Response, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

load_dotenv()

from .agents import adapt_feeds, build_gateway, run_graphic_pipeline, studio_package  # noqa: E402
from .factcheck import check_graphic  # noqa: E402
from .generator import generate_match  # noqa: E402
from .moments import Candidate, MomentDetector  # noqa: E402
from .stats import MatchState, attacking_x  # noqa: E402
from .decisions import DecisionLens  # noqa: E402
from .ratings import man_of_the_match, ratings  # noqa: E402
from .fan import answer_question, facts_for_graphic  # noqa: E402
from .templates import FEEDS, TEMPLATES  # noqa: E402
from . import tts  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
WEB = ROOT / "web"
DATA = ROOT / "data"


def load_match(seed: int) -> dict:
    path = DATA / f"match_{seed}.json"
    if not path.exists():
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(generate_match(seed), indent=1))
    return json.loads(path.read_text())


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


class Session:
    def __init__(self, seed: int, gw=None):
        self.seed = seed
        self.gw = gw or build_gateway()
        self.last_seen = time.monotonic()
        self.clients: set[asyncio.Queue] = set()
        self.speed = float(os.getenv("REPLAY_SPEED", "15"))
        self.inject_faults = os.getenv("INJECT_FAULTS", "0") == "1"
        self.replay_task: asyncio.Task | None = None
        self.worker_task: asyncio.Task | None = None
        self.reset()

    # --- lifecycle ----------------------------------------------------------

    def reset(self) -> None:
        for task in getattr(self, "bg_tasks", set()):
            task.cancel()
        for task in (getattr(self, "replay_task", None), getattr(self, "worker_task", None)):
            if task:
                task.cancel()
        self.replay_task = self.worker_task = None
        self.match = load_match(self.seed)
        self.meta = self.match["meta"]
        self.state = MatchState(self.meta)
        self.detector = MomentDetector(self.state)
        self.lens = DecisionLens(self.meta)
        self.asks: dict[str, dict] = {}
        self.ask_times: list[float] = []
        self.idx = 0
        self.running = False
        self.on_break = False
        self.celebrating: str | None = None
        self.club = self.meta["home"]
        self.suggestions: dict[str, dict] = {}
        self.candidates: dict[str, Candidate] = {}
        self.overlays: list[dict] = []
        self.bg_tasks: set[asyncio.Task] = set()
        self.audit: list[dict] = []
        self.packages: list[dict] = []
        self.queue: asyncio.PriorityQueue = asyncio.PriorityQueue()
        self._seq = itertools.count()

    def ensure_worker(self) -> None:
        if self.worker_task is None or self.worker_task.done():
            self.worker_task = asyncio.create_task(self._workers())

    def start(self) -> None:
        self.ensure_worker()
        self.running = True
        if self.replay_task is None or self.replay_task.done():
            self.replay_task = asyncio.create_task(self._replay())

    # --- broadcasting -------------------------------------------------------

    async def broadcast(self, kind: str, data) -> None:
        msg = f"event: {kind}\ndata: {json.dumps(data)}\n\n"
        for q in list(self.clients):
            q.put_nowait(msg)

    def log(self, action: str, suggestion_id: str | None, details: str = "", actor: str = "producer") -> dict:
        entry = {"at": now_iso(), "match_minute": self.state.snapshot()["minute"], "actor": actor,
                 "action": action, "suggestion_id": suggestion_id, "details": details}
        self.audit.append(entry)
        return entry

    # --- replay -------------------------------------------------------------

    async def _replay(self) -> None:
        events = self.match["events"]
        last_stats = 0.0
        loop = asyncio.get_running_loop()
        while self.idx < len(events):
            if not self.running:
                await asyncio.sleep(0.2)
                continue
            ev = events[self.idx]
            dt = max(0.0, ev["t"] - self.state.t)
            await asyncio.sleep(min(dt / self.speed, 1.5))
            self.state.apply(ev)
            self.idx += 1
            await self.broadcast("match_event", ev)
            await self.expire_stale()
            new = list(self.detector.check(ev))
            if ev["type"] == "substitution":
                self.lens.substitute(ev)
                new.append(self._substitution_candidate(ev))
            if ev["type"] == "full_time" and (motm := man_of_the_match(self.state, self.lens)):
                new.append(self._motm_candidate(motm))
            flag = self._decision(ev)
            if flag:
                await self.broadcast("decision", flag)
                if flag["kind"] == "missed_option" and self.detector._cool(f"missed_option:{flag['team']}", 480):
                    new.append(self._decision_candidate(flag))
            for c in new:
                await self.enqueue(c)
            if loop.time() - last_stats > 0.4 or ev["type"] in ("goal", "half_end", "full_time"):
                last_stats = loop.time()
                await self.broadcast("stats", self.stats_payload())
            if ev["type"] in ("half_end", "full_time"):
                asyncio.create_task(self.make_package("half_time" if ev["type"] == "half_end" else "full_time"))
            if ev["type"] == "goal":
                # Celebration: play stops for a moment before the restart, as on TV.
                self.celebrating = ev["id"]
                await self.broadcast("status", self.status())
                await self._rest(GOAL_PAUSE_S)
                self.celebrating = None
                await self.broadcast("status", self.status())
            if ev["type"] == "half_end":
                # A real half-time break: the replay rests while the studio shows the first-half picture.
                self.on_break = True
                await self.broadcast("status", self.status())
                waited = 0.0
                # The break scales with replay speed: a fast-forward should not stall on a long pause.
                while waited < HALFTIME_S * min(1.0, 15.0 / self.speed):
                    await asyncio.sleep(0.25)
                    if self.running:
                        waited += 0.25
                self.on_break = False
                await self.broadcast("status", self.status())
        self.running = False
        for sug in self.suggestions.values():
            if sug["status"] == "queued" and sug["candidate"]["kind"] != "man_of_match":
                sug["status"], sug["dropped_reason"] = "dropped", "expired: full time"
                await self.broadcast("suggestion", sug)
        await self.broadcast("status", self.status())

    async def _rest(self, seconds: float) -> None:
        """Pause the replay for real seconds (scaled down at high replay speeds); paused time doesn't count."""
        waited = 0.0
        while waited < seconds * min(1.0, 15.0 / self.speed):
            await asyncio.sleep(0.25)
            if self.running:
                waited += 0.25

    async def enqueue(self, c: Candidate) -> None:
        self.candidates[c.id] = c
        self.suggestions[c.id] = {"id": c.id, "candidate": c.to_dict(), "status": "queued", "trace": []}
        await self.broadcast("suggestion", self.suggestions[c.id])
        await self.queue.put((-c.priority, c.t, next(self._seq), c.id))

    def stats_payload(self) -> dict:
        rows = ratings(self.state, self.lens)
        return {**self.state.snapshot(), "vision": self.lens.leaderboard(),
                "ratings": [{k: r[k] for k in ("player_id", "rating", "minutes_played", "vision_score_pct", "goals")} for r in rows],
                "motm": man_of_the_match(self.state, self.lens, rows)}

    def _substitution_candidate(self, ev: dict) -> Candidate:
        p_off, p_on = self.state.players[ev["player_off_id"]], self.state.players[ev["player_on_id"]]
        return self.detector._make(
            "substitution", ev["team"], ev["player_on_id"], f"Substitution - {self.state.teams[ev['team']]['short']}",
            {"player_off": ev["player_off"], "player_off_number": p_off["number"], "player_on": ev["player_on"],
             "player_on_number": p_on["number"], "position": ev.get("role"),
             "player_off_minutes": self.state.minutes_played(ev["player_off_id"])}, [ev["id"]])

    def _motm_candidate(self, m: dict) -> Candidate:
        return self.detector._make(
            "man_of_match", m["team"], m["player_id"], f"Man of the Match - {m['player']}",
            {"player": m["player"], "player_number": m["number"], "match_rating": m["rating"], "goals": m["goals"],
             "xg": m["xg"], "vision_score_pct": m["vision_score_pct"], "brave_passes": m["brave_passes"],
             "missed_options": m["missed_options"], "why": m["why"], "rating_components": m["components"]}, [])

    def _decision(self, ev: dict) -> dict | None:
        """Decision Lens: rate each pass against the estimated options the passer had."""
        if ev["type"] != "pass":
            return None
        own_momentum = self.state.momentum().value * (1 if ev["team"] == self.state.home else -1)
        attacking = attacking_x(self.meta, ev["team"], ev["x"]) >= 55 or own_momentum >= 15
        return self.lens.observe(ev, attacking)

    def _decision_candidate(self, f: dict) -> Candidate:
        return self.detector._make(
            "missed_option", f["team"], f["player_id"], f"Decision Lens - {f['player']}",
            {"passer": f["player"], "passer_number": f["number"], "receiver": f["receiver"],
             "open_teammate": f["open_player"], "open_teammate_number": f["open_number"],
             "decision_quality_pct": f["decision_quality_pct"],
             "chosen_option_threat": round(f["chosen_threat"], 2), "best_option_threat": round(f["best_threat"], 2),
             "attacking_moment": True, "positions_estimated_from_formation": True},
            [f["event_id"]])

    async def _workers(self) -> None:
        # Several moments are drafted in parallel so the desk keeps pace with the match.
        await asyncio.gather(*(self._worker() for _ in range(WORKERS)))

    async def _worker(self) -> None:
        while True:
            _, _, _, cid = await self.queue.get()
            c = self.candidates.get(cid)
            sug = self.suggestions.get(cid)
            if not c or not sug or sug["status"] != "queued":
                continue
            limit = STALE_GOAL_S if c.kind == "goal" else STALE_S
            if (self.state.finished and c.kind != "man_of_match") or self.state.t - c.t > limit:
                # Too late to air: drafting it now would only show the producer an old moment.
                sug["status"] = "dropped"
                sug["dropped_reason"] = "expired: the match moved on before the agents reached it"
                await self.broadcast("suggestion", sug)
                continue
            sug["status"] = "drafting"
            await self.broadcast("suggestion", sug)

            async def notify(kind: str, payload: dict, sug=sug) -> None:
                sug["trace"].append(payload)
                await self.broadcast("trace", payload)

            recent = lambda: [self.candidates[s["id"]] for s in self.suggestions.values()  # noqa: E731
                              if s["status"] in ("pending", "approved", "on_air") and s["id"] in self.candidates]
            try:
                job = await run_graphic_pipeline(c, self.gw, clock=lambda: self.state.t, recent=recent,
                                                 notify=notify, inject_faults=self.inject_faults)
            except Exception as exc:  # keep the console alive whatever happens
                sug["status"], sug["dropped_reason"] = "dropped", f"pipeline error: {exc}"
                await self.broadcast("suggestion", sug)
                continue
            sug.update({"status": job.status, "analysis": job.analysis, "graphic": job.graphic,
                        "attempts": len(job.attempts), "dropped_reason": job.dropped_reason,
                        "proposed_at_t": self.state.t})
            if job.status == "pending":
                self.log("proposed", cid, f"{job.graphic['template']} after {len(job.attempts)} draft(s)", actor="agents")
            await self.broadcast("suggestion", sug)

    # --- fans ---------------------------------------------------------------

    async def ask(self, question: str) -> dict:
        now = time.monotonic()
        self.ask_times = [t for t in self.ask_times if now - t < 60]
        if len(self.ask_times) >= ASKS_PER_MINUTE:
            raise HTTPException(429, "Too many questions this minute. Try again shortly.")
        self.ask_times.append(now)
        result = await answer_question(self.gw, self.state, self.lens, question)
        qid = f"q{len(self.asks) + 1:03d}"
        self.asks[qid] = {"id": qid, "question": question, **result, "requested": None}
        self.log("fan_question", None, f"{question[:80]} -> {result['source']}", actor="fan")
        await self.broadcast("audit", self.audit[-1])
        return {k: v for k, v in self.asks[qid].items() if k != "facts"}

    async def fan_request(self, qid: str) -> dict:
        a = self.asks.get(qid)
        if not a:
            raise HTTPException(404, "unknown question")
        if not a["verified"]:
            raise HTTPException(409, "Only verified answers can be requested on screen.")
        if a["requested"]:
            return {"suggestion_id": a["requested"]}
        title = "Fan request: " + (a["question"][:48] + ("…" if len(a["question"]) > 48 else ""))
        c = self.detector._make("fan_request", a["team"], a["player_id"], title,
                                facts_for_graphic(a["question"], a), [])
        a["requested"] = c.id
        self.log("fan_request", c.id, a["question"][:80], actor="fan")
        await self.enqueue(c)
        await self.broadcast("audit", self.audit[-1])
        return {"suggestion_id": c.id}

    async def expire_stale(self) -> None:
        """A live graphic loses its value fast: retire pending ideas once the moment has passed."""
        for sid, sug in self.suggestions.items():
            c = self.candidates.get(sid)
            if sug["status"] != "pending" or not c:
                continue
            limit = STALE_GOAL_S if c.kind == "goal" else STALE_S
            # Count from when the idea reached the producer, so slow model replies don't eat their window.
            age = self.state.t - max(c.t, sug.get("proposed_at_t") or c.t)
            if age > limit:
                sug["status"] = "dropped"
                sug["dropped_reason"] = f"expired: waited {int(age // 60)} match minutes without a decision"
                self.log("expired", sid, sug["dropped_reason"], actor="agents")
                await self.broadcast("suggestion", sug)
                await self.broadcast("audit", self.audit[-1])

    # --- producer actions ---------------------------------------------------

    async def approve(self, sid: str, slots: dict | None) -> dict:
        sug = self._pending(sid)
        c = self.candidates[sid]
        graphic = {"template": sug["graphic"]["template"], "slots": slots or sug["graphic"]["slots"]}
        if slots:
            issues = check_graphic(graphic, c.facts)
            if issues:
                raise HTTPException(400, {"issues": issues})
            sug["graphic"] = {**sug["graphic"], "slots": slots, "edited": True}
            self.log("edited", sid, json.dumps(slots))
        # On air immediately with the approved text in every feed; FeedAdapter's fan-app and club
        # versions replace theirs a few seconds later, after their own fact check.
        t_in = self.state.t
        duration = TEMPLATES[graphic["template"]]["duration_s"]
        feeds = {f: {"slots": dict(graphic["slots"]), "source": "approved graphic", "rewritten": [],
                     "pending": f != "main"} for f in FEEDS}
        new_overlays = [self._overlay(sid, c, graphic, f, feeds[f], t_in, duration) for f in FEEDS]
        self.overlays.extend(new_overlays)
        sug.update({"status": "approved", "feeds": feeds, "approved_at_t": t_in, "feeds_pending": True})
        self.log("approved", sid, f"on air in {len(feeds)} feeds")
        await self.broadcast("suggestion", sug)
        await self.broadcast("overlays", new_overlays)
        await self.broadcast("audit", self.audit[-1])
        task = asyncio.create_task(self._adapt(sid, c, graphic, t_in, duration))
        self.bg_tasks.add(task)
        task.add_done_callback(self.bg_tasks.discard)
        return sug

    def _overlay(self, sid: str, c: Candidate, graphic: dict, feed: str, content: dict, t_in: float, duration: float) -> dict:
        return {"id": f"{sid}-{feed}", "suggestion_id": sid, "feed": feed, "template": graphic["template"],
                "t_in": t_in, "t_out": t_in + duration, "duration_s": duration, "slots": content["slots"],
                "data": self._overlay_data(c), "source_event_ids": c.source_event_ids,
                "content_source": content["source"]}

    async def _adapt(self, sid: str, c: Candidate, graphic: dict, t_in: float, duration: float) -> None:
        sug = self.suggestions[sid]
        club_name = self.meta["teams"][0 if self.club == self.meta["home"] else 1]["name"]
        try:
            adapted, source = await adapt_feeds(self.gw, c, graphic, club_name)
        except Exception as exc:  # keep the approved text on air
            adapted, source = {}, f"fallback ({type(exc).__name__})"
        updates = []
        for feed in FEEDS:
            if feed == "main":
                continue  # TV airs exactly what the producer approved
            content = {**adapted.get(feed, sug["feeds"][feed]), "pending": False}
            sug["feeds"][feed] = content
            ov = self._overlay(sid, c, graphic, feed, content, t_in, duration)
            self.overlays = [o for o in self.overlays if o["id"] != ov["id"]] + [ov]
            updates.append({**ov, "update": True})
        sug["feeds"]["main"]["pending"] = False
        sug["feeds_pending"] = False
        self.log("feeds_adapted", sid, f"fan app and club versions (adapter: {source})", actor="agents")
        await self.broadcast("suggestion", sug)
        await self.broadcast("overlays", updates)
        await self.broadcast("audit", self.audit[-1])

    def _overlay_data(self, c: Candidate) -> dict:
        data = {"team": c.team, "kind": c.kind, "minute": c.minute}
        if c.kind == "momentum_swing":
            data["momentum"] = c.facts["momentum_now"] * (1 if c.team == self.meta["home"] else -1)
        return data

    async def reject(self, sid: str, reason: str) -> dict:
        sug = self._pending(sid)
        sug["status"], sug["reject_reason"] = "rejected", reason
        self.log("rejected", sid, reason)
        await self.broadcast("suggestion", sug)
        await self.broadcast("audit", self.audit[-1])
        return sug

    def _pending(self, sid: str) -> dict:
        sug = self.suggestions.get(sid)
        if not sug:
            raise HTTPException(404, "unknown suggestion")
        if sug["status"] != "pending":
            raise HTTPException(409, f"suggestion is {sug['status']}")
        return sug

    async def make_package(self, phase: str) -> dict:
        approved = [s for s in self.suggestions.values() if s["status"] == "approved"]
        if not approved:
            approved = [s for s in self.suggestions.values() if s["status"] == "pending"]
        s = self.state
        score = f"{s.teams[s.home]['short']} {s.score[s.home]}-{s.score[s.away]} {s.teams[s.away]['short']}"
        totals = {s.teams[t]["short"]: s.totals(t) for t in (s.home, s.away)}
        if (m := man_of_the_match(s, self.lens)):
            label = "man_of_the_match" if s.finished else "best_player_so_far"
            totals[label] = {"player": m["player"], "team": s.teams[m["team"]]["short"], "rating": m["rating"], "why": m["why"]}
        pkg = await studio_package(self.gw, phase, approved, totals, score)
        pkg["created_minute"] = s.snapshot()["minute"]
        self.packages.append(pkg)
        self.log("studio_package", None, f"{phase} rundown with {len(pkg.get('rundown', []))} items", actor="agents")
        await self.broadcast("package", pkg)
        await self.broadcast("audit", self.audit[-1])
        return pkg

    def status(self) -> dict:
        return {"running": self.running, "speed": self.speed, "inject_faults": self.inject_faults,
                "club": self.club, "mode": self.gw.mode, "seed": self.seed,
                "progress": self.idx / max(1, len(self.match["events"])),
                "finished": self.idx >= len(self.match["events"]), "half_time_break": self.on_break,
                "goal_celebration": self.celebrating}

    def full_state(self) -> dict:
        return {"meta": self.meta, "status": self.status(), "stats": self.stats_payload(),
                "decisions": self.lens.flags[-40:],
                "recent_events": self.state.events[-40:], "suggestions": list(self.suggestions.values()),
                "overlays": self.overlays, "audit": self.audit, "packages": self.packages,
                "templates": TEMPLATES, "feeds": FEEDS}


app = FastAPI(title="Producer Co-pilot")
app.mount("/static", StaticFiles(directory=WEB), name="static")

# One console per visitor, so judges testing the public demo at the same time never reset each
# other's match. The model gateway (rate limiter + reply cache) is shared by all sessions.
GATEWAY = build_gateway()
SEED = int(os.getenv("MATCH_SEED", "1"))
MAX_SESSIONS = int(os.getenv("MAX_SESSIONS", "40"))
IDLE_SECONDS = int(os.getenv("SESSION_IDLE_S", "1800"))
WORKERS = int(os.getenv("AGENT_WORKERS", "3"))
GOAL_PAUSE_S = float(os.getenv("GOAL_PAUSE_S", "4"))  # real seconds of goal celebration at 15x
HALFTIME_S = float(os.getenv("HALFTIME_BREAK_S", "8"))  # real seconds of half-time break
ASKS_PER_MINUTE = int(os.getenv("FAN_ASKS_PER_MINUTE", "8"))
STALE_S = int(os.getenv("STALE_MATCH_S", "360"))            # 6 match minutes for most moments
STALE_GOAL_S = int(os.getenv("STALE_GOAL_MATCH_S", "600"))  # 10 for goals
SESSIONS: dict[str, Session] = {}
SID_RE = re.compile(r"^[A-Za-z0-9_-]{6,64}$")


def _evict(sess: Session) -> None:
    for task in (sess.replay_task, sess.worker_task):
        if task:
            task.cancel()


def get_session(sid: str = Query("default")) -> Session:
    if not SID_RE.match(sid):
        raise HTTPException(400, "invalid session id")
    now = time.monotonic()
    for key, s in list(SESSIONS.items()):
        if now - s.last_seen > IDLE_SECONDS and not s.clients:
            _evict(SESSIONS.pop(key))
    sess = SESSIONS.get(sid)
    if sess is None:
        if len(SESSIONS) >= MAX_SESSIONS:
            oldest = min((k for k, s in SESSIONS.items() if not s.clients), key=lambda k: SESSIONS[k].last_seen, default=None)
            if oldest is None:
                raise HTTPException(503, "the demo is busy, please try again in a minute")
            _evict(SESSIONS.pop(oldest))
        sess = SESSIONS[sid] = Session(SEED, GATEWAY)
    sess.last_seen = now
    return sess


class Control(BaseModel):
    action: str | None = None
    speed: float | None = None
    inject_faults: bool | None = None
    club: str | None = None


class Approve(BaseModel):
    slots: dict[str, str] | None = None


class Reject(BaseModel):
    reason: str = "not for air"


class PackageReq(BaseModel):
    phase: str = "on_demand"


def _versioned_index() -> str:
    """Stamp asset URLs with a content hash so every deploy reaches browsers without a hard refresh."""
    digest = hashlib.sha256()
    for f in sorted(WEB.glob("*")):
        if f.is_file():
            digest.update(f.read_bytes())
    ver = digest.hexdigest()[:10]
    html = (WEB / "index.html").read_text()
    return re.sub(r'(/static/[\w.-]+\.(?:css|js))"', rf'\1?v={ver}"', html)


INDEX_HTML = _versioned_index()


@app.get("/")
async def index():
    return HTMLResponse(INDEX_HTML, headers={"Cache-Control": "no-cache"})


@app.get("/api/health")
async def health():
    return {"status": "ok", "model": GATEWAY.mode, "voice": f"azure-neural ({tts.VOICE})" if tts.enabled() else "browser",
            "sessions": len(SESSIONS), "synthetic_data_only": True}


class AskBody(BaseModel):
    question: str


@app.post("/api/ask")
async def ask(body: AskBody, sid: str = Query("default")):
    """Ask the Match: a fan question answered by a tool-using agent, fact-checked against the live match."""
    q = " ".join(body.question.split())[:300]
    if len(q) < 3:
        raise HTTPException(400, "Ask a question about the match.")
    return await get_session(sid).ask(q)


@app.post("/api/ask/{qid}/request")
async def fan_request(qid: str, sid: str = Query("default")):
    """Turn a verified fan answer into a graphic proposal in the producer's queue."""
    return await get_session(sid).fan_request(qid)


class SpeakBody(BaseModel):
    text: str
    level: int = 1
    narrator: bool = False


@app.post("/api/tts")
async def speak(body: SpeakBody):
    """Commentary line -> MP3 from Azure AI Speech, with an excitement-dependent speaking style."""
    if not tts.enabled():
        raise HTTPException(404, "neural voice not configured")
    try:
        audio = await tts.synthesize(body.text, body.level, body.narrator)
    except tts.TTSLimit as exc:
        raise HTTPException(429, str(exc)) from exc
    except Exception as exc:  # network or service error: the browser falls back to its own voice
        raise HTTPException(502, f"speech service error: {type(exc).__name__}") from exc
    return Response(audio, media_type="audio/mpeg", headers={"Cache-Control": "private, max-age=86400"})


@app.get("/api/state")
async def get_state(sid: str = Query("default")):
    return get_session(sid).full_state()


@app.post("/api/control")
async def control(body: Control, sid: str = Query("default")):
    session = get_session(sid)
    if body.speed:
        session.speed = max(1.0, min(body.speed, 240.0))
    if body.inject_faults is not None:
        session.inject_faults = body.inject_faults
    if body.club in (session.meta["home"], session.meta["away"]):
        session.club = body.club
    if body.action == "start":
        session.start()
    elif body.action == "pause":
        session.running = False
    elif body.action == "reset":
        session.reset()
        await session.broadcast("reset", session.full_state())
    await session.broadcast("status", session.status())
    return session.status()


@app.get("/api/stream")
async def stream(request: Request, sid: str = Query("default")):
    session = get_session(sid)
    q: asyncio.Queue = asyncio.Queue()
    session.clients.add(q)

    async def gen():
        try:
            yield "event: hello\ndata: {}\n\n"
            while True:
                if await request.is_disconnected():
                    break
                session.last_seen = time.monotonic()
                try:
                    yield await asyncio.wait_for(q.get(), timeout=15)
                except asyncio.TimeoutError:
                    yield ": keep-alive\n\n"
        finally:
            session.clients.discard(q)

    return StreamingResponse(gen(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


@app.post("/api/suggestions/{sug_id}/approve")
async def approve(sug_id: str, body: Approve | None = None, sid: str = Query("default")):
    return await get_session(sid).approve(sug_id, body.slots if body else None)


@app.post("/api/suggestions/{sug_id}/reject")
async def reject(sug_id: str, body: Reject | None = None, sid: str = Query("default")):
    return await get_session(sid).reject(sug_id, body.reason if body else "not for air")


@app.get("/api/overlays")
async def overlays(feed: str | None = None, sid: str = Query("default")):
    """Timed, machine-readable overlay cues for a downstream graphics engine."""
    session = get_session(sid)
    items = [o for o in session.overlays if feed is None or o["feed"] == feed]
    return {"match": {"seed": session.seed, "home": session.meta["home"], "away": session.meta["away"]},
            "clock": "match seconds", "overlays": items}


@app.get("/api/audit")
async def audit(sid: str = Query("default")):
    return get_session(sid).audit


@app.post("/api/package")
async def package(body: PackageReq, sid: str = Query("default")):
    return await get_session(sid).make_package(body.phase)
