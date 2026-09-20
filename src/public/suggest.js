// Smart input suggestions — Layer 1 (local, instant, no network) with an
// optional Layer 2 (debounced AI fallback, only when Layer 1 finds nothing).
// Never fires on every keystroke against a backend; local matching is the
// only thing that runs per-keystroke. Attach explicitly per field via
// attachSuggest() — never applied globally, so sensitive fields (access
// codes, passwords) are opted out simply by never being wired up.
(function () {
  "use strict";

  // Master on/off switch (Settings page) — a per-browser convenience
  // preference, not app config, so localStorage is the right place for it
  // (never sent to the server, never shared across devices). Turning it off
  // disables BOTH layers: the input handler below checks this before local
  // matching even runs, so no suggestion of any kind appears and no AI call
  // can happen. Fails open (enabled) if localStorage is unavailable, since
  // that matches this feature's actual prior default (always on).
  const STORAGE_KEY = "wa-smart-suggestions-enabled";
  const hideCallbacks = [];

  function isEnabled() {
    try {
      const v = localStorage.getItem(STORAGE_KEY);
      return v === null ? true : v === "1";
    } catch {
      return true;
    }
  }

  function setEnabled(value) {
    try {
      localStorage.setItem(STORAGE_KEY, value ? "1" : "0");
    } catch {
      // best-effort only
    }
    if (!value) hideCallbacks.forEach((fn) => fn());
  }

  window.smartSuggestions = { isEnabled, setEnabled };

  // Classic Levenshtein edit distance — small inputs only (job titles/role
  // names), so the O(n*m) table is negligible.
  function levenshtein(a, b) {
    const m = a.length, n = b.length;
    if (m === 0) return n;
    if (n === 0) return m;
    const dp = new Array(n + 1);
    for (let j = 0; j <= n; j++) dp[j] = j;
    for (let i = 1; i <= m; i++) {
      let prev = dp[0];
      dp[0] = i;
      for (let j = 1; j <= n; j++) {
        const temp = dp[j];
        dp[j] = a[i - 1] === b[j - 1] ? prev : 1 + Math.min(prev, dp[j], dp[j - 1]);
        prev = temp;
      }
    }
    return dp[n];
  }

  // Best local completion for `raw` out of `dictionary` (display strings).
  // Prefix match wins when one exists ("dev" -> "Developer" — clear intent,
  // no ambiguity). Otherwise falls back to typo-tolerant matching so a
  // near-miss like "Devloper" still resolves to "Developer". Returns null
  // when nothing is close enough to be useful.
  function localMatch(raw, dictionary) {
    const q = raw.trim().toLowerCase();
    if (!q || q.length < 2) return null;

    const prefixHit = dictionary.find((word) => word.toLowerCase().startsWith(q));
    if (prefixHit && prefixHit.toLowerCase() !== q) return prefixHit;

    let best = null;
    let bestDist = Infinity;
    for (const word of dictionary) {
      const w = word.toLowerCase();
      if (w === q) continue;
      if (Math.abs(w.length - q.length) > 3) continue; // cheap pre-filter
      const dist = levenshtein(q, w);
      const threshold = Math.min(3, Math.ceil(Math.max(w.length, q.length) * 0.3));
      if (dist <= threshold && dist < bestDist) {
        best = word;
        bestDist = dist;
      }
    }
    return best;
  }

  // Wires one <input> up to suggestions.
  //   dictionary: string[]              — Layer 1 candidates
  //   aiFallback: async (value) => str  — OPTIONAL Layer 2, called only when
  //                                       Layer 1 finds nothing, and only
  //                                       once the user pauses typing.
  function attachSuggest(input, { dictionary = [], aiFallback = null } = {}) {
    // Wrap the input alone (not the whole .field, which also has the label)
    // so the chip can be positioned relative to just the input's own box.
    const wrap = document.createElement("div");
    wrap.className = "suggest-wrap";
    input.parentNode.insertBefore(wrap, input);
    wrap.appendChild(input);

    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "suggest-chip hidden";
    chip.setAttribute("aria-label", "Accept suggestion");
    wrap.appendChild(chip);

    let current = null;
    let aiTimer = null;
    let requestId = 0;

    function hide() {
      current = null;
      chip.classList.add("hidden");
    }
    hideCallbacks.push(hide);

    // isAi is purely cosmetic (a subtle "✦" vs "↹" prefix, see app.css) —
    // acceptance behaves identically either way, same chip, same keys.
    function offer(suggestion, isAi) {
      if (!suggestion || suggestion.toLowerCase() === input.value.trim().toLowerCase()) {
        hide();
        return;
      }
      current = suggestion;
      chip.textContent = suggestion;
      chip.classList.toggle("ai-suggestion", !!isAi);
      chip.classList.remove("hidden");
    }

    function accept() {
      if (!current) return false;
      input.value = current;
      hide();
      input.dispatchEvent(new Event("input", { bubbles: true }));
      return true;
    }

    // mousedown (not click) so this runs before the input's own blur — a
    // plain click would let blur hide the chip first and swallow the accept.
    chip.addEventListener("mousedown", (e) => {
      e.preventDefault();
      accept();
      input.focus();
    });

    input.addEventListener("keydown", (e) => {
      if (!current) return;
      if (e.key === "Tab") {
        accept(); // don't preventDefault — Tab still moves to the next field
      } else if (e.key === "Enter") {
        e.preventDefault(); // accepting a suggestion must not submit the form
        accept();
      } else if (e.key === "Escape") {
        hide();
      }
    });

    input.addEventListener("input", () => {
      clearTimeout(aiTimer);
      const value = input.value;

      if (!isEnabled() || !value.trim()) {
        hide();
        return;
      }

      // Layer 1 — instant, local, no network call. Unchanged from before.
      const local = localMatch(value, dictionary);
      if (local) {
        offer(local);
        return;
      }
      hide();

      // Layer 2 — OPTIONAL AI fallback. Only reached when Layer 1 found
      // nothing above, and debounced so it fires at most once per typing
      // pause, never per keystroke. requestId guards against a stale
      // response landing after the user has kept typing: if it changes
      // between now and the response coming back, the response is dropped.
      if (!aiFallback || value.trim().length < 3) return;
      const myRequestId = ++requestId;
      aiTimer = setTimeout(async () => {
        try {
          const suggestion = await aiFallback(value);
          if (myRequestId !== requestId) return; // input changed since — stale, discard
          if (suggestion && input.value === value) offer(suggestion, true);
        } catch {
          // Best-effort only — a failed AI fallback just means no suggestion.
        }
      }, 500);
    });

    input.addEventListener("blur", () => {
      // Deferred so a chip mousedown's own accept() still runs first.
      setTimeout(hide, 150);
    });
  }

  window.attachSuggest = attachSuggest;
})();
