"use strict";

// Fan app: Ask the Match. Questions go to a tool-using agent; answers are fact-checked against the
// live match, and a verified answer can be sent to the producer as an on-screen request.
(() => {
  const list = $("answers");
  let busy = false;

  function card(q) {
    const li = document.createElement("li");
    li.className = "answer pending";
    li.innerHTML = `<p class="q">${esc(q)}</p><p class="a"><span class="spinner" aria-hidden="true"></span> Checking the match data…</p>`;
    list.prepend(li);
    while (list.children.length > 8) list.lastChild.remove();
    return li;
  }

  const TOOL_LABEL = {
    match_overview: () => "match overview",
    events_between: (a) => `events ${a.from_minute}'–${a.to_minute}'`,
    player_report: (a) => `player: ${a.player}`,
    team_report: (a) => `team: ${a.team}`,
    decision_lens: () => "Decision Lens",
  };

  function fill(li, r) {
    li.classList.remove("pending");
    const looked = [...new Set(r.tools.map((t) => (TOOL_LABEL[t.tool] || (() => t.tool))(t.args || {})))].join(" · ");
    const by = r.source === "llm" ? "AI agent (tools)" : "match data (no model)";
    li.innerHTML = `<p class="q">${esc(r.question)} <span class="muted small">at ${r.minute}'</span></p>
      <p class="a">${esc(r.answer)}</p>
      <div class="meta">
        <span class="${r.verified ? "ok" : "warn"}">${r.verified ? "✓ Every number checked against the match" : "Answer could not be fully verified"}</span>
        <span class="muted small">Looked up: ${esc(looked || "nothing")} · ${by}</span>
      </div>
      ${r.verified ? `<button class="btn ghost small-btn" type="button" data-request="${r.id}">📺 Request this on screen</button>` : ""}`;
  }

  async function ask(q) {
    q = q.trim();
    if (!q || busy) return;
    busy = true;
    $("ask-btn").disabled = true;
    const li = card(q);
    try {
      fill(li, await api("/api/ask", { question: q }));
    } catch (err) {
      li.classList.remove("pending");
      li.querySelector(".a").textContent = err.status === 429 ? "Easy there! Too many questions this minute." : "Could not answer right now. Try again.";
    } finally {
      busy = false;
      $("ask-btn").disabled = false;
    }
  }

  $("ask-form").addEventListener("submit", (ev) => {
    ev.preventDefault();
    ev.stopImmediatePropagation();  // keep the producer's edit-form handler out of this
    const q = $("ask-input").value;
    $("ask-input").value = "";
    ask(q);
  }, true);

  $("fan-panel").addEventListener("click", async (ev) => {
    const chip = ev.target.closest(".chip-q");
    if (chip) return ask(chip.textContent);
    const req = ev.target.closest("[data-request]");
    if (!req) return;
    req.disabled = true;
    try {
      await api(`/api/ask/${req.dataset.request}/request`, {});
      req.textContent = "✓ Sent to the producer's queue";
      req.classList.add("sent");
      toast("Fan request sent: the producer decides if it goes on air.");
    } catch (_) {
      req.disabled = false;
      toast("Could not send the request.", true);
    }
  });
})();
