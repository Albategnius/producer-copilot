"use strict";

const S = {
  meta: null, stats: null, status: null, templates: {}, feeds: {},
  suggestions: new Map(), overlays: [], events: [],
  feed: "main", editing: new Set(), expanded: new Set(), screenTimer: null, started: false,
  hoverLock: false, dirty: false,
  agentState: {}, players: new Map(), decisions: [], ghost: null,
};

const AGENTS = [
  { id: "MomentScout", role: "Spots moments worth a graphic, skips stale or repeated ones", kind: "Rules" },
  { id: "StatsAnalyst", role: "Explains why the moment matters right now", kind: "AI model" },
  { id: "GraphicsProducer", role: "Picks a template and writes the graphic", kind: "AI model" },
  { id: "FactChecker", role: "Checks every number and length; sends failures back", kind: "Code" },
  { id: "FeedAdapter", role: "Rewrites the approved graphic for TV, the fan app and the club channel", kind: "AI model" },
];
const FEED_LABEL = { main: "TV", casual: "Fan app", club: "Club channel" };

const $ = (id) => document.getElementById(id);
const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const team = (id) => S.meta.teams.find((t) => t.id === id);
const player = (id) => (id ? S.players.get(id) : null);
const shirt = (id, name) => { const p = player(id); return p ? `#${p.number} ${esc(p.name)}` : esc(name || ""); };
const clock = (t) => { const m = Math.floor(t / 60), s = Math.floor(t % 60); return `${m}:${String(s).padStart(2, "0")}`; };

// One console per browser tab, kept across reloads of that tab.
const SID = (() => {
  const make = () => (crypto.randomUUID ? crypto.randomUUID().replace(/-/g, "") : Math.random().toString(36).slice(2) + Date.now().toString(36));
  try {
    const old = sessionStorage.getItem("pc_sid");
    if (old) return old;
    const id = make();
    sessionStorage.setItem("pc_sid", id);
    return id;
  } catch (_) { return make(); }
})();
const withSid = (path) => `${path}${path.includes("?") ? "&" : "?"}sid=${SID}`;

