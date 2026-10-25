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

  // Opening music for the demo title sequence: an original ~5 s cue. Strings and an airy choir swell
  // over a rising cymbal, a timpani hit with a brass chord as the title lands, then a fade under the narrator.
  function opening() {
    if (!ctx || !enabled) return;
    const t0 = ctx.currentTime + 0.05, HIT = 2.45, END = 6.2;
    const bus = ctx.createGain(); bus.gain.value = 1.4; bus.connect(master);
    const hz = (m) => 440 * Math.pow(2, (m - 69) / 12);
    // Simple hall: a few feedback-free delayed copies.
    [0.045, 0.083, 0.131].forEach((d, i) => { const dl = ctx.createDelay(); dl.delayTime.value = d; const g = ctx.createGain(); g.gain.value = 0.22 - i * 0.05; bus.connect(dl).connect(g).connect(master); });

    function voice(midi, type, from, to, peak, filterFrom, filterTo, detune = 7, formants = null) {
      const g = ctx.createGain(), lp = ctx.createBiquadFilter(); lp.type = "lowpass"; lp.Q.value = 0.8;
      lp.frequency.setValueAtTime(filterFrom, t0 + from); lp.frequency.exponentialRampToValueAtTime(filterTo, t0 + Math.min(to, from + 2.2));
      g.gain.setValueAtTime(0, t0 + from); g.gain.linearRampToValueAtTime(peak, t0 + from + Math.min(1.6, (to - from) * 0.5));
      g.gain.setValueAtTime(peak, t0 + to - 0.6); g.gain.linearRampToValueAtTime(0, t0 + to);
      let out = lp;
      if (formants) { const mix = ctx.createGain(); mix.gain.value = 1; formants.forEach((f) => { const bp = ctx.createBiquadFilter(); bp.type = "bandpass"; bp.frequency.value = f; bp.Q.value = 6; lp.connect(bp).connect(mix); }); out = mix; }
      out.connect(g).connect(bus);
      [-detune, detune].forEach((d) => { const o = ctx.createOscillator(); o.type = type; o.frequency.value = hz(midi); o.detune.value = d; o.connect(lp); o.start(t0 + from); o.stop(t0 + to + 0.05); });
    }
    // Rise: D minor strings + choir
    [50, 57, 62, 65].forEach((m) => voice(m, "sawtooth", 0, HIT + 0.25, 0.028, 250, 2600));
    [74, 77].forEach((m) => voice(m, "sawtooth", 0.4, HIT + 0.3, 0.05, 900, 3000, 9, [800, 1150]));
    // Hit: B-flat major brass-like stab resolving to F major, fading under the narration
    [46, 53, 58, 62, 65].forEach((m) => voice(m, "sawtooth", HIT, HIT + 1.4, 0.05, 2800, 1200, 5));
    [41, 48, 53, 57, 60, 65].forEach((m) => voice(m, "sawtooth", HIT + 1.1, END, 0.032, 1400, 700, 6));
    [72, 77].forEach((m) => voice(m, "triangle", HIT + 1.1, END, 0.03, 3000, 2000, 4, [800, 1150]));
    // Cymbal swell (rising noise) into the hit, and a crash after it
    const sw = ctx.createBufferSource(); sw.buffer = noiseBuffer(HIT + 0.2);
    const swf = ctx.createBiquadFilter(); swf.type = "highpass"; swf.frequency.setValueAtTime(2500, t0); swf.frequency.exponentialRampToValueAtTime(7000, t0 + HIT);
    const swg = ctx.createGain(); swg.gain.setValueAtTime(0.0001, t0); swg.gain.exponentialRampToValueAtTime(0.16, t0 + HIT - 0.02); swg.gain.linearRampToValueAtTime(0, t0 + HIT + 0.05);
    sw.connect(swf).connect(swg).connect(bus); sw.start(t0);
    const cr = ctx.createBufferSource(); cr.buffer = noiseBuffer(2.4);
    const crf = ctx.createBiquadFilter(); crf.type = "highpass"; crf.frequency.value = 3500;
    const crg = ctx.createGain(); crg.gain.setValueAtTime(0.2, t0 + HIT); crg.gain.exponentialRampToValueAtTime(0.0005, t0 + HIT + 2.3);
    cr.connect(crf).connect(crg).connect(bus); cr.start(t0 + HIT);
    // Timpani: a low sine with a falling pitch, plus a soft mallet click
    [0, 0.09].forEach((off, i) => {
      const o = ctx.createOscillator(), g = ctx.createGain(); o.type = "sine";
      o.frequency.setValueAtTime(i ? 58 : 74, t0 + HIT + off); o.frequency.exponentialRampToValueAtTime(40, t0 + HIT + off + 1.2);
      g.gain.setValueAtTime(0, t0 + HIT + off); g.gain.linearRampToValueAtTime(i ? 0.22 : 0.38, t0 + HIT + off + 0.01); g.gain.exponentialRampToValueAtTime(0.001, t0 + HIT + off + 1.5);
      o.connect(g).connect(bus); o.start(t0 + HIT + off); o.stop(t0 + HIT + off + 1.6);
    });
    // Sub boom under the hit, and a low drone that builds during the rise
    const sub = ctx.createOscillator(), sg = ctx.createGain(); sub.type = "sine";
    sub.frequency.setValueAtTime(55, t0 + HIT); sub.frequency.exponentialRampToValueAtTime(28, t0 + HIT + 1.8);
    sg.gain.setValueAtTime(0, t0 + HIT); sg.gain.linearRampToValueAtTime(0.3, t0 + HIT + 0.02); sg.gain.exponentialRampToValueAtTime(0.001, t0 + HIT + 2.2);
    sub.connect(sg).connect(bus); sub.start(t0 + HIT); sub.stop(t0 + HIT + 2.3);
    voice(38, "sawtooth", 0, HIT + 0.1, 0.05, 120, 420, 4);
    // Bell sparkles as the title lands (F major arpeggio, high and soft)
    [[77, 0.15], [81, 0.3], [84, 0.45], [89, 0.62]].forEach(([m, at]) => {
      const o = ctx.createOscillator(), o2 = ctx.createOscillator(), g = ctx.createGain(); o.type = "sine"; o2.type = "sine";
      o.frequency.value = hz(m); o2.frequency.value = hz(m) * 2.76;               // inharmonic partial gives the bell colour
      const t = t0 + HIT + at; g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(0.05, t + 0.01); g.gain.exponentialRampToValueAtTime(0.0005, t + 1.6);
      o.connect(g); o2.connect(g); g.connect(bus); o.start(t); o2.start(t); o.stop(t + 1.7); o2.stop(t + 1.7);
    });
    // Duck the whole cue when the narrator starts (~4.3 s)
    bus.gain.setValueAtTime(1.4, t0 + 4.1); bus.gain.linearRampToValueAtTime(0.45, t0 + 4.7);
  }

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
    setEnabled, setVoice, setRunning, swell, whistle, sting, opening, speak, isSpeaking, route, recordStream,
    setNeural: (on) => { neural = !!on; },
    get neural() { return neural; },
  };
})();
