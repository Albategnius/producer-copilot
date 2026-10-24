"""Neural commentator voice via Azure AI Speech (text to speech with speaking styles).

The browser sends a line of commentary and an excitement level; we wrap it in SSML with a
speaking style (chat / excited / shouting) and return MP3. Usage is capped so a public demo
cannot run up the bill: short lines only, a per-minute rate and a daily character budget.
"""
from __future__ import annotations

import hashlib
import os
import re
import time
from collections import OrderedDict, deque
from xml.sax.saxutils import escape

import httpx

KEY = os.getenv("SPEECH_KEY", "")
REGION = os.getenv("SPEECH_REGION", "")
VOICE = os.getenv("SPEECH_VOICE", "en-US-DavisNeural")
NARRATOR = os.getenv("SPEECH_NARRATOR_VOICE", "en-US-AndrewMultilingualNeural")  # calm voice for the demo tour
MAX_CHARS = 240
PER_MINUTE = int(os.getenv("TTS_PER_MINUTE", "90"))
DAILY_CHARS = int(os.getenv("TTS_DAILY_CHARS", "150000"))

# level -> (style, style degree, rate, pitch)
STYLES = {
    0: ("chat", 1.0, "+4%", "+0%"),        # colour commentary
    1: ("excited", 0.9, "+10%", "+2%"),    # play-by-play
    2: ("excited", 2.0, "+18%", "+10%"),   # big chance
    3: ("shouting", 2.0, "+14%", "+14%"),  # goal
}

_cache: OrderedDict[str, bytes] = OrderedDict()
_recent: deque[float] = deque()
_day = {"date": "", "chars": 0}


def enabled() -> bool:
    return bool(KEY and REGION)


def _body(text: str, level: int) -> str:
    _, _, rate, pitch = STYLES.get(level, STYLES[1])
    if level == 3 and text.upper().startswith(("GOAL", "IT'S IN", "GOOO")):
        # The goal call: three rising "GOAL!"s, a breath, then the scorer and score at full tilt.
        rest = re.sub(r"^(?:\s*(?:GO+A+L|It's in)!)+\s*", "", text, flags=re.I)
        calls = "".join(f'<prosody rate="{r}" pitch="{p}" volume="x-loud">GOAL!</prosody><break time="120ms"/>'
                        for r, p in (("-5%", "+12%"), ("-10%", "+22%"), ("-20%", "+32%")))
        return f'{calls}<break time="250ms"/><prosody rate="+18%" pitch="+16%" volume="x-loud">{escape(rest)}</prosody>'
    return f'<prosody rate="{rate}" pitch="{pitch}">{escape(text)}</prosody>'


def _narration_ssml(text: str) -> str:
    return ('<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="en-US">'
            f'<voice name="{NARRATOR}"><prosody rate="+6%">{escape(text)}</prosody></voice></speak>')


def _ssml(text: str, level: int) -> str:
    style, degree, _, _ = STYLES.get(level, STYLES[1])
    return ('<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" '
            'xmlns:mstts="https://www.w3.org/2001/mstts" xml:lang="en-US">'
            f'<voice name="{VOICE}"><mstts:express-as style="{style}" styledegree="{degree}">'
            f'{_body(text, level)}</mstts:express-as></voice></speak>')


class TTSLimit(Exception):
    pass


async def synthesize(text: str, level: int, narrator: bool = False) -> bytes:
    text = " ".join(str(text).split())[:MAX_CHARS]
    level = max(0, min(3, int(level)))
    key = hashlib.sha256(f"{NARRATOR if narrator else VOICE}|{level}|{narrator}|{text}".encode()).hexdigest()[:24]
    if key in _cache:
        _cache.move_to_end(key)
        return _cache[key]

    now = time.time()
    while _recent and now - _recent[0] > 60:
        _recent.popleft()
    today = time.strftime("%Y-%m-%d", time.gmtime(now))
    if _day["date"] != today:
        _day.update(date=today, chars=0)
    if len(_recent) >= PER_MINUTE or _day["chars"] + len(text) > DAILY_CHARS:
        raise TTSLimit("voice budget reached")
    _recent.append(now)
    _day["chars"] += len(text)

    async with httpx.AsyncClient(timeout=10) as client:
        r = await client.post(
            f"https://{REGION}.tts.speech.microsoft.com/cognitiveservices/v1",
            headers={"Ocp-Apim-Subscription-Key": KEY, "Content-Type": "application/ssml+xml",
                     "X-Microsoft-OutputFormat": "audio-24khz-48kbitrate-mono-mp3",
                     "User-Agent": "producer-copilot"},
            content=(_narration_ssml(text) if narrator else _ssml(text, level)).encode())
        r.raise_for_status()
    audio = r.content
    _cache[key] = audio
    if len(_cache) > 600:
        _cache.popitem(last=False)
    return audio