async function api(path, body) {
  const res = await fetch(withSid(path), body === undefined ? {} : {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error("request failed"), { data, status: res.status });
  return data;
}

function toast(text, warn = false) {
  const el = document.createElement("div");
  el.className = "toast" + (warn ? " warn" : "");
  el.textContent = text;
  $("toasts").appendChild(el);
  while ($("toasts").children.length > 3) $("toasts").firstChild.remove();   // never bury the screen in toasts
  setTimeout(() => el.remove(), 4200);
}

// --- header -----------------------------------------------------------------------

function renderScorebug() {
  if (!S.meta || !S.stats) return;
  const h = team(S.meta.home), a = team(S.meta.away), sc = S.stats.score;
  const onBreak = !!S.status?.half_time_break;
  const clk = S.stats.finished ? "FT" : onBreak ? "HT" : S.started || S.stats.t > 0 ? `${S.stats.period === 2 ? "2H" : "1H"} ${clock(S.stats.t)}` : "KO";
  $("scorebug").innerHTML = `
    <span class="sw" style="background:${h.color}"></span><span class="t">${esc(h.short)}</span>
    <span class="sc">${sc[h.id]}–${sc[a.id]}</span>
    <span class="t">${esc(a.short)}</span><span class="sw" style="background:${a.color}"></span>
    <span class="clk">${clk}</span>`;
  $("screen-bug").textContent = `${h.id} ${sc[h.id]}-${sc[a.id]} ${a.id}  ${clk}`;
  $("timeline-fill").style.width = `${Math.min(100, (S.stats.t / (94 * 60)) * 100)}%`;
}

// GOAL! pop-up over the pitch while play stops for the celebration.
function showGoalPop(e) {
  const t = team(e.team), p = player(e.player_id), h = team(S.meta.home), a = team(S.meta.away), sc = e.score || S.stats.score;
  const el = $("goal-pop");
  el.style.setProperty("--teamc", t.color);
  el.innerHTML = `<div class="gp-burst">GOAL!</div>
    <div class="gp-who">${p ? `<span class="num">${p.number}</span>` : ""}${esc(e.player)} <span class="muted">${esc(t.short)} · ${e.minute}'</span></div>
    <div class="gp-score">${esc(h.short)} <b>${sc[h.id]}–${sc[a.id]}</b> ${esc(a.short)}</div>`;
  el.hidden = false;
  el.classList.remove("pop"); void el.offsetWidth; el.classList.add("pop");
  clearTimeout(S.goalTimer);
  S.goalTimer = setTimeout(() => { el.hidden = true; }, 6000);   // safety: the status update normally hides it first
}

// Half-time and full-time cards over the pitch, like the studio break.
function renderBreak() {
  if (!S.meta || !S.stats) return;
  const fin = S.stats.finished, ht = !!S.status?.half_time_break;
  const el = $("break-card");
  if (!fin && !ht) { el.hidden = true; return; }
  const h = team(S.meta.home), a = team(S.meta.away), sc = S.stats.score, th = S.stats.totals[h.id], ta = S.stats.totals[a.id];
  const row = (label, x, y) => `<div class="br-row"><b>${x}</b><span>${label}</span><b>${y}</b></div>`;
  el.innerHTML = `<div class="br-kicker">${fin ? "Full-time" : "Half-time"}</div>
    <div class="br-score"><span>${esc(h.short)}</span><strong>${sc[h.id]}–${sc[a.id]}</strong><span>${esc(a.short)}</span></div>
    ${row("Possession %", Math.round(th.possession_pct), Math.round(ta.possession_pct))}
    ${row("Shots", th.shots, ta.shots)}${row("xG (simulated)", th.xg, ta.xg)}${row("Pass accuracy %", Math.round(th.pass_accuracy_pct), Math.round(ta.pass_accuracy_pct))}
    ${S.stats.motm ? `<div class="br-motm">${fin ? "★ Man of the Match" : "Best player so far"}: <b>#${S.stats.motm.number} ${esc(S.stats.motm.player)}</b> (${esc(team(S.stats.motm.team).short)}) · ${S.stats.motm.rating.toFixed(1)} · ${esc(S.stats.motm.why)}</div>` : ""}
    <div class="br-foot">${fin ? "The studio rundown is in the Studio package tab." : "Second half starts shortly. The half-time rundown is in the Studio package tab."}</div>`;
  el.hidden = false;
}

function renderStatus() {
  const st = S.status;
  if (!st) return;
  document.querySelectorAll("[data-speed]").forEach((b) => b.setAttribute("aria-pressed", String(Number(b.dataset.speed) === st.speed)));
  $("faults").checked = st.inject_faults;
  $("club").value = st.club;
  const live = st.mode.startsWith("live");
  $("model-badge").textContent = live
    ? `AI model: ${st.mode.replace(/^live \(|\)$/g, "")}. Every reply is still fact-checked.`
    : "AI model not connected: agents use cached replies and verified templates, so the desk keeps working.";
  const label = st.finished ? "Full time" : st.running ? "Pause" : (S.started ? "Resume" : "Start match");
  $("play-label").textContent = label;
  $("play-ico").setAttribute("d", st.running ? "M7 5h4v14H7zM13 5h4v14h-4z" : "M8 5v14l11-7z");
  $("btn-play").disabled = st.finished;
  document.querySelector(".tally-dot").classList.toggle("live", st.running);
  Sound.setRunning(st.running, st.finished);
}

// --- pitch + stats --------------------------------------------------------------

function pitchLines() {
  return `<defs>
    <pattern id="mow" width="17.5" height="76" patternUnits="userSpaceOnUse" x="0">
      <rect width="8.75" height="76" fill="#2c7a45"/><rect x="8.75" width="8.75" height="76" fill="#256b3c"/></pattern>
    <radialGradient id="flood" cx="50%" cy="35%" r="75%"><stop offset="0" stop-color="#fff" stop-opacity=".16"/>
      <stop offset=".6" stop-color="#fff" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity=".45"/></radialGradient>
    <filter id="glow" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation=".8" result="b"/>
      <feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
    <filter id="shade" x="-50%" y="-50%" width="200%" height="200%"><feDropShadow dx=".25" dy=".55" stdDeviation=".35" flood-color="#000" flood-opacity=".55"/></filter>
  </defs>
  <rect x="-4" y="-4" width="113" height="76" rx="1.5" fill="url(#mow)"/>
  <rect x="-4" y="-4" width="113" height="76" rx="1.5" fill="url(#flood)"/>
  <g fill="none" stroke="rgba(255,255,255,.78)" stroke-width=".4">
    <rect x="0" y="0" width="105" height="68"/><line x1="52.5" y1="0" x2="52.5" y2="68"/>
    <circle cx="52.5" cy="34" r="9.15"/><rect x="0" y="13.84" width="16.5" height="40.32"/>
    <rect x="88.5" y="13.84" width="16.5" height="40.32"/><rect x="0" y="24.84" width="5.5" height="18.32"/>
    <rect x="99.5" y="24.84" width="5.5" height="18.32"/></g>`;
}

function renderPitch() {
  const pts = S.events.filter((e) => e.x !== undefined).slice(-10);
  let marks = "";
  const token = (x, y, id, c, o, big) => {
    const p = player(id), k = $("monitor").classList.contains("view-3d") ? 1.35 : 1, r = (big ? 2.1 : 1.75) * k;
    return `<g opacity="${o}" filter="url(#shade)"><circle cx="${x}" cy="${y}" r="${r}" fill="${c}" stroke="#fff" stroke-opacity=".8" stroke-width=".3"/>${p
      ? `<text x="${x}" y="${y + 0.62 * k}" text-anchor="middle" font-size="${(p.number > 9 ? 1.65 : 1.85) * k}" font-weight="800" fill="#fff">${p.number}</text>` : ""}</g>`;
  };
  pts.forEach((e, i) => {
    const c = team(e.team)?.color || "#fff", o = (0.25 + 0.75 * (i / Math.max(1, pts.length - 1))).toFixed(2);
    if (e.type === "pass" || e.type === "carry") {
      marks += `<line x1="${e.x}" y1="${e.y}" x2="${e.end_x}" y2="${e.end_y}" stroke="${c}" stroke-width=".7" opacity="${o}" stroke-linecap="round" filter="url(#glow)" ${e.outcome === "incomplete" ? 'stroke-dasharray="1.5 1"' : ""}/>`;
    }
  });
  pts.forEach((e, i) => {
    const c = team(e.team)?.color || "#fff", o = (0.25 + 0.75 * (i / Math.max(1, pts.length - 1))).toFixed(2);
    marks += token(e.x, e.y, e.player_id, c, o, e.type === "shot" || e.type === "goal");
  });
  const last = pts[pts.length - 1];
  let now = "";
  if (last) {
    const c = team(last.team)?.color || "#fff";
    const passed = last.end_x !== undefined && last.outcome === "complete" && last.receiver_id;
    if (passed) marks += token(last.end_x, last.end_y, last.receiver_id, c, 1, false);
    const bx = last.end_x !== undefined && last.outcome !== "incomplete" ? last.end_x : last.x;
    const by = last.end_y !== undefined && last.outcome !== "incomplete" ? last.end_y : last.y;
    marks += `<circle class="pulse" cx="${bx}" cy="${by}" r="2.4" fill="none" stroke="#fff" stroke-width=".3"/>`;
    marks += `<circle cx="${bx + 1.6}" cy="${by - 1.6}" r=".95" fill="#fff" filter="url(#glow)"/>`;
    const verb = { pass: passed ? "→" : "pass lost", carry: "carries", shot: "shoots", goal: "scores", tackle: "tackles", foul: "fouls",
      possession_change: "wins the ball", kickoff: "kicks off", pressure: "presses" }[last.type] || "";
    now = `<span class="sw" style="background:${c}"></span><b>${shirt(last.player_id, last.player)}</b> ${esc(verb)}${passed ? ` <b>${shirt(last.receiver_id, last.receiver)}</b>` : ""}`;
  }
  const g = S.ghost;
  if (g && g.until > performance.now()) {
    // Decision Lens: the forward option the passer did not take (estimated position).
    const c = "#FFB547";
    marks += `<line x1="${g.from_x}" y1="${g.from_y}" x2="${g.open_x}" y2="${g.open_y}" stroke="${c}" stroke-width=".6" stroke-dasharray="1.6 1" filter="url(#glow)"/>
      <circle cx="${g.open_x}" cy="${g.open_y}" r="2.4" fill="none" stroke="${c}" stroke-width=".45" stroke-dasharray="1 .6"/>
      <text x="${g.open_x}" y="${g.open_y + 0.7}" text-anchor="middle" font-size="2" font-weight="800" fill="${c}">${g.open_number}</text>
      <text x="${g.open_x}" y="${g.open_y - 3.4}" text-anchor="middle" font-size="1.9" font-weight="700" fill="${c}">open?</text>`;
  }
  $("pitch").innerHTML = pitchLines() + marks;
  $("ball-now").innerHTML = now;
  $("ball-now").hidden = !now;
}

function renderStats() {
  if (!S.stats) return;
  const h = team(S.meta.home), a = team(S.meta.away), m = S.stats.momentum;
  $("momentum").innerHTML = `
    <div class="bar"><div class="fill" style="${m >= 0 ? `right:50%;width:${m / 2}%;background:${h.color}` : `left:50%;width:${-m / 2}%;background:${a.color}`}"></div></div>
    <div class="labels"><span>${esc(h.short)}</span><span>${m === 0 ? "Even" : `${esc((m > 0 ? h : a).short)} on top`} · momentum ${Math.abs(m)}</span><span>${esc(a.short)}</span></div>`;
  const th = S.stats.totals[h.id], ta = S.stats.totals[a.id];
  const rows = [["Possession %", "possession_pct"], ["Shots", "shots"], ["On target", "shots_on_target"], ["xG (simulated)", "xg"],
    ["Passes", "passes"], ["Pass accuracy %", "pass_accuracy_pct"], ["Tackles", "tackles"]];
  $("statbars").innerHTML = rows.map(([name, k]) => {
    const x = th[k], y = ta[k], tot = (x + y) || 1;
    return `<div class="row"><span class="v">${x}</span><div class="mid"><div class="name">${name}</div>
      <div class="split"><div style="width:${100 * x / tot}%;background:${h.color}"></div><div style="width:${100 * y / tot}%;background:${a.color}"></div></div></div>
      <span class="v r">${y}</span></div>`;
  }).join("");
}

function renderLineups() {
  const subs = S.stats?.subs || [];
  const rating = new Map((S.stats?.ratings || []).map((r) => [r.player_id, r]));
  const offAt = new Map(subs.map((x) => [x.off_id, x.minute])), onAt = new Map(subs.map((x) => [x.on_id, x.minute]));
  const row = (p, t) => {
    const r = rating.get(p.id), off = offAt.get(p.id), on = onAt.get(p.id), unused = p.bench && !on;
    const motm = S.stats?.motm?.player_id === p.id;
    return `<li class="${unused ? "unused" : ""}${off ? " subbed" : ""}"><span class="num" style="--teamc:${t.color}">${p.number}</span>
      <span>${esc(p.name)}${motm ? ' <span class="motm-star" title="Man of the Match">★</span>' : ""}
        ${off ? `<span class="subtag off">▼ ${off}'</span>` : ""}${on ? `<span class="subtag on">▲ ${on}'</span>` : ""}</span>
      <span class="muted small">${unused ? "bench" : esc(p.role)}${r ? ` · <b class="rt">${r.rating.toFixed(1)}</b>` : ""}</span></li>`;
  };
  $("lineups").innerHTML = S.meta.teams.map((t) => `<div class="lineup"><h3><span class="sw" style="background:${t.color}"></span>${esc(t.name)}</h3>
    <ol>${t.players.filter((p) => !p.bench).map((p) => row(p, t)).join("")}</ol>
    <h4>Substitutes</h4><ol class="bench">${t.players.filter((p) => p.bench).map((p) => row(p, t)).join("")}</ol></div>`).join("");
}

// --- Decision Lens -------------------------------------------------------------

function lensLine(f) {
  return f.kind === "missed_option"
    ? `<b>#${f.number} ${esc(f.player)}</b> played back to ${esc(f.receiver || "a teammate")} while <b>#${f.open_number} ${esc(f.open_player)}</b> looked free ahead`
    : `<b>#${f.number} ${esc(f.player)}</b> picked the brave option: forward to ${esc(f.receiver || "a teammate")}`;
}

function renderMotm() {
  const m = S.stats?.motm, box = $("motm-box");
  if (!m) { box.innerHTML = `<p class="muted small">Man of the Match appears once players have played 20 minutes.</p>`; return; }
  const t = team(m.team), final = m.final;
  const comp = Object.entries(m.components).map(([k, v]) => `<span class="${v >= 0 ? "pos" : "neg"}">${esc(k.replace(/_/g, " "))} ${v >= 0 ? "+" : ""}${v.toFixed(2)}</span>`).join("");
  const top = (S.stats.ratings || []).slice(0, 5).map((r) => { const p = player(r.player_id); const tt = team(p.team);
    return `<li><span class="num" style="--teamc:${tt.color}">${p.number}</span><span>${esc(p.name)}</span><span class="muted small">vision ${r.vision_score_pct ?? "–"}%</span><b>${r.rating.toFixed(1)}</b></li>`; }).join("");
  box.innerHTML = `<div class="motm-card" style="--teamc:${t.color}">
      <div class="motm-kicker">${final ? "★ Man of the Match" : "Man of the Match race · leader"}</div>
      <div class="motm-name"><span class="num">${m.number}</span>${esc(m.player)} <span class="muted">${esc(t.short)}</span><b>${m.rating.toFixed(1)}</b></div>
      <p class="motm-why">${esc(m.why)}</p>
      <div class="motm-comp" title="Rating = 6.0 + these components">${comp}</div>
    </div>
    <h4>Top ratings</h4><ol class="rating-list">${top}</ol>
    <p class="muted small">Ratings start at 6.0; the Decision Lens component uses the same vision score, brave passes and missed options shown here, so the two always agree.</p>`;
}

function renderLens() {
  renderMotm();
  const flags = S.decisions.slice(-14).reverse();
  if (flags.length) {
    $("lens-flags").innerHTML = flags.map((f) => `<li class="lf ${f.kind}"><span class="m">${f.minute}'</span>
      <span>${lensLine(f)} <span class="q">decision quality ${f.decision_quality_pct}%</span></span></li>`).join("");
  }
  const board = S.stats?.vision || [];
  if (board.length) {
    const row = (r) => `<li><span class="num" style="--teamc:${team(r.team).color}">${r.number}</span><span>${esc(r.player)}</span>
      <span class="bar"><span style="width:${r.vision_score_pct}%;background:${team(r.team).color}"></span></span><b>${r.vision_score_pct}%</b></li>`;
    $("vision-board").innerHTML = `<p class="muted small">Average decision quality per pass (best option = 100%).</p>
      <h4>Best decision makers</h4><ol>${board.slice(0, 5).map(row).join("")}</ol>
      <h4>Most conservative</h4><ol>${board.slice(-3).reverse().map(row).join("")}</ol>`;
  }
}

function onDecision(f) {
  S.decisions.push(f); if (S.decisions.length > 80) S.decisions.shift();
  if (f.kind === "missed_option") {
    S.ghost = { ...f, until: performance.now() + 6000 };
    setTimeout(renderPitch, 6100);
    renderPitch();
    const li = document.createElement("li");
    li.className = "lens";
    li.innerHTML = `<span class="m">${f.minute}'</span><span>Decision Lens: ${lensLine(f)}</span>`;
    $("ticker").prepend(li);
  }
  Commentary.onDecision(f);
  renderLens();
}

function tickerLine(e) {
  const who = e.player ? shirt(e.player_id, e.player) : "";
  const tm = e.team ? esc(team(e.team).short) : "";
  switch (e.type) {
    case "goal": return ["goal", `Goal ${tm} — ${who}`];
    case "shot": return ["", `Shot (${e.outcome.replace("_", " ")}) by ${who}, xG ${e.xg}`];
    case "tackle": return ["", `Tackle won by ${who} (${tm})`];
    case "foul": return ["", `Foul by ${who} (${tm})`];
    case "kickoff": return ["", `Kick-off ${tm}`];
    case "substitution": return ["sub", `🔁 ${tm}: ${shirt(e.player_off_id, e.player_off)} off · ${shirt(e.player_on_id, e.player_on)} on`];
    case "half_start": return ["goal", `Period ${e.period} starts`];
    case "half_end": return ["goal", "Half-time"];
    case "full_time": return ["goal", "Full-time"];
    case "possession_change": return e.reason === "interception" ? ["", `Interception by ${who} (${tm})`] : null;
    case "pass": return e.difficulty >= 75 && e.outcome === "complete" ? ["", `Difficult pass by ${who} (${e.difficulty}/100)`] : null;
    default: return null;
  }
}

function addTicker(e) {
  const line = tickerLine(e);
  if (!line) return;
  const li = document.createElement("li");
  li.className = line[0];
  li.innerHTML = `<span class="m">${e.minute}'</span><span>${line[1]}</span>`;
  $("ticker").prepend(li);
  while ($("ticker").children.length > 120) $("ticker").lastChild.remove();
}

// --- graphics ---------------------------------------------------------------------

function gfxHTML(tpl, slots, data) {
  const s = Object.fromEntries(Object.entries(slots || {}).map(([k, v]) => [k, esc(v)]));
  const color = data?.team ? team(data.team)?.color : "#4a5675";
  const style = `style="--teamc:${color}"`;
  const h = team(S.meta.home), a = team(S.meta.away);
  switch (tpl) {
    case "lower_third":
      return `<div class="gfx lower_third" ${style}><div class="hl">${s.headline}</div><div class="bd">${s.body}</div></div>`;
    case "player_tag":
      return `<div class="gfx player_tag" ${style}><div class="hl">${s.player}</div>
        <div class="bd"><div class="kv"><span>${s.stat_label}</span><span class="big">${s.stat_value}</span></div>${s.context}</div></div>`;
    case "pass_card":
      return `<div class="gfx pass_card" ${style}><div class="hl">${s.player}</div>
        <div class="bd"><div class="kv"><span>Distance <b class="big">${s.distance}</b></span><span title="Pass difficulty, 0-100, computed in code: up to 40 for length, 25 if under pressure, 15 for forward progress, up to 20 for reaching the final third or the box">Difficulty <b class="big">${s.difficulty}</b></span></div>${s.caption}</div></div>`;
    case "momentum_bar": {
      const m = data?.momentum ?? 0, left = 50 + m / 2;
      return `<div class="gfx momentum_bar" ${style}><div class="hl">${s.headline}</div><div class="bd">
        <div class="kv"><span>${esc(h.short)}</span><span>${esc(a.short)}</span></div>
        <div class="mbar"><div style="width:${left}%;background:${h.color}"></div><div style="width:${100 - left}%;background:${a.color}"></div></div>${s.caption}</div></div>`;
    }
    case "comparison":
      return `<div class="gfx comparison" ${style}><div class="hl">${s.metric}</div><div class="bd">
        <div class="cmp"><span class="big">${s.home_value}</span><span>${esc(h.short)} v ${esc(a.short)}</span><span class="big">${s.away_value}</span></div>${s.caption}</div></div>`;
    default:
      return `<div class="gfx"><div class="bd">${esc(Object.values(slots || {}).join(" · "))}</div></div>`;
  }
}

function feedNote(ov) {
  const label = FEED_LABEL[ov.feed] || ov.feed;
  const sug = S.suggestions.get(ov.suggestion_id);
  const f = sug?.feeds?.[ov.feed];
  if (f?.pending) return `${label}: FeedAdapter is rewriting this for the ${label.toLowerCase()} audience; the TV text is shown meanwhile.`;
  if (f?.rewritten?.length) return `${label} version written by FeedAdapter${f.blocked?.length ? `; ${f.blocked.length} line(s) kept from TV after the Fact Checker blocked the rewrite` : ""}.`;
  if (ov.feed === "main") return "TV version: the graphic exactly as you approved it.";
  return `${label} shows the TV text: ${String(ov.content_source || "").includes("fallback") ? "the AI rewrite was unavailable" : "the rewrite did not pass the Fact Checker"}.`;
}

// Each feed has its own look so the three outputs are told apart at a glance.
function skinned(ov) {
  const club = team(S.status?.club || S.meta.home);
  const data = ov.feed === "club" ? { ...ov.data, team: club.id } : ov.data;
  const label = ov.feed === "club" ? `${esc(club.short)} TV · club channel` : ov.feed === "casual" ? "Fan app" : "TV · main broadcast";
  return `<div class="skin skin-${ov.feed}" style="--clubc:${club.color}"><span class="skin-label">${label}</span>${gfxHTML(ov.template, ov.slots, data)}</div>`;
}

function renderCompare(sugId) {
  const ovs = ["main", "casual", "club"].map((f) => S.overlays.find((o) => o.suggestion_id === sugId && o.feed === f)).filter(Boolean);
  if (!ovs.length) return;
  const sug = S.suggestions.get(sugId);
  $("feed-compare").innerHTML = `<h3>Feed versions <span class="muted small">${esc(sug?.candidate?.title || "")}</span></h3><div class="fc-grid">${
    ovs.map((o) => {
      const f = sug?.feeds?.[o.feed];
      const note = o.feed === "main" ? "Exactly as you approved" : f?.pending ? "FeedAdapter writing…"
        : f?.rewritten?.length ? `Rewritten by FeedAdapter${f.blocked?.length ? ` · ${f.blocked.length} line kept (Fact Checker)` : ""}` : "Same as TV (rewrite unavailable)";
      return `<div class="fc fc-${o.feed}${o.feed === S.feed ? " current" : ""}"><div class="fc-head">${FEED_LABEL[o.feed]}</div>
        ${Object.values(o.slots || {}).map((v, i) => `<p class="${i === 0 ? "fc-hl" : ""}">${esc(v)}</p>`).join("")}
        <div class="fc-note${f?.pending ? " pending" : ""}">${note}</div></div>`;
    }).join("")}</div>`;
  $("feed-compare").hidden = false;
}

function showOnAir(ov, inPlace = false) {
  $("screen-gfx").innerHTML = skinned(ov);
  renderCompare(ov.suggestion_id);
  $("feed-desc").textContent = `${S.feeds[ov.feed] || ""} ${feedNote(ov)}`;
  S.onScreen = ov.suggestion_id;
  if (inPlace) return;
  $("onair").hidden = false; $("strip-empty").hidden = true; $("onair-strip").classList.add("live");
  clearTimeout(S.screenTimer);
  S.screenTimer = setTimeout(() => {
    S.onScreen = null;
    $("feed-desc").textContent = S.feeds[S.feed] || "";
    $("screen-gfx").innerHTML = ""; $("onair").hidden = true; $("strip-empty").hidden = false; $("onair-strip").classList.remove("live");
  }, ov.duration_s * 1000);
}

function renderFeedTabs() {
  $("feed-tabs").innerHTML = Object.keys(S.feeds).map((f) =>
    `<button type="button" role="tab" aria-selected="${f === S.feed}" data-feed="${f}">${FEED_LABEL[f] || f}</button>`).join("");
  $("feed-desc").textContent = S.feeds[S.feed] || "";
}

// --- agent pipeline ---------------------------------------------------------------

function renderPipeline() {
  $("pipeline").innerHTML = AGENTS.map((a) => {
    const st = S.agentState[a.id];
    const cls = st ? st.cls : "";
    const label = st ? st.label : "Idle";
    return `<li class="${cls}"><span class="kind">${a.kind}</span><span class="name">${a.id}</span>
      <span class="role">${a.role}</span><span class="state">${esc(label)}</span></li>`;
  }).join("");
}

function setAgent(id, cls, label) {
  S.agentState[id] = { cls, label };
  renderPipeline();
}

function onTrace(t) {
  const failed = t.ok === false;
  for (const a of AGENTS) if (S.agentState[a.id]?.cls === "active") S.agentState[a.id] = { cls: "", label: "Done" };
  setAgent(t.agent, failed ? "fail" : t.ok === true ? "pass" : "active",
    failed ? "Rejected a draft" : t.ok === true ? "Passed" : "Working");
  const sug = S.suggestions.get(t.id);
  $("agents-status").textContent = sug ? `On ${sug.candidate.minute}' ${sug.candidate.title}` : "";
}

// --- decision queue ---------------------------------------------------------------

const CHECK = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 16.2 4.8 12l-1.4 1.4L9 19 21 7l-1.4-1.4z" fill="currentColor"/></svg>';

function verifyHTML(sug) {
  const fails = (sug.trace || []).filter((t) => t.agent === "FactChecker" && t.ok === false).length;
  if (!sug.trace?.some((t) => t.agent === "FactChecker")) return "";
  return fails
    ? `<div class="verify repaired">${CHECK}Fact Checker rejected ${fails} draft${fails > 1 ? "s" : ""}; the repaired version passed every check.</div>`
    : `<div class="verify">${CHECK}Every number checked against the match data.</div>`;
}

function traceHTML(trace) {
  return `<ol class="trace">${trace.map((t) => {
    const mark = t.ok === true ? '<span class="ok">Pass</span> ' : t.ok === false ? '<span class="no">Fail</span> ' : "";
    const src = t.source ? ` <span class="src">(${esc(t.source)})</span>` : "";
    return `<li><span class="agent">${esc(t.agent)}</span><span>${mark}${esc(t.detail)}${src}</span></li>`;
  }).join("")}</ol>`;
}

function topPendingId() {
  const p = [...S.suggestions.values()].filter((s) => s.status === "pending")
    .sort((x, y) => y.candidate.priority - x.candidate.priority || y.candidate.t - x.candidate.t);
  return p[0]?.id;
}

function fullCard(sug, isTop) {
  const c = sug.candidate;
  let html = `<div class="card-head"><span class="min">${c.minute}'</span><span class="title">${titleOf(c)}</span>
    <span class="chip">${esc(c.kind.replace(/_/g, " "))}</span></div>`;
  if (sug.analysis) html += `<p class="why"><b>Why now:</b> ${esc(sug.analysis.why_now)}</p>`;
  if (sug.graphic) html += gfxHTML(sug.graphic.template, sug.graphic.slots, { team: c.team, momentum: (c.facts.momentum_now || 0) * (c.team === S.meta.home ? 1 : -1) });
  html += verifyHTML(sug);
  if (S.editing.has(sug.id)) {
    const limits = S.templates[sug.graphic.template].slots;
    html += `<form class="edit-form" data-id="${sug.id}">${Object.entries(limits).map(([k, lim]) =>
      `<label>${esc(k.replace(/_/g, " "))} <span class="muted">(max ${lim} characters)</span><input type="text" name="${k}" maxlength="${lim + 20}" value="${esc(sug.graphic.slots[k] || "")}"></label>`).join("")}
      <div class="edit-issues" aria-live="polite"></div>
      <div class="actions"><button class="btn approve" type="submit">✓ Check and approve</button>
      <button class="btn ghost" type="button" data-act="cancel" data-id="${sug.id}">Cancel</button></div></form>`;
  } else {
    html += `<div class="actions"><button class="btn approve" type="button" data-act="approve" data-id="${sug.id}" title="Approve and put it on air in all 3 feeds">✓ Approve${isTop ? " <kbd>A</kbd>" : ""}</button>
      <button class="btn" type="button" data-act="edit" data-id="${sug.id}">Edit</button>
      <button class="btn danger" type="button" data-act="reject" data-id="${sug.id}">Reject${isTop ? " <kbd>R</kbd>" : ""}</button></div>`;
  }
  if (sug.trace?.length) html += `<details><summary>How the agents got here (${sug.trace.length} steps${sug.attempts > 1 ? `, ${sug.attempts} drafts` : ""})</summary>${traceHTML(sug.trace)}</details>`;
  html += `<div class="sources">Source events ${c.source_event_ids.slice(0, 6).map((i) => `<code>${esc(i)}</code>`).join("")}${c.source_event_ids.length > 6 ? ` +${c.source_event_ids.length - 6}` : ""}</div>`;
  return html;
}

const titleOf = (c) => (c.kind === "fan_request" ? "📣 " : c.kind === "missed_option" ? "🔍 " : "") + esc(c.title);

function compactCard(sug) {
  const c = sug.candidate;
  return `<div class="card-head"><span class="min">${c.minute}'</span><span class="title">${titleOf(c)}</span>
    <span class="chip status-pending">Waiting</span></div>`;
}

function workingCard(sug) {
  const c = sug.candidate;
  const last = sug.trace?.[sug.trace.length - 1];
  const label = sug.status === "adapting" ? "FeedAdapter writing 3 feeds" : sug.status === "queued" ? "Queued for the agents" : `${last?.agent || "Agents"} working`;
  return `<div class="card-head"><span class="spinner" aria-hidden="true"></span><span class="min">${c.minute}'</span>
    <span class="title">${esc(c.title)}</span><span class="chip status-${sug.status}">${esc(label)}</span></div>`;
}

function renderQueue(force = false) {
  const all = [...S.suggestions.values()];
  const pending = all.filter((s) => s.status === "pending")
    .sort((x, y) => y.candidate.priority - x.candidate.priority || y.candidate.t - x.candidate.t);
  const working = all.filter((s) => ["queued", "drafting", "adapting"].includes(s.status)).sort((x, y) => y.candidate.t - x.candidate.t);
  const done = all.filter((s) => ["approved", "rejected", "dropped"].includes(s.status)).sort((x, y) => y.candidate.t - x.candidate.t);
  const top = pending[0]?.id;

  const typing = S.editing.size && document.querySelector(".edit-form") && !force;
  if (typing || (S.hoverLock && !force)) {
    // Never move cards under the producer's pointer or while they type: rebuild on mouse-leave.
    S.dirty = true;
  } else {
    S.dirty = false;
    const parts = pending.map((s) => {
      const open = s.id === top || S.expanded.has(s.id) || S.editing.has(s.id);
      return `<article class="card pending${s.id === top ? " top" : ""}${open ? "" : " compact"}" data-id="${s.id}" ${open ? "" : `data-expand="${s.id}" tabindex="0" role="button" aria-label="Open ${esc(s.candidate.title)}"`}>
        ${open ? fullCard(s, s.id === top) : compactCard(s)}</article>`;
    });
    parts.push(...working.slice(0, 4).map((s) => `<article class="card ${s.status}" data-id="${s.id}">${workingCard(s)}</article>`));
    $("queue").innerHTML = parts.join("");
  }
  const n = pending.length;
  $("pending-count").textContent = n;
  $("pending-count").classList.toggle("hot", n > 0);
  $("welcome").hidden = S.started || all.length > 0;

  $("history-count").textContent = done.length;
  $("history").innerHTML = done.map((s) => {
    const expired = s.status === "dropped" && (s.dropped_reason || "").startsWith("expired");
    const label = s.status === "approved" ? "Aired" : s.status === "rejected" ? "Rejected" : expired ? "Expired" : "Skipped";
    const detail = expired ? s.dropped_reason.replace(/^expired: /, "") : s.status === "dropped" ? `MomentScout: ${s.dropped_reason || ""}` : (s.feeds ? `${Object.keys(s.feeds).length} feeds` : (s.reject_reason || ""));
    return `<div class="history-row"><span class="muted">${s.candidate.minute}'</span><span>${esc(s.candidate.title)} <span class="muted small">${esc(detail)}</span></span>
      <span class="chip status-${s.status}">${label}</span></div>`;
  }).join("");
}

function upsert(sug) {
  const prev = S.suggestions.get(sug.id);
  S.suggestions.set(sug.id, sug);
  if (prev && prev.status !== "approved" && sug.status === "approved") {
    toast(`On air: “${sug.candidate.title}” in ${Object.keys(sug.feeds || {}).length || 3} feeds`);
    setAgent("FeedAdapter", "pass", "Wrote 3 feeds");
  }
  if (sug.status === "adapting" || sug.feeds_pending) setAgent("FeedAdapter", "active", "Writing fan app + club");
  if (prev?.feeds_pending && !sug.feeds_pending) setAgent("FeedAdapter", "pass", "Wrote 3 feeds");
  renderQueue();
}

// --- right column extras ------------------------------------------------------------

function addAudit(entry) {
  const li = document.createElement("li");
  li.innerHTML = `<span class="who ${esc(entry.actor)}">${esc(entry.actor === "producer" ? "You" : "Agents")}</span> ${esc(entry.action.replace(/_/g, " "))}
    ${entry.suggestion_id ? `<code>${esc(entry.suggestion_id)}</code>` : ""} <span class="muted">· ${entry.match_minute}' · ${esc(entry.at.slice(11, 19))} UTC</span>
    <div class="muted">${esc(entry.details)}</div>`;
  $("audit").prepend(li);
}

function renderPackage(pkg) {
  const items = (pkg.rundown || []).map((r) => {
    const sug = S.suggestions.get(r.id);
    return `<li><b>${sug ? `${sug.candidate.minute}' ${esc(sug.candidate.title)}` : esc(r.id)}</b> — ${esc(r.why)}</li>`;
  }).join("");
  $("package").innerHTML = `<div class="headline">${esc(pkg.headline)}</div>
    <div class="muted small">${esc(pkg.phase.replace(/_/g, " "))} · written by ${esc(pkg.source)}</div>
    <ol>${items || "<li class='muted'>No approved graphics yet.</li>"}</ol>
    <div class="script">${esc(pkg.script)}</div>`;
}

// --- boot ---------------------------------------------------------------------------

function loadFull(state) {
  Object.assign(S, { meta: state.meta, stats: state.stats, status: state.status, templates: state.templates,
    feeds: state.feeds, overlays: state.overlays, events: state.recent_events });
  S.started = state.status.running || state.status.progress > 0;
  S.players = new Map(state.meta.teams.flatMap((t) => t.players.map((p) => [p.id, p])));
  S.decisions = state.decisions || []; S.ghost = null;
  S.suggestions = new Map(state.suggestions.map((s) => [s.id, s]));
  S.editing.clear(); S.expanded.clear(); S.agentState = {};
  $("ticker").innerHTML = ""; $("audit").innerHTML = ""; $("screen-gfx").innerHTML = ""; $("onair").hidden = true; $("strip-empty").hidden = false; $("onair-strip").classList.remove("live");
  $("club").innerHTML = state.meta.teams.map((t) => `<option value="${t.id}">${esc(t.name)}</option>`).join("");
  state.audit.forEach(addAudit);
  state.recent_events.forEach(addTicker);
  if (state.packages.length) renderPackage(state.packages[state.packages.length - 1]);
  renderLineups(); renderLens(); renderFeedTabs(); renderBreak(); renderScorebug(); renderStats(); renderPitch(); renderStatus(); renderPipeline(); renderQueue();
}

function connect() {
  const es = new EventSource(withSid("/api/stream"));
  const on = (name, fn) => es.addEventListener(name, (m) => fn(JSON.parse(m.data)));
  on("match_event", (e) => {
    S.events.push(e); if (S.events.length > 60) S.events.shift();
    addTicker(e); renderPitch();
    if (e.type === "goal") showGoalPop(e);
    soundFor(e);
    Commentary.onEvent(e);
    if (e.type === "substitution") { toast(`🔁 ${team(e.team).short}: ${e.player_off} off, ${e.player_on} on`); renderLineups(); }
  });
  on("stats", (st) => { S.stats = st; renderScorebug(); renderStats(); renderBreak(); if (!$("lens-flags").closest("[hidden]")) renderLens();
    if (!$("lineups").closest("[hidden]") && performance.now() - (S.lineupsAt || 0) > 3000) { S.lineupsAt = performance.now(); renderLineups(); } });
  on("decision", onDecision);
  on("suggestion", upsert);
  on("trace", (t) => { const s = S.suggestions.get(t.id); if (s) { s.trace = [...(s.trace || []), t]; } onTrace(t); renderQueue(); });
  on("overlays", (ovs) => {
    ovs.forEach((o) => { S.overlays = S.overlays.filter((x) => x.id !== o.id); S.overlays.push(o); });
    const mine = ovs.find((o) => o.feed === S.feed);
    if (!mine) return;
    renderCompare(mine.suggestion_id);
    if (mine.update) {
      // FeedAdapter's version arrived: swap the text in place if that graphic is still on screen.
      if (S.onScreen === mine.suggestion_id) showOnAir(mine, true);
      return;
    }
    showOnAir(mine); Sound.sting(); Commentary.onAir(mine.slots);
  });
  on("audit", addAudit);
  on("package", (p) => { renderPackage(p); toast(`Studio rundown ready (${p.phase.replace(/_/g, " ")})`); });
  on("status", (st) => {
    const wasBreak = !!S.status?.half_time_break;
    S.status = st; renderStatus(); renderScorebug(); renderBreak();
    if (!st.goal_celebration && !$("goal-pop").hidden) setTimeout(() => { if (!S.status?.goal_celebration) $("goal-pop").hidden = true; }, 600);
    if (wasBreak && !st.half_time_break) toast("Second half under way");
  });
  on("reset", loadFull);
  es.onerror = () => { es.close(); setTimeout(async () => { loadFull(await api("/api/state")); connect(); }, 1500); };
}

// --- sound ----------------------------------------------------------------------------

function soundFor(e) {
  if (!Sound.enabled) return;
  switch (e.type) {
    case "kickoff": case "half_start": return Sound.whistle([0.7]);
    case "half_end": return Sound.whistle([0.3, 0.9]);
    case "full_time": Sound.swell(0.45, 2.5, 1100); return Sound.whistle([0.3, 0.3, 1.1]);
    case "foul": return Sound.whistle([0.22]);
    case "shot": return e.outcome === "goal" ? null : Sound.swell(e.outcome === "saved" ? 0.45 : 0.34, 0.6);
    case "goal": return Sound.swell(0.95, 4.5, 1700);
    default: return null;
  }
}

function renderSound() {
  const on = Sound.enabled;
  $("btn-sound").setAttribute("aria-pressed", String(on));
  $("btn-sound").classList.toggle("on", on);
  $("sound-waves").style.display = on ? "" : "none";
  $("sound-x").style.display = on ? "none" : "";
  $("sound-label").textContent = on ? "Turn stadium sound off" : "Turn stadium sound on";
  $("btn-sound").title = on ? "Stadium sound on" : "Stadium sound off";
  $("voice").checked = Sound.voice;
}

function toggleSound(on) {
  Sound.setEnabled(on);
  Sound.setRunning(!!S.status?.running);
  renderSound();
}

async function startOrPause() {
  if (S.status?.running) return api("/api/control", { action: "pause" });
  S.started = true;
  // Starting the match is a click, so the browser lets the stadium sound begin here.
  if (!Sound.enabled && Sound.wantedByDefault()) { toggleSound(true); toast("Stadium sound on. Use the speaker button to mute."); }
  renderQueue();
  return api("/api/control", { action: "start" });
}

document.addEventListener("click", async (ev) => {
  const expand = ev.target.closest("[data-expand]");
  if (expand && !ev.target.closest("button")) { S.expanded.add(expand.dataset.expand); return renderQueue(true); }
  const b = ev.target.closest("button");
  if (!b) {
    if (!ev.target.closest(".popover") && !ev.target.closest("#btn-settings")) closeSettings();
    return;
  }
  if (b.id === "btn-play" || b.hasAttribute("data-start")) return startOrPause();
  if (b.id === "btn-sound") return toggleSound(!Sound.enabled);
  if (b.id === "btn-view") return setView(!$("monitor").classList.contains("view-3d"));
  if (b.id === "btn-reset") { closeSettings(); return api("/api/control", { action: "reset" }); }
  if (b.id === "btn-package") return api("/api/package", { phase: "on_demand" });
  if (b.id === "btn-settings") {
    const open = $("settings").hidden;
    $("settings").hidden = !open; b.setAttribute("aria-expanded", String(open));
    return;
  }
  if (b.dataset.speed) return api("/api/control", { speed: Number(b.dataset.speed) });
  if (b.dataset.tab) {
    document.querySelectorAll("[data-tab]").forEach((t) => t.setAttribute("aria-selected", String(t === b)));
    document.querySelectorAll("[data-pane]").forEach((p) => { p.hidden = p.dataset.pane !== b.dataset.tab; });
    if (b.dataset.tab === "lens") renderLens();
    if (b.dataset.tab === "stats") renderLineups();
    return;
  }
  if (b.dataset.feed) {
    S.feed = b.dataset.feed; renderFeedTabs();
    const last = [...S.overlays].reverse().find((o) => o.feed === S.feed);
    if (last) showOnAir(last);
    return;
  }
  const id = b.dataset.id, act = b.dataset.act;
  if (!act) return;
  if (act === "approve" || act === "reject") {
    b.disabled = true;
    const card = b.closest(".card");
    if (card) card.style.opacity = ".5";
    S.hoverLock = false;
    if (act === "approve") await api(`/api/suggestions/${id}/approve`, {}).catch(() => toast("Could not put it on air — it may already be decided.", true));
    else await api(`/api/suggestions/${id}/reject`, { reason: "producer rejected" }).catch(() => {});
    renderQueue(true);
    return;
  }
  if (act === "edit") { S.editing.add(id); S.expanded.add(id); renderQueue(true); document.querySelector(`.edit-form[data-id="${id}"] input`)?.focus(); }
  if (act === "cancel") { S.editing.delete(id); renderQueue(true); }
});

function closeSettings() { $("settings").hidden = true; $("btn-settings").setAttribute("aria-expanded", "false"); }

document.addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const form = ev.target, id = form.dataset.id;
  const slots = Object.fromEntries(new FormData(form).entries());
  try {
    await api(`/api/suggestions/${id}/approve`, { slots });
    S.editing.delete(id);
    renderQueue(true);
  } catch (err) {
    const issues = err.data?.detail?.issues || ["Approval failed."];
    form.querySelector(".edit-issues").innerHTML = "<b>The Fact Checker blocked this edit:</b><br>" + issues.map(esc).join("<br>");
  }
});

