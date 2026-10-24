"use strict";

// Guided demo tour (open the app with ?demo=1). It drives the real console against the live match,
// live agents and live voices, with a narrator (Azure AI Speech), captions and a visible cursor.
// "Record demo" captures this tab with its audio and downloads the video when the tour ends.
const Demo = (() => {
  const LINES = {
    intro: "Live TV graphics get seconds to be right, and one wrong number on air is a real problem. Producer Co-pilot is an AI graphics desk where agents propose and a human producer decides.",
    agents: "Agents built on Microsoft Agent Framework watch the live match. They spot the moment, explain why it matters and write the graphic, using GPT-5 mini on Microsoft Foundry.",
    check: "Before anything reaches the producer, a deterministic Fact Checker verifies every number. In test mode we planted a wrong number: the checker caught it and sent the draft back until it was right.",
    approve: "The producer approves with one key, and it airs instantly. Then the FeedAdapter agent rewrites it for TV, a fan app and the club's own channel, and every version is checked again.",
    ask: "Fans get Ask the Match: an agent that answers from the live data through tools. It only knows what has happened so far, it works in any language, and every number is checked.",
    request: "A fan can even ask for it on screen. The request lands in the producer's queue, and the producer still decides.",
    lens: "Decision Lens rates every pass against the options the player had, using expected threat. It flags missed forward options and brave passes, and gives every player a vision score.",
    outro: "Producer Co-pilot. Built with Agent Framework, Microsoft Foundry, Azure AI Speech and Azure Container Apps. Try it live.",
  };
  const QUESTION = "What happened around minute 9?";
  const GOAL_T = 530;          // first goal of the seeded demo match (9')
  const PAUSE_BEFORE_GOAL = 470;

  const clips = {};
  let busy = false, voicePref = true;

  // --- UI ----------------------------------------------------------------------

  function el(tag, cls, html) { const e = document.createElement(tag); if (cls) e.className = cls; if (html) e.innerHTML = html; return e; }
  const panel = el("div", "demo-panel", `<b>Demo tour</b><span id="demo-status" class="muted small">Preparing narration…</span>
    <button class="btn primary" type="button" id="demo-record" disabled>● Record demo</button>
    <button class="btn ghost" type="button" id="demo-play" disabled>▶ Play without recording</button>
    <span class="muted small">Tip: full-screen this window first (F11 / ⌃⌘F). In the share dialog pick <b>this tab</b> and keep <b>tab audio</b> on.</span>`);
  const caption = el("div", "demo-caption");
  const cursor = el("div", "demo-cursor");
  const card = el("div", "demo-card");
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const status = (t) => { const s = document.getElementById("demo-status"); if (s) s.textContent = t; };

  function showCard(kind) {
    card.innerHTML = kind === "intro"
      ? `<div class="dc-inner"><span class="dc-dot"></span><h1>Producer Co-pilot</h1><p>AI agents propose. You decide what goes on air.</p>
         <div class="dc-tags"><span>Multi-agent</span><span>Fact-checked</span><span>Live</span></div>
         <small>Microsoft × Premier League · Inside the Game hackathon · synthetic match data</small></div>`
      : `<div class="dc-inner"><span class="dc-dot"></span><h1>Producer Co-pilot</h1><p>AI proposes, every number is checked, you decide.</p>
         <div class="dc-tags"><span>Microsoft Agent Framework</span><span>Microsoft Foundry</span><span>Azure AI Speech</span><span>Azure Container Apps</span></div>
         <small>Try it live: ${location.host}</small></div>`;
    card.classList.add("show");
  }
  const hideCard = () => card.classList.remove("show");

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
  async function pointAt(target, ms = 700) {
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
    for (const ch of text) { input.value += ch; await sleep(35); }
  }
  function scrollToEl(selector, offset = 96) {
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

  async function tour() {
    const t0 = performance.now();
    voicePref = Sound.voice;
    Sound.setVoice(false);                       // the narrator talks; the commentator gets the goal
    window.scrollTo({ top: 0 });
    await control({ action: "reset" });
    await waitFor(() => S.status && S.status.progress === 0 && !S.status.running, 8000);
    await control({ inject_faults: true, speed: 30 });
    setView(true);
    document.querySelector("[data-tab=stats]")?.click();
    document.querySelector("[data-feed=main]")?.click();

    // 1. Title (the match kicks off behind it, so the agents are already at work)
    showCard("intro");
    let goalScene = false;
    const watch = setInterval(() => {               // rest just before the first goal so the goal scene catches it
      if (!goalScene && S.status?.running && S.stats?.t >= PAUSE_BEFORE_GOAL) control({ action: "pause" });
    }, 150);
    S.started = true;
    await control({ action: "start" });
    await say("intro");
    hideCard();

    // 2. The agents get to work
    const agents = say("agents");
    await sleep(2500);
    await scrollToEl(".agents-panel", 380);
    await sleep(4000);
    await scrollToEl(".monitor-panel");
    await agents;

    // 3. Fact Checker
    await waitFor(() => pending().length > 0, 45000);
    const checked = say("check");
    await pointAt(document.querySelector(".card.pending.top .verify"));
    await sleep(1200);
    await click(".card.pending.top details summary");
    await checked;

    // 4. Approve -> on air -> three feeds
    const approved = say("approve");
    await sleep(600);
    await click(".card.pending.top [data-act=approve]");
    await sleep(1800);
    await scrollToEl(".onair-strip", 420);
    await approved;
    await waitFor(() => [...S.suggestions.values()].some((s) => s.status === "approved" && !s.feeds_pending), 10000);
    await click("[data-feed=casual]");
    await sleep(1600);
    await click("[data-feed=club]");
    await sleep(1600);
    await click("[data-feed=main]");

    // 5. Goal: the commentator takes over
    await scrollToEl(".monitor-panel");
    goalScene = true;
    Sound.setVoice(true);
    await control({ speed: 15, action: "start" });
    caption.textContent = "Live commentary: Azure AI Speech neural voice";
    caption.classList.add("show");
    await waitFor(() => S.stats?.t >= GOAL_T + 2, 20000);
    await sleep(6000);
    caption.classList.remove("show");
    Sound.setVoice(false);

    // 6. Ask the Match
    await scrollToEl("#fan-panel");
    const ask = say("ask");
    await typeInto("#ask-input", QUESTION);
    const before = document.querySelectorAll(".answer:not(.pending)").length;
    await click("#ask-btn");
    await ask;
    await waitFor(() => document.querySelectorAll(".answer:not(.pending)").length > before, 30000);
    await sleep(1500);

    // 7. Fan request -> producer queue
    const req = say("request");
    await click(".answer [data-request]");
    await sleep(1500);
    await pointAt([...document.querySelectorAll("#queue .card")].find((c) => c.textContent.includes("Fan request")) || document.querySelector("#queue"));
    await req;

    // 8. Decision Lens
    await scrollToEl(".tabs-panel");
    const lens = say("lens");
    await click("[data-tab=lens]");
    await sleep(2500);
    await pointAt(document.querySelector("#vision-board"));
    await lens;

    // 9. Close
    clearInterval(watch);
    await control({ action: "pause" });
    showCard("outro");
    await say("outro");
    await sleep(1200);
    Sound.setVoice(voicePref);
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
          video: { frameRate: 30, width: { ideal: 1920 }, height: { ideal: 1080 } }, audio: true,
          preferCurrentTab: true, selfBrowserSurface: "include", systemAudio: "include" });
      } catch (_) { busy = false; status("Recording cancelled."); return; }
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
