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

  // --- opening: an original broadcast-style title sequence --------------------------------------
  // Light rays turn, starlight streams in towards the centre, a pitch outline draws itself, a flash,
  // then the title. The music is synthesised live in Web Audio (see Sound.opening), so it is recorded too.
  let opRaf = 0;
  function opening() {
    card.innerHTML = `<div class="op"><div class="op-rays"></div><canvas></canvas>
      <svg class="op-pitch" viewBox="0 0 1050 680" aria-hidden="true">
        <defs><linearGradient id="opStroke" x1="0" x2="1"><stop offset="0" stop-color="#5d8dff"/><stop offset=".5" stop-color="#e8f0ff"/><stop offset="1" stop-color="#5d8dff"/></linearGradient></defs>
        <rect x="10" y="10" width="1030" height="660" rx="6" pathLength="1"/><line x1="525" y1="10" x2="525" y2="670" pathLength="1"/>
        <circle cx="525" cy="340" r="92" pathLength="1" class="late"/>
        <rect x="10" y="168" width="165" height="344" pathLength="1" class="late"/><rect x="875" y="168" width="165" height="344" pathLength="1" class="late"/>
      </svg>
      <div class="op-glow"></div><div class="op-flash"></div>
      <div class="op-title"><h1>Producer Co-pilot</h1><div class="op-line"></div><p>AI agents propose · You decide</p>
        <small>Microsoft × Premier League · Inside the Game hackathon</small></div></div>`;
    card.classList.add("show");
    Sound.opening?.();
    const cv = card.querySelector("canvas"), g = cv.getContext("2d");
    const W = cv.width = innerWidth * devicePixelRatio, H = cv.height = innerHeight * devicePixelRatio;
    const cx = W / 2, cy = H * 0.46, R = Math.hypot(W, H) * 0.6;
    const stars = Array.from({ length: 420 }, () => ({ a: Math.random() * Math.PI * 2, r: R * (0.35 + Math.random() * 0.75),
      v: 0.006 + Math.random() * 0.012, s: 0.6 + Math.random() * 1.8, tw: Math.random() * 6 }));
    const start = performance.now();
    const frame = (now) => {
      const t = (now - start) / 1000;
      g.fillStyle = "rgba(2, 4, 11, 0.32)"; g.fillRect(0, 0, W, H);           // short trails
      const pull = t < 2.15 ? 1 + t * 1.4 : 0;                                 // stream inwards, then burst outwards
      for (const p of stars) {
        if (t < 2.15) { p.r *= 1 - p.v * pull; p.a += 0.004 * pull; }
        else { p.r += (R * 0.02 + p.r * 0.05) * p.s * 0.6; }
        if (p.r < 6) p.r = R * (0.6 + Math.random() * 0.5);
        const x = cx + Math.cos(p.a) * p.r, y = cy + Math.sin(p.a) * p.r * 0.62;
        const alpha = Math.min(1, 0.35 + 0.65 * Math.abs(Math.sin(t * 3 + p.tw))) * (t > 2.15 ? Math.max(0, 1 - (t - 2.15) / 1.4) : 1);
        g.fillStyle = `rgba(${200 + p.s * 25 | 0}, ${215 + p.s * 15 | 0}, 255, ${alpha})`;
        g.beginPath(); g.arc(x, y, p.s * devicePixelRatio, 0, Math.PI * 2); g.fill();
      }
      if (t < 7) opRaf = requestAnimationFrame(frame);
    };
    g.fillStyle = "#02040b"; g.fillRect(0, 0, W, H);
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
    if (!stage) return;
    [...stage.children].forEach((c) => stage.before(c));
    stage.remove(); stage = null; cam = { x: 0, y: 0, s: 1 };
  }
  async function zoom(target, maxScale = 1.8) {
    const t = typeof target === "string" ? document.querySelector(target) : target;
    if (!t || !stage) return;
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
    await sleep(3900);                            // the opening plays; the title lands at ~2.2 s
    const intro = say("intro");
    await sleep(900);
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