document.addEventListener("keydown", (ev) => {
  if (ev.key === "Escape") closeSettings();
  if (["INPUT", "SELECT", "TEXTAREA"].includes(ev.target.tagName)) return;
  if (ev.key === "Enter" && ev.target.dataset?.expand) { S.expanded.add(ev.target.dataset.expand); return renderQueue(true); }
  const top = topPendingId();
  if (!top) return;
  if (ev.key === "a") api(`/api/suggestions/${top}/approve`, {}).catch(() => {});
  if (ev.key === "r") api(`/api/suggestions/${top}/reject`, { reason: "producer rejected (hotkey)" }).catch(() => {});
});

$("queue").addEventListener("mouseenter", () => { S.hoverLock = true; });
$("queue").addEventListener("mouseleave", () => { S.hoverLock = false; if (S.dirty) renderQueue(); });

$("faults").addEventListener("change", (e) => {
  api("/api/control", { inject_faults: e.target.checked });
  toast(e.target.checked ? "Fault test on: first drafts will contain a wrong number." : "Fault test off.", e.target.checked);
});
$("voice").addEventListener("change", (e) => { Sound.setVoice(e.target.checked); if (e.target.checked && !Sound.enabled) toggleSound(true); });
$("club").addEventListener("change", (e) => api("/api/control", { club: e.target.value }));

function setView(is3d) {
  $("monitor").classList.toggle("view-3d", is3d);
  $("monitor").classList.toggle("view-2d", !is3d);
  $("btn-view").setAttribute("aria-pressed", String(is3d));
  $("btn-view").textContent = is3d ? "3D camera" : "Top view";
  try { localStorage.setItem("pc_view", is3d ? "3d" : "2d"); } catch (_) { /* storage blocked */ }
  if (S.meta) renderPitch();
}
setView((() => { try { return localStorage.getItem("pc_view") !== "2d"; } catch (_) { return true; } })());

Commentary.bind({
  player, team, get meta() { return S.meta; },
  stats: () => S.stats, running: () => !!S.status?.running,
});

renderSound();
fetch("/api/health").then((r) => r.json()).then((h) => Sound.setNeural(String(h.voice || "").startsWith("azure"))).catch(() => {});
api("/api/state").then((st) => { loadFull(st); connect(); }).catch(() => toast("Could not reach the server. Refresh to try again.", true));
