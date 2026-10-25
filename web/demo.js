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
  // A night stadium comes alive: four floodlight towers switch on one by one, the camera swoops down
  // over the bowl while thousands of camera flashes spark in the stands, AI tracking lines race across
  // the pitch, and on the orchestral hit the title lands. Drawn live on a canvas (3D projected by hand)
  // with a synthesised cue (Sound.opening), so the screen recording captures picture and music together.
  const OP = { ON: [0.3, 0.62, 0.94, 1.26], HIT: 3.35, LEN: 7.5 };
  let opRaf = 0;
  function opening() {
    card.innerHTML = `<div class="op"><canvas></canvas><div class="op-scrim"></div>
      <div class="op-title"><div class="op-kicker"><i></i><span>Inside the Game</span><i></i></div>
        <h1>Producer Co-pilot</h1><p>AI agents propose · You decide</p>
        <small>Microsoft × Premier League hackathon</small></div><div class="op-vignette"></div></div>`;
    card.classList.add("show");
    Sound.opening?.();
    const cv = card.querySelector("canvas"), g = cv.getContext("2d");
    const dpr = Math.min(2, devicePixelRatio || 1);
    const W = cv.width = innerWidth * dpr, H = cv.height = innerHeight * dpr, cx = W / 2, cy = H * 0.52, F = W * 0.62;
    const ease = (x) => { x = Math.min(1, Math.max(0, x)); return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2; };
    const lerp = (a, b, k) => a + (b - a) * k;
    // stadium bowl: tiers of seats as a rounded rectangle (superellipse), rising outwards
    const crowd = [];
    const rim = (k, u) => { const th = u * Math.PI * 2, c = Math.cos(th), s2 = Math.sin(th), rx = 64 + k * 3.1, rz = 45 + k * 2.9;
      return [rx * Math.sign(c) * Math.pow(Math.abs(c), 0.55), k * 2.1, rz * Math.sign(s2) * Math.pow(Math.abs(s2), 0.55)]; };
    for (let k = 0; k < 16; k++) {
      const rx = 64 + k * 3.1, rz = 45 + k * 2.9, y = 0.4 + k * 2.1, n = 380 + k * 14;
      for (let i = 0; i < n; i++) {
        const th = (i / n) * Math.PI * 2 + Math.random() * 0.01, c = Math.cos(th), s2 = Math.sin(th);
        crowd.push({ p: [rx * Math.sign(c) * Math.pow(Math.abs(c), 0.55), y, rz * Math.sign(s2) * Math.pow(Math.abs(s2), 0.55)],
          hue: Math.random(), flash: 0 });
      }
    }
    const towers = [[-74, 0, -54], [74, 0, -54], [74, 0, 54], [-74, 0, 54]].map((b) => ({ base: b, top: [b[0], 62, b[2]] }));
    const streams = Array.from({ length: 9 }, (_, i) => {           // tracking lines: passes and runs across the pitch
      const pts = []; let x = -45 + Math.random() * 90, z = -28 + Math.random() * 56;
      for (let j = 0; j < 6; j++) { pts.push([x, 0.3, z]); x += (Math.random() - 0.5) * 40; z += (Math.random() - 0.5) * 26; x = Math.max(-50, Math.min(50, x)); z = Math.max(-32, Math.min(32, z)); }
      return { pts, at: 2.25 + i * 0.09, col: i % 3 === 0 ? [255, 210, 120] : [120, 200, 255] };
    });
    const sparks = Array.from({ length: 140 }, () => ({ x: Math.random(), y: 1 + Math.random() * 0.3, v: 0.05 + Math.random() * 0.12, s: 0.6 + Math.random() * 1.6 }));
    const start = performance.now();
    const frame = (now) => {
      const t = (now - start) / 1000, after = t - OP.HIT;
      // camera: a high, wide orbit swooping down and round, then a slow drift behind the title
      const k = ease(t / OP.HIT);
      const ang = lerp(-2.45, -1.35, ease(t / 6)), dist = lerp(250, 135, k), h = lerp(165, 52, k) + Math.max(0, after) * 4;
      const C = [Math.cos(ang) * dist, h, Math.sin(ang) * dist], T = [0, lerp(-10, 2, k), 0];
      let f = [T[0] - C[0], T[1] - C[1], T[2] - C[2]]; const fl = Math.hypot(...f); f = f.map((v) => v / fl);
      let r = [-f[2], 0, f[0]]; const rl = Math.hypot(...r); r = r.map((v) => v / rl);   // right = f × up
      const u = [r[1] * f[2] - r[2] * f[1], r[2] * f[0] - r[0] * f[2], r[0] * f[1] - r[1] * f[0]];
      const P = (p) => { const d = [p[0] - C[0], p[1] - C[1], p[2] - C[2]], z = d[0] * f[0] + d[1] * f[1] + d[2] * f[2];
        if (z < 2) return null; return [cx + (d[0] * r[0] + d[1] * r[1] + d[2] * r[2]) * F / z, cy - (d[0] * u[0] + d[1] * u[1] + d[2] * u[2]) * F / z, z]; };
      const lit = OP.ON.reduce((a, on) => a + Math.min(1, Math.max(0, (t - on) / 0.18)), 0) / 4;   // 0..1 as towers come on
      const dim = after > 0 ? lerp(1, 0.5, Math.min(1, after / 0.8)) : 1;
      const L = lit * dim;
      g.globalCompositeOperation = "source-over";
      const sky = g.createLinearGradient(0, 0, 0, H);
      sky.addColorStop(0, `rgb(${2 + 8 * L | 0}, ${4 + 12 * L | 0}, ${12 + 30 * L | 0})`); sky.addColorStop(1, "#010205");
      g.fillStyle = sky; g.fillRect(0, 0, W, H);
      // pitch: run-off surround, mown stripes, then the lines
      { const q = [[-60, 0, -41], [60, 0, -41], [60, 0, 41], [-60, 0, 41]].map(P);
        if (!q.some((v) => !v)) { g.fillStyle = `rgb(${14 * (0.1 + L) | 0}, ${58 * (0.1 + 0.9 * L) | 0}, ${26 * (0.1 + 0.9 * L) | 0})`;
          g.beginPath(); q.forEach((v, j) => (j ? g.lineTo(v[0], v[1]) : g.moveTo(v[0], v[1]))); g.closePath(); g.fill(); } }
      for (let i = 0; i < 14; i++) {
        const x0 = -52.5 + i * 7.5, q = [[x0, 0, -34], [x0 + 7.5, 0, -34], [x0 + 7.5, 0, 34], [x0, 0, 34]].map(P);
        if (q.some((v) => !v)) continue;
        const base = i % 2 ? [34, 120, 52] : [28, 104, 44];
        g.fillStyle = `rgb(${base[0] * (0.05 + 0.95 * L) | 0}, ${base[1] * (0.05 + 0.95 * L) | 0}, ${base[2] * (0.05 + 0.95 * L) | 0})`;
        g.beginPath(); q.forEach((v, j) => (j ? g.lineTo(v[0], v[1]) : g.moveTo(v[0], v[1]))); g.closePath(); g.fill();
      }
      g.strokeStyle = `rgba(235, 245, 235, ${0.08 + 0.7 * L})`; g.lineWidth = 1.4 * dpr;
      const line = (pts) => { const q = pts.map(P); if (q.some((v) => !v)) return; g.beginPath(); q.forEach((v, j) => (j ? g.lineTo(v[0], v[1]) : g.moveTo(v[0], v[1]))); g.stroke(); };
      line([[-52.5, 0, -34], [52.5, 0, -34], [52.5, 0, 34], [-52.5, 0, 34], [-52.5, 0, -34]]); line([[0, 0, -34], [0, 0, 34]]);
      line(Array.from({ length: 41 }, (_, i) => [Math.cos(i / 40 * Math.PI * 2) * 9.15, 0, Math.sin(i / 40 * Math.PI * 2) * 9.15]));
      for (const sx of [-1, 1]) { line([[sx * 52.5, 0, -20.2], [sx * 36, 0, -20.2], [sx * 36, 0, 20.2], [sx * 52.5, 0, 20.2]]); line([[sx * 52.5, 0, -9.2], [sx * 47, 0, -9.2], [sx * 47, 0, 9.2], [sx * 52.5, 0, 9.2]]); }
      g.globalCompositeOperation = "lighter";
      // light pool over the pitch
      const c0 = P([0, 0, 0]);
      if (c0 && L > 0) { const pool = g.createRadialGradient(c0[0], c0[1], 0, c0[0], c0[1], W * 0.55);
        pool.addColorStop(0, `rgba(190, 220, 255, ${0.16 * L})`); pool.addColorStop(1, "rgba(0,0,0,0)"); g.fillStyle = pool; g.fillRect(0, 0, W, H); }
      // the stands: a sloped ring of terraces between the inner and outer tier, plus the roof edge
      for (let i = 0; i < 72; i++) {
        const q = [rim(0, i / 72), rim(0, (i + 1) / 72), rim(15, (i + 1) / 72), rim(15, i / 72)].map(P);
        if (q.some((v) => !v)) continue;
        g.globalCompositeOperation = "source-over";
        g.fillStyle = `rgba(${18 + 40 * L | 0}, ${22 + 46 * L | 0}, ${34 + 62 * L | 0}, 1)`;
        g.beginPath(); q.forEach((v, j) => (j ? g.lineTo(v[0], v[1]) : g.moveTo(v[0], v[1]))); g.closePath(); g.fill();
      }
      g.globalCompositeOperation = "lighter";
      g.strokeStyle = `rgba(170, 200, 255, ${0.1 + 0.35 * L})`; g.lineWidth = 2 * dpr;
      line(Array.from({ length: 97 }, (_, i) => rim(15, i / 96).map((v, j) => (j === 1 ? v + 3 : v))));
      // crowd with camera flashes
      const flashRate = t > 1.3 ? (after > 0 ? 0.004 : 0.0025 + 0.004 * Math.min(1, (t - 1.3) / 2)) : 0;
      for (const c of crowd) {
        const q = P(c.p); if (!q) continue;
        if (Math.random() < flashRate) c.flash = 1;
        const sz = Math.max(1, 1.6 * dpr * 90 / q[2]);
        if (c.flash > 0.02) { g.fillStyle = `rgba(255, 255, 255, ${c.flash})`; g.fillRect(q[0] - sz, q[1] - sz, sz * 2.2, sz * 2.2); c.flash *= 0.72; }
        else { const v = (0.08 + 0.6 * L) * (0.5 + c.hue * 0.5); const warm = c.hue > 0.7;
          g.fillStyle = warm ? `rgba(255, 170, 120, ${v})` : `rgba(${150 + c.hue * 80 | 0}, ${165 + c.hue * 40 | 0}, 225, ${v})`; g.fillRect(q[0], q[1], sz, sz); }
      }
      // floodlight towers: mast, then a blazing head with an anamorphic streak when it switches on
      towers.forEach((tw, i) => {
        const a = P(tw.base), b = P(tw.top); if (!a || !b) return;
        g.strokeStyle = `rgba(120, 140, 170, ${0.25 + 0.3 * L})`; g.lineWidth = 2 * dpr; g.beginPath(); g.moveTo(a[0], a[1]); g.lineTo(b[0], b[1]); g.stroke();
        const on = Math.min(1, Math.max(0, (t - OP.ON[i]) / 0.12)); if (!on) return;
        const surge = 1 + 2.2 * Math.max(0, 1 - (t - OP.ON[i]) / 0.5);
        const rad = Math.min(W * 0.2, 40 * dpr * 160 / b[2]) * surge;
        const hg = g.createRadialGradient(b[0], b[1], 0, b[0], b[1], rad);
        hg.addColorStop(0, `rgba(255, 255, 255, ${on})`); hg.addColorStop(0.2, `rgba(220, 235, 255, ${0.55 * on * dim})`); hg.addColorStop(1, "rgba(0,0,0,0)");
        g.fillStyle = hg; g.fillRect(b[0] - rad, b[1] - rad, rad * 2, rad * 2);
        const sl = g.createLinearGradient(b[0] - W * 0.45, 0, b[0] + W * 0.45, 0);
        sl.addColorStop(0, "rgba(110,160,255,0)"); sl.addColorStop(0.5, `rgba(180, 210, 255, ${0.55 * on * Math.min(1, surge - 0.6) * dim})`); sl.addColorStop(1, "rgba(110,160,255,0)");
        g.fillStyle = sl; g.fillRect(b[0] - W * 0.45, b[1] - 1.5 * dpr, W * 0.9, 3 * dpr);
        // the beam down onto the pitch
        if (c0) { const bg = g.createLinearGradient(b[0], b[1], c0[0], c0[1]); bg.addColorStop(0, `rgba(200, 225, 255, ${0.12 * on * dim})`); bg.addColorStop(1, "rgba(200,225,255,0)");
          g.fillStyle = bg; g.beginPath(); g.moveTo(b[0], b[1]); g.lineTo(c0[0] - W * 0.12, c0[1]); g.lineTo(c0[0] + W * 0.12, c0[1]); g.closePath(); g.fill(); }
        // a whole-frame bloom on each switch-on
        const bl = Math.max(0, 1 - (t - OP.ON[i]) / 0.35) * 0.18; if (bl > 0) { g.fillStyle = `rgba(200, 220, 255, ${bl})`; g.fillRect(0, 0, W, H); }
      });
      // AI tracking lines racing across the pitch
      for (const st of streams) {
        const pr = Math.min(1, Math.max(0, (t - st.at) / 0.7)); if (!pr) continue;
        const fade = after > 0 ? Math.max(0, 1 - after / 1.2) : 1, q = st.pts.map(P); if (q.some((v) => !v)) continue;
        const segs = (q.length - 1) * pr;
        for (const [w, al] of [[7 * dpr, 0.15], [2 * dpr, 0.9]]) {
          g.strokeStyle = `rgba(${st.col[0]}, ${st.col[1]}, ${st.col[2]}, ${al * fade})`; g.lineWidth = w; g.beginPath(); g.moveTo(q[0][0], q[0][1]);
          for (let j = 1; j <= Math.ceil(segs); j++) { const kk = Math.min(1, segs - (j - 1)); g.lineTo(q[j - 1][0] + (q[j][0] - q[j - 1][0]) * kk, q[j - 1][1] + (q[j][1] - q[j - 1][1]) * kk); }
          g.stroke();
        }
      }
      if (after > 0) {                                               // the hit: flash, shockwave, gold sparks rising
        const fl = Math.max(0, 1 - after / 0.5);
        const fg = g.createRadialGradient(cx, H * 0.45, 0, cx, H * 0.45, W * 0.7);
        fg.addColorStop(0, `rgba(255, 246, 225, ${0.9 * fl})`); fg.addColorStop(0.4, `rgba(255, 205, 130, ${0.3 * fl})`); fg.addColorStop(1, "rgba(0,0,0,0)");
        g.fillStyle = fg; g.fillRect(0, 0, W, H);
        const rr = after * W * 0.9, ra = Math.max(0, 1 - after / 1);
        g.strokeStyle = `rgba(255, 215, 150, ${0.5 * ra})`; g.lineWidth = 3 * dpr; g.beginPath(); g.ellipse(cx, H * 0.45, rr, rr * 0.28, 0, 0, Math.PI * 2); g.stroke();
        for (const sp of sparks) {
          const y = (sp.y - after * sp.v) * H, al = Math.min(1, after * 2) * Math.max(0, 1 - (after - 2.5) / 1.5);
          if (al <= 0) continue; g.fillStyle = `rgba(255, ${200 + sp.s * 25 | 0}, 140, ${0.7 * al})`;
          g.fillRect(sp.x * W + Math.sin(after * 2 + sp.s * 9) * 12 * dpr, y, sp.s * dpr * 1.6, sp.s * dpr * 1.6);
        }
      }
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
    await sleep(5000);                            // the opening plays; the title lands at ~3.35 s
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
