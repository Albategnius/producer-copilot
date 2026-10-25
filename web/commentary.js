"use strict";

// TV-style commentator. Every line is built from the live synthetic events and computed stats,
// so it never invents a fact. Spoken by Sound.speak (Azure neural voice, or the browser's voice as fallback).
const Commentary = (() => {
  const P = { COLOUR: 0, PLAY: 1, BIG: 2, GOAL: 3 };
  let lastLine = 0, lastColour = 0, colourIdx = 0, lastCrowd = 0;
  const pick = (a) => a[Math.floor(Math.random() * a.length)];
  const now = () => performance.now();
  const surname = (n) => String(n || "").replace(/^[A-Z]\.\s*/, "");

  let ctx = null;  // { player(id), team(id), meta, stats(), speed() }
  function bind(c) { ctx = c; }

  function say(text, prio) {
    if (!Sound.enabled || !Sound.voice || !text) return;
    if (!ctx.running() && prio < P.GOAL) return;  // nothing new while paused (full-time call still plays)
    const busy = Sound.isSpeaking();
    // Play-by-play never talks over the commentator; big moments cut in like a real broadcast.
    if (busy && prio < P.BIG) return;
    const t = now();
    if (prio === P.PLAY && t - lastLine < 1600) return;
    lastLine = t;
    Sound.speak(text, { interrupt: prio >= P.BIG, level: prio });
  }

  const nm = (e, idKey = "player_id", nameKey = "player") => {
    const p = ctx.player(e[idKey]);
    return surname(p ? p.name : e[nameKey]);
  };
  const keeperOf = (teamId) => {
    const t = ctx.meta.teams.find((x) => x.id !== teamId);
    return surname(t?.players.find((p) => p.role === "GK")?.name || "the keeper");
  };
  const inFinalThird = (e) => {
    const x = e.end_x ?? e.x;
    if (x === undefined) return false;
    return e.team === ctx.meta.home ? x > 70 : x < 35;
  };
  const scoreLine = (sc) => {
    const h = ctx.team(ctx.meta.home), a = ctx.team(ctx.meta.away);
    return `${h.short} ${sc[h.id]}, ${a.short} ${sc[a.id]}`;
  };

  function onEvent(e) {
    if (!ctx) return;
    const tm = ctx.team(e.team);
    switch (e.type) {
      case "substitution":
        return say(pick([`Change for ${tm.short}: ${surname(e.player_off)} makes way, ${surname(e.player_on)} comes on.`,
          `${tm.short} make a substitution. ${surname(e.player_on)} on, ${surname(e.player_off)} off.`]), P.BIG);
      case "kickoff":
        return e.minute <= 1
          ? say(pick([`And we're under way here at ${ctx.meta.venue.replace(/ \(fictional\)/, "")}!`, "The referee blows, and we're off!"]), P.BIG)
          : say(pick([`${tm.short} get us going again.`, `${tm.short} restart.`]), P.PLAY);
      case "half_start":
        return e.period === 2 ? say("The second half is under way!", P.BIG) : null;
      case "half_end":
        return say(`That's half-time. ${scoreLine(ctx.stats().score)}.`, P.BIG);
      case "full_time":
        return say(`And there's the final whistle! It finishes ${scoreLine(ctx.stats().score)}.`, P.GOAL);
      case "goal": {
        const p = ctx.player(e.player_id);
        const sc = e.score || ctx.stats().score;
        return say(`${pick(["GOAL! GOAL! GOAL!", "It's in! It's in! GOAL!", "GOAL! Oh, what a finish!", "GOOOAL! Unbelievable!"])} ${p ? `Number ${p.number}, ` : ""}${nm(e)}! For ${tm.short}! ${scoreLine(sc)}!`, P.GOAL);
      }
      case "shot": {
        const who = nm(e);
        if (e.outcome === "goal") return say(pick([`${who} shoots...`, `${who}, has a go...`]), P.BIG);
        if (e.outcome === "saved") return say(pick([`${who} shoots! Saved by ${keeperOf(e.team)}!`, `${who}, on target, but ${keeperOf(e.team)} keeps it out!`]), P.BIG);
        if (e.outcome === "blocked") return say(pick([`${who} shoots, and it's blocked!`, `${who} lets fly, straight into a defender!`]), P.BIG);
        return say(pick([`${who} shoots... just wide!`, `${who} goes for goal... off target!`, `Chance for ${who}! But it's wide.`]), P.BIG);
      }
      case "foul":
        return say(pick([`Foul by ${nm(e)}. Free kick.`, `${nm(e)} goes in late, and the referee blows.`]), P.PLAY);
      case "tackle":
        return say(pick([`Good tackle from ${nm(e)}.`, `${nm(e)} wins it back for ${tm.short}.`, `Strong challenge, ${nm(e)}.`]), P.PLAY);
      case "possession_change":
        return e.reason === "interception" ? say(pick([`Intercepted by ${nm(e)}!`, `${nm(e)} reads it and steps in.`]), P.PLAY) : null;
      case "carry":
        if (inFinalThird(e)) { crowd(); return say(pick([`${nm(e)}, driving forward...`, `${nm(e)} into the final third...`]), P.PLAY); }
        return null;
      case "pass": {
        if (e.outcome === "incomplete") return Math.random() < 0.35 ? say(pick([`${nm(e)}... gives it away.`, `Loose from ${nm(e)}.`]), P.PLAY) : null;
        if ((e.difficulty || 0) >= 75) return say(pick([`Lovely ball from ${nm(e)}!`, `What a pass by ${nm(e)}, finds ${nm(e, "receiver_id", "receiver")}!`]), P.PLAY);
        if (inFinalThird(e)) { crowd(); return say(`${nm(e)}, to ${nm(e, "receiver_id", "receiver")}...`, P.PLAY); }
        return Math.random() < 0.3 ? say(pick([`${nm(e)}.`, `${nm(e)}, to ${nm(e, "receiver_id", "receiver")}.`, `${tm.short} keeping it, ${nm(e)}.`]), P.PLAY) : null;
      }
      default:
        return null;
    }
  }

  function crowd() {
    if (now() - lastCrowd > 2500) { lastCrowd = now(); Sound.swell(0.27, 0.4, 900); }
  }

  // Colour commentary in quiet spells, from stats computed in code.
  function tick() {
    if (!ctx || !Sound.enabled || !Sound.voice) return;
    const st = ctx.stats();
    if (!st || st.finished || !ctx.running()) return;
    if (Sound.isSpeaking() || now() - lastColour < 14000 || now() - lastLine < 3000) return;
    const h = ctx.team(ctx.meta.home), a = ctx.team(ctx.meta.away), th = st.totals[h.id], ta = st.totals[a.id];
    if (!th || !ta) return;
    const top = th.possession_pct >= ta.possession_pct ? [h, th] : [a, ta];
    const lines = [
      `${top[0].short} have had ${Math.round(top[1].possession_pct)} per cent of the ball so far.`,
      `Shots: ${h.short} ${th.shots}, ${a.short} ${ta.shots}.`,
      st.momentum === 0 ? "Very even, this one." : `${(st.momentum > 0 ? h : a).short} are on top at the moment.`,
      `${h.short} completing ${Math.round(th.pass_accuracy_pct)} per cent of their passes.`,
      `We're into the ${ordinal(st.minute)} minute. ${scoreLine(st.score)}.`,
    ];
    lastColour = now();
    say(lines[colourIdx++ % lines.length], P.COLOUR);
  }
  setInterval(tick, 2000);

  function ordinal(n) { const s = ["th", "st", "nd", "rd"], v = n % 100; return n + (s[(v - 20) % 10] || s[v] || s[0]); }

  function onAir(slots) {
    const text = Object.values(slots || {}).join(". ");
    setTimeout(() => say(`${pick(["Let's take a look at the numbers.", "On screen now.", "Here's the graphic."])} ${text}`, P.BIG), 600);
  }

  function onDecision(f) {
    if (!ctx || f.kind !== "missed_option") return;
    say(pick([`Oh, he's gone backwards there. ${surname(f.open_player)} was free ahead!`,
      `${surname(f.player)} plays it safe... ${surname(f.open_player)} wanted that one!`,
      `Back it goes. ${surname(f.open_player)} was calling for it in space!`]), P.PLAY);
  }

  return { bind, onEvent, onAir, onDecision };
})();
