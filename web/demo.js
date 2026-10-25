"use strict";

// Guided demo tour (open the app with ?demo=1). It drives the real console against the live match,
// live agents and live voices, with a narrator (Azure AI Speech), captions and a visible cursor.
// "Record demo" captures this tab with its audio and downloads the video when the tour ends.
const Demo = (() => {
  const LINES = {
    intro: "Live TV graphics get seconds to be right. Producer Co-pilot is an AI graphics desk where agents propose and a human producer decides.",
    agents: "Agents built on Microsoft Agent Framework watch the live match. They spot the moment, explain why it matters and write the graphic, using GPT-5 mini on Microsoft Foundry.",
    check: "A deterministic Fact Checker verifies every number. In test mode we planted a wrong one: it was caught and sent back until the draft was right.",
    approve: "One key approves it, and it airs instantly. The FeedAdapter agent then rewrites it for TV, a fan app and the club's channel, each version checked again.",
    ask: "Fans get Ask the Match: an agent that answers from the live data through tools. It only knows what has happened so far, it works in any language, and every number is checked.",
    request: "Fans can even request it on screen; the producer still decides.",
    lens: "Decision Lens rates every pass against the player's options using expected threat, flagging missed forward options and brave passes, with a vision score per player.",
    fulltime: "At full time: substitutions arrived live, every player has a rating, and the Man of the Match is built partly on the Decision Lens score.",
    outro: "Producer Co-pilot. Built with Agent Framework, Microsoft Foundry, Azure AI Speech and Container Apps.",
  };
  const QUESTION = "What happened around minute 9?";
  const GOAL_T = 530;          // first goal of the seeded demo match (9')
  const PAUSE_BEFORE_GOAL = 505;

  const clips = {};
  let busy = false, voicePref = true;

  // --- UI ----------------------------------------------------------------------

  function el(tag, cls, html) { const e = document.createElement(tag); if (cls) e.className = cls; if (html) e.innerHTML = html; return e; }
  const panel = el("div", "demo-panel", `<b>Demo tour</b><span id="demo-status" class="muted small">Preparing narration…</span>
    <button class="btn primary" type="button" id="demo-record" disabled>● Record demo</button>
    <button class="btn ghost" type="button" id="demo-play" disabled>▶ Play without recording</button>
    <span class="muted small">Tip: full-screen this window first (F11 / ⌃⌘F), then in the share dialog choose <b>this tab</b>. Sound is recorded from the app directly.</span>`);
  const caption = el("div", "demo-caption");
  const cursor = el("div", "demo-cursor", `<span class="ripple"></span><svg viewBox="0 0 24 24" aria-hidden="true">
    <path d="M1 1 L1 19.5 L5.6 15.4 L8.7 22.4 L12.1 20.9 L9 14 L15.2 14 Z" fill="#fff" stroke="#0b0f1a" stroke-width="1.4" stroke-linejoin="round"/></svg>`);
  const card = el("div", "demo-card");
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const status = (t) => { const s = document.getElementById("demo-status"); if (s) s.textContent = t; };

  function showCard(kind) {
    card.classList.toggle("opening", kind === "intro");
    if (kind === "intro") { opening(); return; }
    card.innerHTML = `<div class="dc-inner"><span class="dc-dot"></span><h1>Producer Co-pilot</h1><p>AI proposes, every number is checked, you decide.</p>
         <div class="dc-tags"><span>Microsoft Agent Framework</span><span>Microsoft Foundry</span><span>Azure AI Speech</span><span>Azure Container Apps</span></div>
         <small>Try it live: ${location.host}</small></div>`;
    card.classList.add("show");
  }
  const hideCard = () => { card.classList.remove("show"); setTimeout(() => { if (!card.classList.contains("show")) { cancelAnimationFrame(opRaf); } }, 900); };

  // --- opening: an original broadcast-style title sequence ------------------------------------
  // Floodlight beams over a dark bowl; a football made of light assembles from thousands of particles
  // and turns towards the camera; a hit (flash, shockwave, anamorphic flare) bursts it, and a metallic
  // title lands. Everything is drawn live (canvas + CSS) and the cue is synthesised (Sound.opening),
  // so the screen recording captures picture and music together.
  const OP = { HIT: 2.45, LEN: 6.5 };
  let opRaf = 0;
  function footballEdges() {
    const f = (1 + Math.sqrt(5)) / 2, base = [[0, 1, 3 * f], [1, 2 + f, 2 * f], [f, 2, 2 * f + 1]], V = [];
    for (const [x, y, z] of base) for (const [a, b, c] of [[x, y, z], [y, z, x], [z, x, y]])
      for (const sa of [1, -1]) for (const sb of [1, -1]) for (const sc of [1, -1]) {
        const v = [a * sa, b * sb, c * sc];
        if (!V.some((w) => Math.hypot(w[0] - v[0], w[1] - v[1], w[2] - v[2]) < 1e-6)) V.push(v);
      }
    const E = [];
    for (let i = 0; i < V.length; i++) for (let j = i + 1; j < V.length; j++)
      if (Math.abs(Math.hypot(V[i][0] - V[j][0], V[i][1] - V[j][1], V[i][2] - V[j][2]) - 2) < 1e-6) E.push([V[i], V[j]]);
    return E;                                                       // 90 edges of a truncated icosahedron
  }
  function opening() {
    card.innerHTML = `<div class="op"><canvas></canvas>
      <div class="op-title"><div class="op-kicker"><i></i><span>Inside the Game</span><i></i></div>
        <h1>Producer Co-pilot</h1><p>AI agents propose · You decide</p>
        <small>Microsoft × Premier League hackathon</small></div><div class="op-vignette"></div></div>`;
    card.classList.add("show");
    Sound.opening?.();
    const cv = card.querySelector("canvas"), g = cv.getContext("2d");
    const dpr = Math.min(2, devicePixelRatio || 1);
    const W = cv.width = innerWidth * dpr, H = cv.height = innerHeight * dpr;
    const cx = W / 2, cy = H * 0.45, unit = Math.min(W, H) * 0.052;
    // grain tile
    const grain = document.createElement("canvas"); grain.width = grain.height = 160;
    const gg = grain.getContext("2d"), id = gg.createImageData(160, 160);
    for (let i = 0; i < id.data.length; i += 4) { const v = Math.random() * 255; id.data[i] = id.data[i + 1] = id.data[i + 2] = v; id.data[i + 3] = 255; }
    gg.putImageData(id, 0, 0);
    // particles that settle on the football's edges
    const parts = [];
    for (const [p, q] of footballEdges()) for (let k = 0; k < 9; k++) {
      const u = (k + Math.random() * 0.6) / 9.3, tx = p[0] + (q[0] - p[0]) * u, ty = p[1] + (q[1] - p[1]) * u, tz = p[2] + (q[2] - p[2]) * u;
      const a = Math.random() * Math.PI * 2, e = Math.acos(2 * Math.random() - 1), r = 18 + Math.random() * 26;
      parts.push({ t: [tx, ty, tz], s: [r * Math.sin(e) * Math.cos(a), r * Math.sin(e) * Math.sin(a) * 0.6, r * Math.cos(e)],
        d: Math.random() * 0.55, size: 0.7 + Math.random() * 1.3, burst: 1.5 + Math.random() * 2.5 });
    }
    const edges = footballEdges();
    const ease = (x) => 1 - Math.pow(1 - Math.min(1, Math.max(0, x)), 3);
    const start = performance.now();
    const frame = (now) => {
      const t = (now - start) / 1000, hit = OP.HIT, after = t - hit;
      g.globalCompositeOperation = "source-over";
      const bg = g.createRadialGradient(cx, cy, 0, cx, cy, Math.max(W, H) * 0.75);
      bg.addColorStop(0, "#0b1430"); bg.addColorStop(0.55, "#050a1a"); bg.addColorStop(1, "#010208");
      g.fillStyle = bg; g.fillRect(0, 0, W, H);
      g.globalCompositeOperation = "lighter";
      // floodlight beams from the top, slowly sweeping
      const beamA = Math.min(1, t / 0.8) * (after > 0 ? 1 + Math.max(0, 0.8 - after) : 1);
      for (let i = 0; i < 6; i++) {
        const side = i < 3 ? -1 : 1, k = i % 3, ox = cx + side * W * (0.18 + k * 0.13), sway = Math.sin(t * 0.7 + i) * 0.06;
        const ang = Math.PI / 2 - side * (0.32 + k * 0.1 + sway), len = H * 1.25, spread = 0.07;
        const bx = ox + Math.cos(ang) * len, by = -H * 0.05 + Math.sin(ang) * len;
        const lg = g.createLinearGradient(ox, -H * 0.05, bx, by);
        lg.addColorStop(0, `rgba(170, 200, 255, ${0.16 * beamA})`); lg.addColorStop(1, "rgba(170, 200, 255, 0)");
        g.fillStyle = lg; g.beginPath(); g.moveTo(ox, -H * 0.05);
        g.lineTo(ox + Math.cos(ang - spread) * len, -H * 0.05 + Math.sin(ang - spread) * len);
        g.lineTo(ox + Math.cos(ang + spread) * len, -H * 0.05 + Math.sin(ang + spread) * len); g.closePath(); g.fill();
      }
      // the football: rotate, push towards camera, project
      const ry = 0.6 + t * 1.05, rx = 0.35 + Math.sin(t * 0.6) * 0.15, dolly = 30 - ease(t / hit) * 12;
      const cyR = Math.cos(ry), syR = Math.sin(ry), cxR = Math.cos(rx), sxR = Math.sin(rx);
      const proj = (x, y, z) => {
        const x1 = x * cyR + z * syR, z1 = -x * syR + z * cyR, y1 = y * cxR - z1 * sxR, z2 = y * sxR + z1 * cxR;
        const zz = z2 + dolly, f = 22 / zz;
        return [cx + x1 * unit * f, cy + y1 * unit * f, f];
      };
      const fadeOut = after > 0 ? Math.max(0, 1 - after / 0.35) : 1;
      if (t > 1.35 && fadeOut > 0) {                                  // glowing seams once the particles have arrived
        const ea = Math.min(1, (t - 1.35) / 0.6) * fadeOut;
        for (const [w, lw] of [[0.07, 16 * dpr], [0.16, 6 * dpr], [0.75, 1.8 * dpr]]) {
          g.strokeStyle = `rgba(255, 228, 170, ${w * ea})`; g.lineWidth = lw; g.beginPath();
          for (const [p, q] of edges) { const a = proj(...p), b = proj(...q); g.moveTo(a[0], a[1]); g.lineTo(b[0], b[1]); }
          g.stroke();
        }
      }
      for (const p of parts) {
        let x, y, z, alpha;
        if (after < 0) {
          const e = ease((t - p.d) / 1.5);
          x = p.s[0] + (p.t[0] - p.s[0]) * e; y = p.s[1] + (p.t[1] - p.s[1]) * e; z = p.s[2] + (p.t[2] - p.s[2]) * e;
          alpha = Math.min(1, (t - p.d + 0.2) * 2);
        } else {
          const k = 1 + after * p.burst * 2.2; x = p.t[0] * k; y = p.t[1] * k; z = p.t[2] * k;
          alpha = Math.max(0, 1 - after / 1.1);
        }
        if (alpha <= 0) continue;
        const [sx, sy, f] = proj(x, y, z);
        const r = p.size * dpr * Math.max(0.4, f * 1.3);
        g.fillStyle = `rgba(255, ${226 + p.size * 15 | 0}, ${178 + p.size * 30 | 0}, ${0.85 * alpha})`;
        g.fillRect(sx - r / 2, sy - r / 2, r, r);
      }
      if (after > 0) {
        // flash
        const fl = Math.max(0, 1 - after / 0.45);
        const fg = g.createRadialGradient(cx, cy, 0, cx, cy, W * 0.6);
        fg.addColorStop(0, `rgba(255, 245, 220, ${0.95 * fl})`); fg.addColorStop(0.35, `rgba(255, 210, 140, ${0.35 * fl})`); fg.addColorStop(1, "rgba(0,0,0,0)");
        g.fillStyle = fg; g.fillRect(0, 0, W, H);
        // shockwave ring
        const rr = after * W * 0.75, ra = Math.max(0, 1 - after / 0.9);
        g.strokeStyle = `rgba(255, 220, 160, ${0.55 * ra})`; g.lineWidth = 3 * dpr;
        g.beginPath(); g.ellipse(cx, cy, rr, rr * 0.32, 0, 0, Math.PI * 2); g.stroke();
        // anamorphic flare: a long horizontal streak through the centre
        const sa = Math.max(0, 1 - after / 1.6) * Math.min(1, after / 0.05);
        const sg = g.createLinearGradient(0, cy, W, cy);
        sg.addColorStop(0, "rgba(120,170,255,0)"); sg.addColorStop(0.5, `rgba(200, 225, 255, ${0.75 * sa})`); sg.addColorStop(1, "rgba(120,170,255,0)");
        g.fillStyle = sg; g.fillRect(0, cy - 2 * dpr, W, 4 * dpr);
        g.fillStyle = `rgba(150, 190, 255, ${0.10 * sa})`; g.fillRect(0, cy - 26 * dpr, W, 52 * dpr);
        // warm afterglow behind the title
        const ag = g.createRadialGradient(cx, cy, 0, cx, cy, W * 0.42);
        ag.addColorStop(0, `rgba(255, 200, 120, ${0.16 * Math.min(1, after / 0.4)})`); ag.addColorStop(1, "rgba(0,0,0,0)");
        g.fillStyle = ag; g.fillRect(0, 0, W, H);
      }
      // film grain
      g.globalCompositeOperation = "overlay"; g.globalAlpha = 0.07;
      g.fillStyle = g.createPattern(grain, "repeat"); g.save(); g.translate(Math.random() * 160, Math.random() * 160);
      g.fillRect(-160, -160, W + 320, H + 320); g.restore(); g.globalAlpha = 1;
      if (t < OP.LEN && card.classList.contains("show")) opRaf = requestAnimationFrame(frame);
    };
    opRaf = requestAnimationFrame(frame);
  }


  // --- narration --------------------------------------------------------------------

  async function prefetch() {
    const keys = Object.keys(LINES);
    let done = 0;
    await Promise.all(keys.map(async (k) => {
      try {
        const res = await fetch("/api/tts", { method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text: LINES[k], narrator: true }) });
        if (res.ok) clips[k] = URL.createObjectURL(await res.blob());
      } catch (_) { /* browser voice fallback */ }
      status(`Preparing narration… ${++done}/${keys.length}`);
    }));
    status(Object.keys(clips).length === keys.length ? "Ready. Narration: Azure AI Speech neural voice." : "Ready (browser voice for narration).");
    document.getElementById("demo-record").disabled = false;
    document.getElementById("demo-play").disabled = false;
  }

  function say(key) {
    caption.textContent = LINES[key];
    caption.classList.add("show");
    return new Promise((resolve) => {
      let finished = false;
      const done = () => { if (finished) return; finished = true; caption.classList.remove("show"); resolve(); };
      setTimeout(done, LINES[key].length * 80 + 2500);   // never hang if audio fails to report its end
      if (clips[key]) {
        const a = new Audio(clips[key]);
        Sound.route(a);
        a.onended = done; a.onerror = done;
        a.play().catch(done);
      } else if ("speechSynthesis" in window) {
        const u = new SpeechSynthesisUtterance(LINES[key]);
        u.lang = "en-US"; u.onend = done; u.onerror = done;
        speechSynthesis.speak(u);
      } else setTimeout(done, LINES[key].length * 60);
    });
  }

  // --- cursor + actions ---------------------------------------------------------------

  function center(target) { const r = target.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; }
  async function pointAt(target, ms = 500) {
    if (!target) return;
    const [x, y] = center(target);
    cursor.style.transitionDuration = `${ms}ms`;
    cursor.style.transform = `translate(${x}px, ${y}px)`;
    await sleep(ms + 80);
  }
  async function click(selector) {
    let t = document.querySelector(selector);
    if (!t) return false;
    await pointAt(t);
    t = document.querySelector(selector) || t;   // the queue may have re-rendered while the cursor moved
    cursor.classList.add("press"); setTimeout(() => cursor.classList.remove("press"), 250);
    t.click();
    await sleep(250);
    return true;
  }
  async function typeInto(selector, text) {
    const input = document.querySelector(selector);
    await pointAt(input);
    input.focus();
    for (const ch of text) { input.value += ch; await sleep(25); }
  }
  // --- camera: zoom into the part the narrator is explaining -------------------------------
  // The app (top bar, timeline, layout) moves inside one stage; captions, cursor and cards stay outside it.
  let stage = null, cam = { x: 0, y: 0, s: 1 };
  function buildStage() {
    if (stage) return;
    stage = el("div", "demo-stage");
    const parts = [".topbar", ".timeline", ".layout"].map((q) => document.querySelector(q));
    parts[0].before(stage);
    parts.forEach((p) => stage.appendChild(p));
  }
  function dropStage() {
    clearFocus();
    if (!stage) return;
    [...stage.children].forEach((c) => stage.before(c));
    stage.remove(); stage = null; cam = { x: 0, y: 0, s: 1 };
  }
  // A highlight box around the feature being explained. It sits on the element inside the stage,
  // so it zooms with the camera.
  let focusEl = null;
  function focusBox(t) {
    if (focusEl === t) return;
    clearFocus();
    if (!t) return;
    focusEl = t;
    t.classList.remove("demo-focus"); void t.offsetWidth;   // restart the draw-in animation
    t.classList.add("demo-focus");
  }
  function clearFocus() { focusEl?.classList.remove("demo-focus"); focusEl = null; }

  async function zoom(target, maxScale = 1.8) {
    const t = typeof target === "string" ? document.querySelector(target) : target;
    if (!t || !stage) return;
    focusBox(t);
    const r = t.getBoundingClientRect();
    const origin = { x: -window.scrollX, y: -window.scrollY };              // stage's untransformed top-left on screen
    const q = { x: (r.left + r.width / 2 - origin.x - cam.x) / cam.s, y: (r.top + r.height / 2 - origin.y - cam.y) / cam.s };
    const w = r.width / cam.s, h = r.height / cam.s;
    const s = Math.max(1.15, Math.min(maxScale, (0.82 * innerWidth) / w, (0.68 * innerHeight) / h));
    const v = { x: innerWidth / 2, y: innerHeight / 2 - 40 };                  // a little above centre, clear of captions
    cam = { x: v.x - origin.x - s * q.x, y: v.y - origin.y - s * q.y, s };
    stage.style.transform = `translate(${cam.x}px, ${cam.y}px) scale(${s})`;
    await sleep(850);
  }
  async function unzoom() {
    clearFocus();
    if (!stage || cam.s === 1) return;
    cam = { x: 0, y: 0, s: 1 };
    stage.style.transform = "none";
    await sleep(750);
  }

  async function scrollToEl(selector, offset = 96) {
    await unzoom();
    return scrollPlain(selector, offset);
  }
  function scrollPlain(selector, offset = 96) {
    const t = document.querySelector(selector);
    if (t) window.scrollTo({ top: t.getBoundingClientRect().top + window.scrollY - offset, behavior: "smooth" });
    return sleep(700);
  }
  async function waitFor(fn, timeout = 30000) {
    const end = performance.now() + timeout;
    while (performance.now() < end) { if (fn()) return true; await sleep(200); }
    return false;
  }
  const control = (body) => api("/api/control", body).catch(() => {});
  const pending = () => [...S.suggestions.values()].filter((s) => s.status === "pending");

  // --- the tour -------------------------------------------------------------------------

  let t0 = 0;
  const times = [];
  const mark = (name) => times.push([name, ((performance.now() - t0) / 1000).toFixed(1)]);
  window.DEMO_TIMES = times;

  async function tour() {
    t0 = performance.now();
    times.length = 0;
    voicePref = Sound.voice;
    Sound.setVoice(false);                       // the narrator talks; the commentator gets the goal
    window.scrollTo({ top: 0 });
    await control({ action: "reset" });
    await waitFor(() => S.status && S.status.progress === 0 && !S.status.running, 8000);
    await control({ inject_faults: true, speed: 45 });   // reach the first moment quickly, so the agents start early
    setView(true);
    document.querySelector("[data-tab=stats]")?.click();
    document.querySelector("[data-feed=main]")?.click();

    // 1. Title: a short card, then the narrator continues over the live console
    buildStage();
    showCard("intro");
    let goalScene = false;
    const watch = setInterval(() => {               // rest just before the first goal so the goal scene catches it
      if (!goalScene && S.status?.running && S.stats?.t >= PAUSE_BEFORE_GOAL) control({ action: "pause" });
    }, 150);
    S.started = true;
    await control({ action: "start" });
    await sleep(4300);                            // the opening plays; the title lands at ~2.5 s
    const intro = say("intro");
    await sleep(1000);
    hideCard();
    await intro;

    // 2. The agents get to work
    mark("agents");
    const agents = say("agents");
    await scrollToEl(".agents-panel", 300);
    await zoom(".agents-panel", 1.7);
    await sleep(5200);
    await scrollToEl(".monitor-panel");
    await agents;

    // 3. Fact Checker
    mark("wait-first-card");
    await waitFor(() => pending().length > 0, 45000);
    mark("check");
    const checked = say("check");
    await click(".card.pending.top details summary");
    await zoom(".card.pending.top", 1.7);
    await pointAt(document.querySelector(".card.pending.top .verify"));
    await checked;
    await unzoom();

    // 4. Approve -> on air -> three feeds (switching feeds while the narrator explains them)
    mark("approve");
    const approved = say("approve");
    await click(".card.pending.top [data-act=approve]");
    await sleep(700);
    await scrollToEl(".onair-strip", 420);
    await zoom(".monitor-panel", 1.3);
    await sleep(1200);
    await click("[data-feed=casual]");
    await sleep(1500);
    await click("[data-feed=club]");
    await sleep(900);
    await zoom("#feed-compare", 1.8);
    await approved;
    await unzoom();
    await click("[data-feed=main]");

    // 5. Goal: the commentator takes over
    mark("goal");
    await scrollToEl(".monitor-panel");
    goalScene = true;
    Sound.setVoice(true);
    await control({ speed: 15, action: "start" });
    caption.textContent = "Live commentary: Azure AI Speech neural voice";
    caption.classList.add("show");
    await zoom(".monitor", 1.35);
    await waitFor(() => S.stats?.t >= GOAL_T, 20000);    // the goal pop-up and celebration pause start here
    await sleep(4500);
    caption.classList.remove("show");
    Sound.setVoice(false);
    await unzoom();

    // 6. Ask the Match (the match speeds up from here so the closing scenes reach full time)
    mark("ask");
    await control({ speed: 120 });
    await scrollToEl("#fan-panel");
    const ask = say("ask");
    await zoom("#fan-panel", 1.6);
    await typeInto("#ask-input", QUESTION);
    const before = document.querySelectorAll(".answer:not(.pending)").length;
    await click("#ask-btn");
    await ask;
    mark("ask-wait-answer");
    await waitFor(() => document.querySelectorAll(".answer:not(.pending)").length > before, 30000);
    mark("answer");
    await zoom(".answer", 1.9);
    await sleep(700);

    // 7. Fan request -> producer queue
    const req = say("request");
    await click(".answer [data-request]");
    await sleep(600);
    await unzoom();
    const fanCard = [...document.querySelectorAll("#queue .card")].find((c) => c.textContent.includes("Fan request"));
    if (fanCard) await zoom(fanCard, 1.8);
    await pointAt(fanCard || document.querySelector("#queue"));
    await req;
    await unzoom();

    // 8. Decision Lens (the match fast-forwards from here, so the next scene reaches full time)
    mark("lens");
    await control({ speed: 240 });
    await scrollToEl(".tabs-panel");
    const lens = say("lens");
    await click("[data-tab=lens]");
    await sleep(400);
    await zoom(".lens-grid", 1.5);
    await pointAt(document.querySelector("#vision-board"));
    await lens;
    await unzoom();

    // 9. Full time: substitutions, ratings, Man of the Match
    mark("fulltime");
    const ft = say("fulltime");
    await click("[data-tab=stats]");
    await scrollToEl("#lineups", 140);
    await waitFor(() => (S.stats?.subs || []).length >= 3, 15000);
    await zoom("#lineups", 1.45);
    await pointAt([...document.querySelectorAll("#lineups .subtag")].pop());
    await waitFor(() => S.stats?.finished, 25000);
    await scrollToEl(".monitor-panel");
    await zoom("#break-card", 1.7);
    await pointAt(document.querySelector(".br-motm"));
    await ft;
    await unzoom();
    await scrollToEl(".tabs-panel");
    await click("[data-tab=lens]");
    await sleep(300);
    await zoom(".motm-card", 2);
    await sleep(1800);
    await unzoom();

    // 10. Close
    mark("outro");
    clearInterval(watch);
    await control({ action: "pause" });
    showCard("outro");
    await say("outro");
    await sleep(500);
    Sound.setVoice(voicePref);
    dropStage();
    mark("end");
    return (performance.now() - t0) / 1000;
  }

  // --- recording -------------------------------------------------------------------------

  async function start(record) {
    if (busy) return;
    busy = true;
    if (!Sound.enabled) toggleSound(true);       // inside the click, so the browser allows audio
    let rec = null, chunks = [], stream = null;
    if (record) {
      try {
        stream = await navigator.mediaDevices.getDisplayMedia({
          video: { frameRate: 30, width: { ideal: 1920 }, height: { ideal: 1080 } }, audio: false,
          preferCurrentTab: true, selfBrowserSurface: "include" });
      } catch (_) { busy = false; status("Recording cancelled."); return; }
      // Sound comes straight from the app's own audio mix (narrator, commentator, crowd), not from tab capture.
      const mix = Sound.recordStream();
      if (mix) stream = new MediaStream([...stream.getVideoTracks(), ...mix.getAudioTracks()]);
      const type = ["video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm"].find((t) => MediaRecorder.isTypeSupported(t));
      rec = new MediaRecorder(stream, { mimeType: type, videoBitsPerSecond: 8_000_000 });
      rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
      rec.start(1000);
    }
    panel.classList.add("hidden");
    document.body.classList.add("demo-running");
    let secs = 0;
    try { secs = await tour(); } finally {
      document.body.classList.remove("demo-running");
      dropStage();
      hideCard(); caption.classList.remove("show");
      panel.classList.remove("hidden");
      busy = false;
    }
    if (rec) {
      await new Promise((r) => { rec.onstop = r; rec.stop(); });
      stream.getTracks().forEach((t) => t.stop());
      const url = URL.createObjectURL(new Blob(chunks, { type: rec.mimeType }));
      const a = Object.assign(document.createElement("a"), { href: url, download: "producer-copilot-demo.webm" });
      document.body.appendChild(a); a.click(); a.remove();
      status(`Done: ${secs.toFixed(0)} s. The video was downloaded as producer-copilot-demo.webm.`);
    } else status(`Tour finished in ${secs.toFixed(0)} s.`);
  }

  function init() {
    if (!new URLSearchParams(location.search).has("demo")) return;
    document.body.append(panel, caption, cursor, card);
    document.getElementById("demo-record").onclick = () => start(true);
    document.getElementById("demo-play").onclick = () => start(false);
    prefetch();
  }
  init();
  return { start, LINES };
})();
