"use strict";

// Stadium atmosphere synthesised in the browser with the Web Audio API (no audio files),
// plus a commentator voice: Azure AI Speech neural voice when available, browser speech otherwise.
const Sound = (() => {
  const BASE = 0.16;          // crowd murmur level while the match runs
  let ctx = null, master, crowd, crowdTone, enabled = false, voice = true, running = false, lastWhistle = 0;

  const pref = (k, d) => { try { const v = localStorage.getItem(k); return v === null ? d : v === "1"; } catch (_) { return d; } };
  const save = (k, v) => { try { localStorage.setItem(k, v ? "1" : "0"); } catch (_) { /* storage blocked */ } };
  voice = pref("pc_voice", true);

  function noiseBuffer(seconds) {
    const len = Math.floor(ctx.sampleRate * seconds), buf = ctx.createBuffer(2, len, ctx.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch);
      let last = 0;
      for (let i = 0; i < len; i++) { last = (last + 0.02 * (Math.random() * 2 - 1)) / 1.02; d[i] = last * 3.5; }
    }
    return buf;
  }

  function init() {
    if (ctx) return;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    ctx = new AC();
    master = ctx.createGain(); master.gain.value = 0.8; master.connect(ctx.destination);

    // Crowd: looping brown noise through a band-pass, with a slow swaying murmur.
    const src = ctx.createBufferSource(); src.buffer = noiseBuffer(6); src.loop = true;
    crowdTone = ctx.createBiquadFilter(); crowdTone.type = "bandpass"; crowdTone.frequency.value = 650; crowdTone.Q.value = 0.7;
    crowd = ctx.createGain(); crowd.gain.value = 0;
    const lfo = ctx.createOscillator(), lfoGain = ctx.createGain();
    lfo.frequency.value = 0.11; lfoGain.gain.value = 0.035; lfo.connect(lfoGain).connect(crowd.gain);
    src.connect(crowdTone).connect(crowd).connect(master);
    src.start(); lfo.start();
  }

  function level(target, rampS = 1.2) {
    if (!ctx) return;
    const t = ctx.currentTime, g = crowd.gain;
    g.cancelScheduledValues(t); g.setValueAtTime(g.value, t); g.linearRampToValueAtTime(target, t + rampS);
  }

  // Short rise of the crowd (an "ooh" for a chance, a roar for a goal), then back to the murmur.
  function swell(peak, holdS, tone = 1300) {
    if (!ctx || !enabled) return;
    const t = ctx.currentTime, g = crowd.gain, f = crowdTone.frequency;
    g.cancelScheduledValues(t); g.setValueAtTime(g.value, t);
    g.linearRampToValueAtTime(peak, t + 0.25); g.setValueAtTime(peak, t + holdS);
    g.linearRampToValueAtTime(running ? BASE : 0, t + holdS + 2.5);
    f.cancelScheduledValues(t); f.setValueAtTime(f.value, t);
    f.linearRampToValueAtTime(tone, t + 0.25); f.linearRampToValueAtTime(650, t + holdS + 2.5);
  }

  // Referee's pea whistle: two close tones with a fast warble.
  function whistle(pattern = [0.25]) {
    if (!ctx || !enabled) return;
    const now = ctx.currentTime;
    if (now - lastWhistle < 1) return;
    lastWhistle = now;
    let t = now + 0.02;
    pattern.forEach((dur) => {
      const g = ctx.createGain(), trem = ctx.createOscillator(), tremGain = ctx.createGain();
      g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(0.09, t + 0.03);
      g.gain.setValueAtTime(0.09, t + dur - 0.05); g.gain.linearRampToValueAtTime(0, t + dur);
      trem.frequency.value = 32; tremGain.gain.value = 0.035; trem.connect(tremGain).connect(g.gain);
      [2850, 3020].forEach((hz) => { const o = ctx.createOscillator(); o.frequency.value = hz; o.connect(g); o.start(t); o.stop(t + dur); });
      trem.start(t); trem.stop(t + dur);
      g.connect(master);
      t += dur + 0.18;
    });
  }

  // Broadcast "on air" sting: a filtered whoosh and a two-note chime.
  function sting() {
    if (!ctx || !enabled) return;
    const t = ctx.currentTime;
    const n = ctx.createBufferSource(); n.buffer = noiseBuffer(0.6);
    const hp = ctx.createBiquadFilter(); hp.type = "bandpass"; hp.Q.value = 1.2;
    hp.frequency.setValueAtTime(400, t); hp.frequency.exponentialRampToValueAtTime(5000, t + 0.45);
    const ng = ctx.createGain(); ng.gain.setValueAtTime(0, t); ng.gain.linearRampToValueAtTime(0.25, t + 0.2); ng.gain.linearRampToValueAtTime(0, t + 0.5);
    n.connect(hp).connect(ng).connect(master); n.start(t);
    [[880, 0.35], [1320, 0.47]].forEach(([hz, at]) => {
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.type = "triangle"; o.frequency.value = hz;
      g.gain.setValueAtTime(0, t + at); g.gain.linearRampToValueAtTime(0.12, t + at + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, t + at + 0.6);
      o.connect(g).connect(master); o.start(t + at); o.stop(t + at + 0.65);
    });
  }

  // Keynote-style music bed for the demo opening and closing (original): a warm Dmaj9 pad, a light
  // plucked arpeggio with a soft pulse, a whoosh into the product reveal and a soft impact with shimmer.
  // It sits under the narrator.
  function keynote({ len, impact, level = 1 }) {
    if (!ctx || !enabled) return;
    const t0 = ctx.currentTime + 0.05, hz = (m) => 440 * Math.pow(2, (m - 69) / 12);
    const bus = ctx.createGain(); bus.connect(master);
    bus.gain.setValueAtTime(0.0001, t0); bus.gain.exponentialRampToValueAtTime(level, t0 + 0.6);
    bus.gain.setValueAtTime(level, t0 + len - 1.6); bus.gain.exponentialRampToValueAtTime(0.0001, t0 + len);
    const ir = ctx.createBuffer(2, ctx.sampleRate * 2.4, ctx.sampleRate);
    for (let c = 0; c < 2; c++) { const d = ir.getChannelData(c); for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / d.length, 2.6); }
    const verb = ctx.createConvolver(); verb.buffer = ir; const wet = ctx.createGain(); wet.gain.value = 0.5; bus.connect(verb).connect(wet).connect(master);
    // pad: Dmaj9 voiced warm and wide
    [38, 50, 57, 61, 64, 66, 69].forEach((m, i) => {
      const lp = ctx.createBiquadFilter(), g = ctx.createGain(); lp.type = "lowpass"; lp.Q.value = 0.5;
      lp.frequency.setValueAtTime(500, t0); lp.frequency.exponentialRampToValueAtTime(2200, t0 + impact + 0.4);
      g.gain.setValueAtTime(0.0001, t0); g.gain.exponentialRampToValueAtTime(i ? 0.018 : 0.03, t0 + 1.8); g.gain.setValueAtTime(i ? 0.018 : 0.03, t0 + len - 1.5); g.gain.exponentialRampToValueAtTime(0.0001, t0 + len);
      [-6, 6].forEach((d) => { const o = ctx.createOscillator(); o.type = i === 0 ? "sine" : "sawtooth"; o.frequency.value = hz(m); o.detune.value = d; o.connect(lp); o.start(t0); o.stop(t0 + len + 0.1); });
      lp.connect(g).connect(bus);
    });
    // plucked arpeggio (eighths at 112 bpm) and a soft pulse on each beat, both rising in level
    const step = 60 / 112 / 2, arp = [62, 66, 69, 73, 76, 73, 69, 66];
    for (let i = 0, t = 0.25; t < len - 1.2; i++, t += step) {
      const k = Math.min(1, t / impact), o = ctx.createOscillator(), g = ctx.createGain(); o.type = "triangle"; o.frequency.value = hz(arp[i % 8] + (t > impact ? 12 : 0));
      g.gain.setValueAtTime(0.0001, t0 + t); g.gain.exponentialRampToValueAtTime(0.012 + 0.02 * k, t0 + t + 0.005); g.gain.exponentialRampToValueAtTime(0.0001, t0 + t + 0.32);
      o.connect(g).connect(bus); o.start(t0 + t); o.stop(t0 + t + 0.35);
      if (i % 2 === 0) { const p = ctx.createOscillator(), pg = ctx.createGain(); p.type = "sine";
        p.frequency.setValueAtTime(70, t0 + t); p.frequency.exponentialRampToValueAtTime(42, t0 + t + 0.18);
        pg.gain.setValueAtTime(0.0001, t0 + t); pg.gain.exponentialRampToValueAtTime(0.03 + 0.07 * k, t0 + t + 0.005); pg.gain.exponentialRampToValueAtTime(0.0001, t0 + t + 0.25);
        p.connect(pg).connect(bus); p.start(t0 + t); p.stop(t0 + t + 0.3); }
    }
    // whoosh into the reveal, then a soft impact with a shimmer
    const w = ctx.createBufferSource(); w.buffer = noiseBuffer(1.4); const wf = ctx.createBiquadFilter(); wf.type = "bandpass"; wf.Q.value = 1.4;
    wf.frequency.setValueAtTime(300, t0 + impact - 1.1); wf.frequency.exponentialRampToValueAtTime(6000, t0 + impact);
    const wg = ctx.createGain(); wg.gain.setValueAtTime(0.0001, t0 + impact - 1.1); wg.gain.exponentialRampToValueAtTime(0.09, t0 + impact - 0.03); wg.gain.exponentialRampToValueAtTime(0.0001, t0 + impact + 0.35);
    w.connect(wf).connect(wg).connect(bus); w.start(t0 + impact - 1.1);
    const b = ctx.createOscillator(), bg = ctx.createGain(); b.type = "sine";
    b.frequency.setValueAtTime(64, t0 + impact); b.frequency.exponentialRampToValueAtTime(36, t0 + impact + 0.9);
    bg.gain.setValueAtTime(0.0001, t0 + impact); bg.gain.exponentialRampToValueAtTime(0.32, t0 + impact + 0.01); bg.gain.exponentialRampToValueAtTime(0.0001, t0 + impact + 1.2);
    b.connect(bg).connect(bus); b.start(t0 + impact); b.stop(t0 + impact + 1.3);
    [86, 90, 93, 98].forEach((m, i) => { const o = ctx.createOscillator(), g = ctx.createGain(); o.type = "sine"; o.frequency.value = hz(m); const t = t0 + impact + i * 0.07;
      g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.02, t + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, t + 1.6);
      o.connect(g).connect(bus); o.start(t); o.stop(t + 1.7); });
  }
  const opening = () => keynote({ len: 9.5, impact: 3.0, level: 1.1 });
  const outro = () => keynote({ len: 8.5, impact: 0.75, level: 1.0 });

  let chosenVoice = null;
  function pickVoice() {
    const voices = window.speechSynthesis.getVoices();
    const prefer = ["Google UK English Male", "Daniel", "Microsoft Ryan", "Microsoft George", "Arthur", "Oliver", "Google UK English Female"];
    chosenVoice = prefer.map((n) => voices.find((v) => v.name.includes(n))).find(Boolean)
      || voices.find((v) => v.lang === "en-GB") || voices.find((v) => v.lang.startsWith("en")) || null;
  }
  if ("speechSynthesis" in window) { pickVoice(); window.speechSynthesis.onvoiceschanged = pickVoice; }

  // Neural voice (Azure AI Speech via /api/tts) when the server has it, the browser's voice otherwise.
  let neural = false, failures = 0, current = null, inflight = null;
  const clean = (t) => t.replace(/\bxG\b/g, "expected goals").replace(/\bkm\/h\b/g, "kilometres per hour");

  function isSpeaking() {
    const synth = window.speechSynthesis;
    return !!inflight || !!(current && !current.ended && !current.paused) || !!(synth && (synth.speaking || synth.pending));
  }

  function stopVoice() {
    inflight?.abort(); inflight = null;
    if (current) { current.pause(); current = null; }
    if ("speechSynthesis" in window) window.speechSynthesis.cancel();
  }

  // level: 0 colour, 1 play-by-play, 2 big chance, 3 goal
  async function speak(text, opts = {}) {
    if (!enabled || !voice || !text) return;
    const level = opts.level ?? 1;
    if (isSpeaking()) { if (!opts.interrupt) return; stopVoice(); }
    const asked = performance.now();
    if (neural && failures < 3) {
      const ctrl = new AbortController();
      inflight = ctrl;
      try {
        const res = await fetch("/api/tts", { method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text: clean(text), level }), signal: ctrl.signal });
        if (!res.ok) throw Object.assign(new Error("tts"), { status: res.status });
        const url = URL.createObjectURL(await res.blob());
        if (inflight !== ctrl) { URL.revokeObjectURL(url); return; }
        inflight = null;
        // A line that arrives late describes a moment that has passed: skip it, except big moments.
        if (!opts.interrupt && performance.now() - asked > 1500) { URL.revokeObjectURL(url); return; }
        const a = new Audio(url);
        a.volume = 1;
        route(a);
        current = a;
        a.onended = a.onerror = () => { URL.revokeObjectURL(url); if (current === a) current = null; };
        await a.play();
        return;
      } catch (err) {
        if (err.name === "AbortError") return;
        if (inflight === ctrl) inflight = null;
        if (err.status !== 429) failures++;
      }
    }
    if (!("speechSynthesis" in window)) return;
    const u = new SpeechSynthesisUtterance(clean(text));
    if (!chosenVoice) pickVoice();
    u.voice = chosenVoice; u.lang = chosenVoice?.lang || "en-GB";
    const ex = level >= 3 ? 2 : level === 2 ? 1 : 0;
    u.rate = [1.08, 1.16, 1.22][ex]; u.pitch = [1, 1.08, 1.18][ex]; u.volume = 1;
    window.speechSynthesis.speak(u);
  }

  // Voices play through the same graph as the crowd, so a recording can take one clean mix.
  function route(audioEl) {
    if (!ctx) return;
    try { ctx.createMediaElementSource(audioEl).connect(master); } catch (_) { /* plays directly */ }
  }

  let recDest = null;
  function recordStream() {
    init();
    if (!ctx) return null;
    if (!recDest) { recDest = ctx.createMediaStreamDestination(); master.connect(recDest); }
    ctx.resume();
    return recDest.stream;
  }

  function setRunning(isRunning, finished = false) {
    if (running && !isRunning && !finished) stopVoice();  // pause silences the commentator; the full-time call plays out
    running = isRunning;
    if (enabled) level(isRunning ? BASE : 0, isRunning ? 2 : 0.8);
  }

  function setEnabled(on) {
    enabled = on;
    save("pc_sound", on);
    if (on) { init(); ctx?.resume(); level(running ? BASE : 0, 1.5); }
    else { level(0, 0.4); stopVoice(); }
  }

  function setVoice(on) { voice = on; save("pc_voice", on); if (!on) stopVoice(); }

  return {
    get enabled() { return enabled; },
    get voice() { return voice; },
    wantedByDefault: () => pref("pc_sound", true),
    setEnabled, setVoice, setRunning, swell, whistle, sting, opening, outro, speak, isSpeaking, route, recordStream,
    setNeural: (on) => { neural = !!on; },
    get neural() { return neural; },
  };
})();
