(function () {
  "use strict";

  const el = (id) => document.getElementById(id);
  const qs = (sel, root) => (root || document).querySelector(sel);
  const qsa = (sel, root) => Array.from((root || document).querySelectorAll(sel));

  function escapeHtml(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => (
      { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
    ));
  }

  const views = {
    loading: el("view-loading"),
    login: el("view-login"),
    wizard: el("view-wizard"),
    connecting: el("view-connecting"),
    shell: el("view-shell"),
  };

  function showView(name) {
    for (const key in views) views[key].classList.toggle("hidden", key !== name);
  }

  // "wizard" | "login" | "connecting" | "shell" — decides how a fresh
  // authenticated status payload (from the initial fetch or the SSE stream)
  // gets routed: the wizard manages its own connect sub-pane, everything
  // else reacts to connection status directly (mirrors the original app's
  // single always-applied qr<->dashboard toggle).
  let appPhase = "loading";
  let lastStatusData = null;

  // ------------------------------------------------------------------
  // Availability <-> IN/OUT UI mapping. Backend keeps AVAILABLE/UNAVAILABLE
  // (see config.js) — IN/OUT is presentation-only, per the redesign brief.
  // AVAILABLE = owner is IN handling contacts personally (AI silent).
  // UNAVAILABLE = owner is OUT, AI is active for contacts.
  // ------------------------------------------------------------------
  function availabilityLabel(v) { return v === "AVAILABLE" ? "IN" : "OUT"; }
  function autoRepliesLabel(v) { return v === "AVAILABLE" ? "OFF" : "ON"; }

  // ------------------------------------------------------------------
  // Optional schedule-profile fields shared by the wizard's step 2 and the
  // dashboard's Schedule page (same field set, ids differ only by prefix).
  // ------------------------------------------------------------------
  function collectScheduleProfile(prefix) {
    const workingDays = qsa(`.${prefix}WorkingDay:checked`).map((cb) => cb.value);
    return {
      profession: el(`${prefix}Profession`).value.trim(),
      workplace: el(`${prefix}Workplace`).value.trim(),
      location: el(`${prefix}Location`).value.trim(),
      workingDays,
      workingHoursStart: el(`${prefix}WorkingHoursStart`).value,
      workingHoursEnd: el(`${prefix}WorkingHoursEnd`).value,
      breakStart: el(`${prefix}BreakStart`).value,
      breakEnd: el(`${prefix}BreakEnd`).value,
      preferredStart: el(`${prefix}PreferredStart`).value,
      preferredEnd: el(`${prefix}PreferredEnd`).value,
      notes: el(`${prefix}ScheduleNotes`).value.trim(),
    };
  }

  function fillScheduleProfile(prefix, data) {
    const p = data || {};
    el(`${prefix}Profession`).value = p.profession || "";
    el(`${prefix}Workplace`).value = p.workplace || "";
    el(`${prefix}Location`).value = p.location || "";
    qsa(`.${prefix}WorkingDay`).forEach((cb) => {
      cb.checked = Array.isArray(p.workingDays) && p.workingDays.includes(cb.value);
    });
    el(`${prefix}WorkingHoursStart`).value = p.workingHoursStart || "";
    el(`${prefix}WorkingHoursEnd`).value = p.workingHoursEnd || "";
    el(`${prefix}BreakStart`).value = p.breakStart || "";
    el(`${prefix}BreakEnd`).value = p.breakEnd || "";
    el(`${prefix}PreferredStart`).value = p.preferredStart || "";
    el(`${prefix}PreferredEnd`).value = p.preferredEnd || "";
    el(`${prefix}ScheduleNotes`).value = p.notes || "";
  }

  el("setupScheduleEnabled").addEventListener("change", () => {
    el("setupScheduleFields").classList.toggle("hidden", !el("setupScheduleEnabled").checked);
  });
  el("dashScheduleEnabled").addEventListener("change", () => {
    el("dashScheduleFields").classList.toggle("hidden", !el("dashScheduleEnabled").checked);
  });

  // ------------------------------------------------------------------
  // Toast
  // ------------------------------------------------------------------
  let toastTimer = null;
  function toast(msg) {
    const t = el("toast");
    t.textContent = msg;
    t.classList.remove("hidden");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.add("hidden"), 2200);
  }

  // ==================================================================
  // LOGIN (returning, already-configured owner)
  // ==================================================================
  el("loginForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    el("loginError").classList.add("hidden");
    el("loginSubmit").disabled = true;
    try {
      const res = await fetch("/api/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: el("accessCode").value }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error || "Invalid access code.");
      el("accessCode").value = "";
      connectEvents();
      const statusRes = await fetch("/api/status");
      const statusData = await statusRes.json();
      if (statusData.authenticated) {
        lastStatusData = statusData;
        routeAuthenticatedStatus(statusData);
      }
    } catch (err) {
      el("loginError").textContent = err.message || "Invalid access code.";
      el("loginError").classList.remove("hidden");
    } finally {
      el("loginSubmit").disabled = false;
    }
  });

  // ==================================================================
  // SETUP WIZARD
  // ==================================================================
  let wizardDetails = null; // { ownerName, assistantName, role, instructions }
  let wizardSystemPrompt = "";
  let wizardScheduleEnabled = false;
  let wizardScheduleProfile = null;
  let currentWizardStep = 1;
  let isTraining = false;

  function setStepper(step) {
    currentWizardStep = step;
    qsa(".stepper .step").forEach((node) => {
      const n = Number(node.dataset.step);
      node.classList.toggle("done", n < step);
      node.classList.toggle("active", n === step);
    });
    ["wizStep1", "wizStep2", "wizStep3", "wizStep4"].forEach((id, idx) => {
      el(id).classList.toggle("hidden", idx + 1 !== step);
    });
  }

  function enterWizard() {
    appPhase = "wizard";
    showView("wizard");
    setStepper(1);
    el("wizDetailsPane").classList.remove("hidden");
    el("wizPromptPane").classList.add("hidden");
  }

  el("setupForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    if (isTraining) return;
    isTraining = true;
    el("setupError").classList.add("hidden");
    el("setupSubmit").disabled = true;
    el("setupSubmit").textContent = "Training your assistant…";

    wizardDetails = {
      ownerName: el("ownerName").value.trim(),
      assistantName: el("assistantName").value.trim(),
      role: el("role").value.trim(),
      instructions: el("instructions").value.trim(),
    };

    try {
      const res = await fetch("/api/generate-prompt", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(wizardDetails),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error || "Training failed.");
      el("promptText").value = data.prompt;
      el("promptText").setAttribute("readonly", "readonly");
      el("btnEditToggle").textContent = "Edit prompt";
      el("wizDetailsPane").classList.add("hidden");
      el("wizPromptPane").classList.remove("hidden");
    } catch (err) {
      el("setupError").textContent = err.message || "Could not train the assistant. Please try again.";
      el("setupError").classList.remove("hidden");
    } finally {
      isTraining = false;
      el("setupSubmit").disabled = false;
      el("setupSubmit").textContent = "Continue";
    }
  });

  el("btnEditToggle").addEventListener("click", () => {
    const isReadonly = el("promptText").hasAttribute("readonly");
    if (isReadonly) {
      el("promptText").removeAttribute("readonly");
      el("promptText").focus();
      el("btnEditToggle").textContent = "Lock prompt";
    } else {
      el("promptText").setAttribute("readonly", "readonly");
      el("btnEditToggle").textContent = "Edit prompt";
    }
  });

  el("btnRegenerate").addEventListener("click", async () => {
    if (!wizardDetails) return;
    el("promptError").classList.add("hidden");
    el("btnRegenerate").disabled = true;
    el("btnRegenerate").textContent = "Regenerating…";
    try {
      const res = await fetch("/api/generate-prompt", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(wizardDetails),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error || "Prompt generation failed.");
      el("promptText").value = data.prompt;
    } catch (err) {
      el("promptError").textContent = err.message || "Could not regenerate the prompt.";
      el("promptError").classList.remove("hidden");
    } finally {
      el("btnRegenerate").disabled = false;
      el("btnRegenerate").textContent = "Regenerate";
    }
  });

  el("btnPromptContinue").addEventListener("click", () => {
    const systemPrompt = el("promptText").value.trim();
    if (!systemPrompt) {
      el("promptError").textContent = "Prompt can't be empty.";
      el("promptError").classList.remove("hidden");
      return;
    }
    wizardSystemPrompt = systemPrompt;
    setStepper(2);
  });

  el("btnStep2Back").addEventListener("click", () => {
    setStepper(1);
    el("wizDetailsPane").classList.add("hidden");
    el("wizPromptPane").classList.remove("hidden");
  });

  el("btnStep2Continue").addEventListener("click", async () => {
    el("scheduleWizardError").classList.add("hidden");
    el("btnStep2Continue").disabled = true;
    wizardScheduleEnabled = el("setupScheduleEnabled").checked;
    wizardScheduleProfile = collectScheduleProfile("setup");

    try {
      const res = await fetch("/api/confirm-setup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...wizardDetails,
          systemPrompt: wizardSystemPrompt,
          scheduleEnabled: wizardScheduleEnabled,
          scheduleProfile: wizardScheduleProfile,
        }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error || "Could not save setup.");
      setStepper(3);
      el("wizConnectAuthPane").classList.remove("hidden");
      el("wizConnectQrPane").classList.add("hidden");
    } catch (err) {
      el("scheduleWizardError").textContent = err.message || "Could not save setup. Please try again.";
      el("scheduleWizardError").classList.remove("hidden");
    } finally {
      el("btnStep2Continue").disabled = false;
    }
  });

  el("wizVerifyForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    el("wizVerifyError").classList.add("hidden");
    el("wizVerifySubmit").disabled = true;
    try {
      const res = await fetch("/api/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: el("wizAccessCode").value }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error || "Invalid access code.");
      el("wizAccessCode").value = "";
      el("wizConnectAuthPane").classList.add("hidden");
      el("wizConnectQrPane").classList.remove("hidden");
      connectEvents();
      const statusRes = await fetch("/api/status");
      const statusData = await statusRes.json();
      if (statusData.authenticated) {
        lastStatusData = statusData;
        updateWizardConnect(statusData);
      }
    } catch (err) {
      el("wizVerifyError").textContent = err.message || "Invalid access code.";
      el("wizVerifyError").classList.remove("hidden");
    } finally {
      el("wizVerifySubmit").disabled = false;
    }
  });

  function updateWizardConnect(data) {
    if (currentWizardStep !== 3) return;
    if (el("wizConnectQrPane").classList.contains("hidden")) return;

    const pill = el("wizConnectStatus");
    const continueBtn = el("btnStep3Continue");

    if (data.status === "connected") {
      pill.innerHTML = '<span class="dot green"></span><span>Connected</span>';
      continueBtn.disabled = false;
    } else if (data.status === "qr") {
      pill.innerHTML = '<span class="dot amber"></span><span>Waiting for scan…</span>';
      continueBtn.disabled = true;
      if (data.qrDataUrl) {
        el("wizQrImg").src = data.qrDataUrl;
        el("wizQrImg").classList.remove("hidden");
        el("wizQrPlaceholder").classList.add("hidden");
      }
    } else if (data.status === "reconnecting") {
      pill.innerHTML = '<span class="dot amber"></span><span>Reconnecting…</span>';
      continueBtn.disabled = true;
    } else {
      pill.innerHTML = '<span class="dot amber"></span><span>Starting WhatsApp connection…</span>';
      continueBtn.disabled = true;
    }
  }

  el("btnStep3Continue").addEventListener("click", () => {
    renderWizardSummary();
    setStepper(4);
  });

  el("btnStep4Back").addEventListener("click", () => setStepper(3));

  function renderWizardSummary() {
    const p = (lastStatusData && lastStatusData.profile) || {};
    const rows = [
      ["Name", wizardDetails ? wizardDetails.ownerName : p.name],
      ["Assistant name", wizardDetails ? wizardDetails.assistantName : p.assistantName],
      ["Role", wizardDetails ? wizardDetails.role : p.role],
      ["Schedule", wizardScheduleEnabled ? "Enabled" : "Not configured"],
      ["WhatsApp", lastStatusData && lastStatusData.status === "connected" ? "Connected" : "Connecting…"],
    ];
    if (wizardScheduleEnabled && wizardScheduleProfile) {
      if (wizardScheduleProfile.workingDays.length) rows.push(["Working days", wizardScheduleProfile.workingDays.join(", ")]);
      if (wizardScheduleProfile.workingHoursStart && wizardScheduleProfile.workingHoursEnd) {
        rows.push(["Working hours", `${wizardScheduleProfile.workingHoursStart} – ${wizardScheduleProfile.workingHoursEnd}`]);
      }
      if (wizardScheduleProfile.location) rows.push(["Location", wizardScheduleProfile.location]);
    }
    el("wizSummaryList").innerHTML = rows
      .filter(([, v]) => v)
      .map(([k, v]) => `<div class="summary-row"><span class="k">${escapeHtml(k)}</span><span class="v">${escapeHtml(v)}</span></div>`)
      .join("");
  }

  el("btnFinish").addEventListener("click", () => {
    if (lastStatusData) enterShell(lastStatusData);
  });

  // ==================================================================
  // STANDALONE CONNECTING VIEW (returning owner, WhatsApp not connected)
  // ==================================================================
  function enterConnecting(data) {
    appPhase = "connecting";
    showView("connecting");
    renderConnecting(data);
  }

  function renderConnecting(data) {
    const pill = el("connStatusPill");
    const text = el("connStatusText");
    if (data.status === "qr") {
      pill.querySelector(".dot").className = "dot amber";
      text.textContent = "Waiting for WhatsApp scan…";
      if (data.qrDataUrl) {
        el("qrImg").src = data.qrDataUrl;
        el("qrImg").classList.remove("hidden");
        el("qrPlaceholder").classList.add("hidden");
      }
    } else if (data.status === "reconnecting") {
      pill.querySelector(".dot").className = "dot amber";
      text.textContent = "Reconnecting to WhatsApp…";
      el("qrImg").classList.add("hidden");
      el("qrPlaceholder").classList.remove("hidden");
      el("qrPlaceholder").textContent = "Reconnecting…";
    } else if (data.status === "logged_out") {
      pill.querySelector(".dot").className = "dot red";
      text.textContent = "Session expired — generating a new QR code…";
      el("qrImg").classList.add("hidden");
      el("qrPlaceholder").classList.remove("hidden");
      el("qrPlaceholder").textContent = "Please wait…";
    } else {
      pill.querySelector(".dot").className = "dot amber";
      text.textContent = "Starting WhatsApp connection…";
    }
  }

  // ==================================================================
  // APP SHELL
  // ==================================================================
  const PAGES = ["dashboard", "profile", "schedule", "whatsapp", "commands", "settings"];
  let commandsLoaded = false;

  function showPage(name) {
    PAGES.forEach((p) => el(`page-${p}`).classList.toggle("hidden", p !== name));
    qsa(".nav-item[data-page]").forEach((btn) => btn.classList.toggle("active", btn.dataset.page === name));
    closeDrawer();
    if (name === "commands" && !commandsLoaded) loadCommands();
  }

  qsa(".nav-item[data-page]").forEach((btn) => btn.addEventListener("click", () => showPage(btn.dataset.page)));
  qsa(".quick-action[data-goto]").forEach((btn) => btn.addEventListener("click", () => showPage(btn.dataset.goto)));

  function enterShell(data) {
    appPhase = "shell";
    showView("shell");
    if (!qs(".nav-item.active")) showPage("dashboard");
    renderShell(data);
  }

  function renderShell(data) {
    const p = data.profile || {};

    // --- Dashboard ---
    el("dashGreeting").innerHTML = `Good to see you, ${escapeHtml(p.name || "there")}! <span class="wave">👋</span>`;
    el("userInitial").textContent = (p.name || "A").trim().charAt(0).toUpperCase();

    const connected = data.status === "connected";
    el("waConnLine").innerHTML = connected
      ? '<span class="dot green" style="display:inline-block;margin-right:6px;"></span>Connected'
      : '<span class="dot amber" style="display:inline-block;margin-right:6px;"></span>Reconnecting…';
    el("waLastConnected").textContent = data.connectedAt
      ? `Last connected: ${new Date(data.connectedAt).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })}`
      : "Last connected: —";

    el("availStateLine").textContent = availabilityLabel(p.availability);
    el("availSubLine").textContent = `Auto-replies: ${autoRepliesLabel(p.availability)}`;
    el("btnSetIn").className = p.availability === "AVAILABLE" ? "btn" : "btn secondary";
    el("btnSetOut").className = p.availability === "UNAVAILABLE" ? "btn" : "btn secondary";

    if (p.scheduleEnabled && data.scheduleSnapshot) {
      const s = data.scheduleSnapshot;
      el("overviewEnabled").classList.remove("hidden");
      el("overviewDisabled").classList.add("hidden");
      el("ovWorkingDay").textContent = s.isWorkingDay === null ? "—" : s.isWorkingDay ? "Yes" : "No";
      el("ovWorkingHours").textContent = s.workingHoursLabel || "—";
      const statusLabel = { working: "Working", break: "On a break", off: "Off" }[s.currentStatus] || "—";
      el("ovCurrentStatus").textContent = s.onBreak && s.breakUntilLabel ? `${statusLabel} (until ${s.breakUntilLabel})` : statusLabel;
      el("ovNextChange").textContent = s.nextChangeLabel || "—";
    } else {
      el("overviewEnabled").classList.add("hidden");
      el("overviewDisabled").classList.remove("hidden");
    }

    // --- Profile page ---
    el("profOwnerName").value = p.name || "";
    el("profRole").value = p.role || "";
    if (document.activeElement !== el("dashAssistantName")) el("dashAssistantName").value = p.assistantName || "";

    // --- Schedule page ---
    const scheduleFocused = el("dashScheduleFields").contains(document.activeElement) || document.activeElement === el("dashScheduleEnabled");
    if (!scheduleFocused) {
      el("dashScheduleEnabled").checked = !!p.scheduleEnabled;
      el("dashScheduleFields").classList.toggle("hidden", !p.scheduleEnabled);
      fillScheduleProfile("dash", p.scheduleProfile);
    }

    // --- WhatsApp page ---
    el("waPageConnected").classList.toggle("hidden", !connected);
    el("waPageNotConnected").classList.toggle("hidden", connected);
    el("waPageLastConnected").textContent = data.connectedAt
      ? `Last connected: ${new Date(data.connectedAt).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })}`
      : "Last connected: —";
    if (!connected) {
      el("waPageStatusText").textContent = data.status === "qr" ? "Waiting for scan…" : "Reconnecting…";
      if (data.qrDataUrl) {
        el("waPageQrImg").src = data.qrDataUrl;
        el("waPageQrImg").classList.remove("hidden");
        el("waPageQrPlaceholder").classList.add("hidden");
      }
    }

    // --- Settings page ---
    el("settingsOwnerName").textContent = p.name || "—";
    el("settingsAssistantName").textContent = p.assistantName || "—";
  }

  // Dashboard: IN / OUT controls — call the real /api/availability endpoint,
  // never a frontend-only state (backend is authoritative; see config.js).
  async function setAvailability(value) {
    el("btnSetIn").className = value === "AVAILABLE" ? "btn" : "btn secondary";
    el("btnSetOut").className = value === "UNAVAILABLE" ? "btn" : "btn secondary";
    el("availStateLine").textContent = availabilityLabel(value);
    el("availSubLine").textContent = `Auto-replies: ${autoRepliesLabel(value)}`;
    if (lastStatusData && lastStatusData.profile) lastStatusData.profile.availability = value;
    await fetch("/api/availability", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ availability: value }),
    });
  }
  el("btnSetIn").addEventListener("click", () => setAvailability("AVAILABLE"));
  el("btnSetOut").addEventListener("click", () => setAvailability("UNAVAILABLE"));

  el("btnSaveAssistantName").addEventListener("click", async () => {
    el("assistantNameError").classList.add("hidden");
    const assistantName = el("dashAssistantName").value.trim();
    if (!assistantName) {
      el("assistantNameError").textContent = "Assistant name can't be empty.";
      el("assistantNameError").classList.remove("hidden");
      return;
    }
    el("btnSaveAssistantName").disabled = true;
    try {
      const res = await fetch("/api/assistant-name", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ assistantName }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error || "Could not save the assistant name.");
      toast("Assistant name saved.");
    } catch (err) {
      el("assistantNameError").textContent = err.message || "Could not save the assistant name.";
      el("assistantNameError").classList.remove("hidden");
    } finally {
      el("btnSaveAssistantName").disabled = false;
    }
  });

  el("btnSaveSchedule").addEventListener("click", async () => {
    el("scheduleError").classList.add("hidden");
    el("btnSaveSchedule").disabled = true;
    try {
      const res = await fetch("/api/schedule-profile", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          scheduleEnabled: el("dashScheduleEnabled").checked,
          scheduleProfile: collectScheduleProfile("dash"),
        }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error || "Could not save schedule profile.");
      toast("Schedule profile saved.");
    } catch (err) {
      el("scheduleError").textContent = err.message || "Could not save schedule profile.";
      el("scheduleError").classList.remove("hidden");
    } finally {
      el("btnSaveSchedule").disabled = false;
    }
  });

  // Quick action: View summary
  el("qaSummary").addEventListener("click", async () => {
    el("summaryResult").classList.remove("hidden");
    el("summaryText").textContent = "Generating summary…";
    try {
      const res = await fetch("/api/summary", { method: "POST" });
      const data = await res.json();
      el("summaryText").textContent = data.ok ? data.summary : "Error: " + data.error;
    } catch {
      el("summaryText").textContent = "Error generating summary.";
    }
  });
  el("btnCloseSummary").addEventListener("click", () => el("summaryResult").classList.add("hidden"));

  // Commands page
  async function loadCommands() {
    try {
      const res = await fetch("/api/commands");
      const data = await res.json();
      commandsLoaded = true;
      const list = Array.isArray(data.commands) ? data.commands : [];
      el("commandList").innerHTML = list
        .map(
          (c, i) => `
        <div class="command-item">
          <div>
            <div class="cmd">${escapeHtml(c.command)}</div>
            <div class="desc">${escapeHtml(c.description)}</div>
          </div>
          <button class="copy-btn" data-copy="${escapeHtml(c.command)}" aria-label="Copy ${escapeHtml(c.command)}">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none"><rect x="9" y="9" width="11" height="11" rx="2" stroke="currentColor" stroke-width="1.6"/><path d="M5 15V6a2 2 0 012-2h9" stroke="currentColor" stroke-width="1.6"/></svg>
          </button>
        </div>`
        )
        .join("");
      qsa(".copy-btn", el("commandList")).forEach((btn) => {
        btn.addEventListener("click", async () => {
          try {
            await navigator.clipboard.writeText(btn.dataset.copy);
          } catch {
            /* clipboard unavailable — still give visual feedback below */
          }
          btn.classList.add("copied");
          toast(`Copied ${btn.dataset.copy}`);
          setTimeout(() => btn.classList.remove("copied"), 1200);
        });
      });
    } catch {
      el("commandList").innerHTML = '<div class="empty-note">Could not load commands right now.</div>';
    }
  }

  // Logout — browser session only; WhatsApp connection stays untouched
  // server-side (see web.js).
  async function logout() {
    await fetch("/api/logout", { method: "POST" });
    location.reload();
  }
  el("btnLogout").addEventListener("click", logout);
  el("btnLogoutSettings").addEventListener("click", logout);

  // Mobile nav drawer
  function openDrawer() {
    el("sidebar").classList.add("drawer-open");
    el("navBackdrop").classList.add("open");
  }
  function closeDrawer() {
    el("sidebar").classList.remove("drawer-open");
    el("navBackdrop").classList.remove("open");
  }
  el("btnOpenDrawer").addEventListener("click", openDrawer);
  el("navBackdrop").addEventListener("click", closeDrawer);

  // ==================================================================
  // Live updates (SSE) + initial routing — mirrors the original app's
  // single source of truth for connection/profile state, just routed to
  // whichever view is currently active instead of one fixed screen.
  // ==================================================================
  function routeAuthenticatedStatus(data) {
    lastStatusData = data;
    if (appPhase === "wizard") {
      updateWizardConnect(data);
      return;
    }
    // The access-code session persists across server restarts (by design —
    // see access.js), but the in-memory profile/prompt does not (config.js).
    // A browser that verified in an earlier run can therefore land here
    // "authenticated" against a server that never re-ran confirm-setup this
    // time around — meaning startBot() was never called and connection
    // status will sit at "idle" forever. Route back to the wizard instead
    // of showing a connecting screen that can never resolve.
    if (!data.configured && data.status !== "connected") {
      enterWizard();
      return;
    }
    if (data.status === "connected") {
      enterShell(data);
    } else {
      enterConnecting(data);
    }
  }

  let events = null;
  function connectEvents() {
    if (events) events.close();
    events = new EventSource("/api/events");
    events.onmessage = (e) => {
      const data = JSON.parse(e.data);
      if (data.authenticated) routeAuthenticatedStatus(data);
    };
  }
  connectEvents();

  fetch("/api/status")
    .then((r) => r.json())
    .then((data) => {
      if (data.authenticated) {
        routeAuthenticatedStatus(data);
      } else if (data.configured) {
        appPhase = "login";
        showView("login");
      } else {
        enterWizard();
      }
    })
    .catch(() => {
      appPhase = "login";
      showView("login");
    });
})();
