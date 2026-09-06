const app = document.getElementById("app");
const navBtns = document.querySelectorAll(".nav-btn");
let state = { tab: "dashboard", scanDetailId: null, scansPage: 1, currentUser: null };

// Nav button data-tab values use kebab-case for URLs/CSS; permission keys use camelCase
// (matching the server's PAGE_KEYS in src/auth/userStore.ts). This is the one place that
// translates between them.
const TAB_TO_PAGE_KEY = {
  dashboard: "dashboard",
  "page-types": "pageTypes",
  rules: "rules",
  recipients: "recipients",
  settings: "settings",
};

function canView(pageKey) {
  const u = state.currentUser;
  if (!u) return false;
  if (u.role === "admin") return true;
  return !!u.permissions?.[pageKey]?.view;
}
function canEdit(pageKey) {
  const u = state.currentUser;
  if (!u) return false;
  if (u.role === "admin") return true;
  return !!u.permissions?.[pageKey]?.edit;
}

/** Disable a control and explain why, when the current user can't edit this page.
 *  Doesn't hide it — seeing a disabled control communicates the boundary; server-side
 *  permission checks are the actual enforcement regardless of what the UI shows. */
function gateEdit(element, pageKey) {
  if (!canEdit(pageKey)) {
    element.disabled = true;
    element.title = "You don't have edit permission for this page.";
  }
  return element;
}

navBtns.forEach((btn) => {
  btn.addEventListener("click", () => {
    setActiveTab(btn.dataset.tab);
  });
});

function setActiveTab(tab) {
  state.tab = tab;
  state.scanDetailId = null;
  if (tab === "dashboard") state.scansPage = 1;
  navBtns.forEach((b) => b.classList.toggle("active", b.dataset.tab === tab));
  render();
}

async function api(path, opts = {}) {
  const res = await fetch(`/api${path}`, {
    headers: { "Content-Type": "application/json" },
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (res.status === 401) {
    // Session expired or was never established — drop back to the login screen instead
    // of leaving the user staring at a broken page full of failed requests.
    state.currentUser = null;
    showLoginScreen("Your session expired — please log in again.");
    throw new Error("Not authenticated");
  }
  if (res.status === 204) return null;
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(data?.error ?? `Request failed (${res.status})`);
  return data;
}

function el(html) {
  const t = document.createElement("template");
  t.innerHTML = html.trim();
  if (t.content.children.length > 1) {
    // el() only returns the first top-level element — anything after it is silently
    // dropped. This almost always means missing event listeners downstream, so warn
    // loudly instead of failing silently like this bug did before.
    console.warn("el() template has multiple top-level elements — only the first is kept:", html.slice(0, 120));
  }
  return t.content.firstChild;
}

function statusPillClass(status) {
  const s = (status || "").toLowerCase();
  if (["failed", "fail"].includes(s)) return "pill-failed";
  if (s === "warning" || s === "pass_with_warnings" || s === "cloudflare_challenge") return "pill-warning";
  if (["pass", "completed", "empty_results"].includes(s)) return "pill-pass";
  if (s === "running") return "pill-running";
  return "pill-other";
}

function fmtDate(iso) {
  if (!iso) return "—";
  const d = new Date(iso.includes("T") ? iso : iso.replace(" ", "T") + "Z");
  return d.toLocaleString();
}

// ---------------- render dispatcher ----------------
async function render() {
  if (state.scanDetailId) return renderScanDetail(state.scanDetailId);
  if (state.tab === "dashboard") return renderDashboard();
  if (state.tab === "page-types") return renderPageTypes();
  if (state.tab === "rules") return renderRules();
  if (state.tab === "recipients") return renderRecipients();
  if (state.tab === "settings") return renderSettingsPage();
  if (state.tab === "users") return renderUsersPage();
  if (state.tab === "sites") return renderManageSitesPage();
}

// ---------------- Auth: first-run setup, login screen, app shell, bootstrap ----------------
function showSetupScreen() {
  document.getElementById("topbar").style.display = "none";
  app.innerHTML = "";
  const wrap = el(`
    <div class="login-wrap">
      <div class="login-card">
        <h1><span>◎</span> Page Checker</h1>
        <p class="sub">No superadmin account exists yet. Create one now — you choose the username and password; nothing is generated for you.</p>
        <form id="setup-form">
          <div class="form-row">
            <label>Superadmin username</label>
            <input type="text" id="setup-username" required autocomplete="username" />
          </div>
          <div class="form-row">
            <label>Password (min. 8 characters)</label>
            <input type="password" id="setup-password" minlength="8" required autocomplete="new-password" />
          </div>
          <div class="form-row">
            <label>Confirm password</label>
            <input type="password" id="setup-password-confirm" minlength="8" required autocomplete="new-password" />
          </div>
          <div id="setup-error" class="login-error" style="display:none;"></div>
          <button type="submit" class="btn" id="setup-submit-btn">Create superadmin account</button>
        </form>
      </div>
    </div>
  `);
  document.body.appendChild(wrap);

  wrap.querySelector("#setup-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const username = wrap.querySelector("#setup-username").value.trim();
    const password = wrap.querySelector("#setup-password").value;
    const confirm = wrap.querySelector("#setup-password-confirm").value;
    const errorEl = wrap.querySelector("#setup-error");
    const submitBtn = wrap.querySelector("#setup-submit-btn");
    errorEl.style.display = "none";
    if (password !== confirm) {
      errorEl.textContent = "Passwords don't match.";
      errorEl.style.display = "block";
      return;
    }
    submitBtn.disabled = true;
    submitBtn.textContent = "Creating…";
    try {
      const res = await fetch("/api/auth/setup-superadmin", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error ?? "Setup failed");
      state.currentUser = data;
      wrap.remove();
      showAppShell();
      setActiveTab("sites");
    } catch (err) {
      errorEl.textContent = err.message;
      errorEl.style.display = "block";
      submitBtn.disabled = false;
      submitBtn.textContent = "Create superadmin account";
    }
  });
}

function showLoginScreen(message) {
  document.getElementById("topbar").style.display = "none";
  app.innerHTML = "";
  const wrap = el(`
    <div class="login-wrap">
      <div class="login-card">
        <h1><span>◎</span> Page Checker</h1>
        <p class="sub">Sign in to continue. Leave "Site name" blank if logging in as Super Admin.</p>
        ${message ? `<div class="login-error">${escapeHtml(message)}</div>` : ""}
        <form id="login-form">
          <div class="form-row">
            <label>Site name <span class="muted" style="font-weight:400;">(blank for Super Admin)</span></label>
            <input type="text" id="login-sitename" placeholder="bioRxiv" />
          </div>
          <div class="form-row">
            <label>Username</label>
            <input type="text" id="login-username" required autocomplete="username" />
          </div>
          <div class="form-row">
            <label>Password</label>
            <input type="password" id="login-password" required autocomplete="current-password" />
          </div>
          <div id="login-error" class="login-error" style="display:none;"></div>
          <button type="submit" class="btn" id="login-submit-btn">Log in</button>
        </form>
      </div>
    </div>
  `);
  document.body.appendChild(wrap);

  wrap.querySelector("#login-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const siteName = wrap.querySelector("#login-sitename").value.trim();
    const username = wrap.querySelector("#login-username").value.trim();
    const password = wrap.querySelector("#login-password").value;
    const errorEl = wrap.querySelector("#login-error");
    const submitBtn = wrap.querySelector("#login-submit-btn");
    errorEl.style.display = "none";
    submitBtn.disabled = true;
    submitBtn.textContent = "Logging in…";
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ siteName: siteName || undefined, username, password }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error ?? "Login failed");
      state.currentUser = data;
      wrap.remove();
      showAppShell();
      setActiveTab(data.role === "superadmin" ? "sites" : "dashboard");
    } catch (err) {
      errorEl.textContent = err.message;
      errorEl.style.display = "block";
      submitBtn.disabled = false;
      submitBtn.textContent = "Log in";
    }
  });
}

function showAppShell() {
  const topbar = document.getElementById("topbar");
  topbar.style.display = "flex";

  const u = state.currentUser;
  navBtns.forEach((btn) => {
    const tab = btn.dataset.tab;
    if (tab === "sites") {
      btn.style.display = u.role === "superadmin" ? "" : "none";
    } else if (tab === "users") {
      btn.style.display = u.role === "admin" || u.role === "superadmin" ? "" : "none";
    } else if (u.role === "superadmin") {
      // Superadmin isn't scoped to a site at all, so the regular per-site pages
      // (Dashboard/Page Types/Rules/Recipients/Settings) don't apply to them directly —
      // they operate through Manage Sites and Users & Permissions instead.
      btn.style.display = "none";
    } else {
      const pageKey = TAB_TO_PAGE_KEY[tab];
      btn.style.display = canView(pageKey) ? "" : "none";
    }
  });

  const userInfo = document.getElementById("user-info");
  userInfo.innerHTML = "";
  userInfo.appendChild(
    el(`
    <div style="display:flex; align-items:center; gap:12px;">
      <span class="muted" style="font-size:13px;">${escapeHtml(u.username)} (${escapeHtml(u.role)})${u.siteName ? ` · ${escapeHtml(u.siteName)}` : ""}</span>
      <button class="btn secondary icon" id="logout-btn">Log out</button>
    </div>
  `)
  );
  userInfo.querySelector("#logout-btn").addEventListener("click", async () => {
    try {
      await fetch("/api/auth/logout", { method: "POST" });
    } catch {
      // ignore — clearing local state and showing the login screen is the important part
    }
    state.currentUser = null;
    showLoginScreen();
  });
}

async function bootstrapAuth() {
  try {
    const setupRes = await fetch("/api/auth/needs-setup");
    const setupData = await setupRes.json();
    if (setupData.needsSetup) {
      showSetupScreen();
      return;
    }
  } catch {
    // if this check itself fails, fall through to the normal login flow below
  }
  try {
    const res = await fetch("/api/auth/me");
    if (!res.ok) throw new Error("not authenticated");
    state.currentUser = await res.json();
    showAppShell();
    render();
  } catch {
    showLoginScreen();
  }
}

// ---------------- Dashboard ----------------
async function renderDashboard() {
  app.innerHTML = `<div class="empty-state">Loading…</div>`;
  const [sites, scansPageData, settings] = await Promise.all([
    api("/sites"),
    api(`/scans?page=${state.scansPage}&pageSize=10`),
    api("/settings"),
  ]);
  const { scans, total: totalScans, pageSize: scansPageSize } = scansPageData;

  app.innerHTML = "";
  app.appendChild(
    el(`
    <div class="page-head">
      <div>
        <h1>Sites</h1>
        <p>Configure sites to crawl and check against your content rules.</p>
      </div>
      <button class="btn" id="add-site-btn">＋ Add site</button>
    </div>
  `)
  );

  const siteCard = el(`<div class="card"></div>`);
  siteCard.appendChild(
    el(`
    <table>
      <thead><tr><th>Name</th><th>Base URL</th><th></th></tr></thead>
      <tbody id="sites-tbody"></tbody>
    </table>
  `)
  );
  app.appendChild(siteCard);

  const tbody = siteCard.querySelector("#sites-tbody");
  if (sites.length === 0) {
    tbody.appendChild(el(`<tr><td colspan="3" class="empty-state">No sites yet.</td></tr>`));
  }
  for (const site of sites) {
    const latestScan = scans.find((s) => s.site_id === site.id);
    const tr = el(`
      <tr>
        <td class="name-cell"><strong>${escapeHtml(site.name)}</strong></td>
        <td class="mono">${escapeHtml(site.base_url)}</td>
        <td>
          <div class="row-actions">
            ${
              latestScan
                ? `<a href="#" class="link view-last-scan-link" data-scan="${latestScan.id}">View last scan ↗</a>`
                : ""
            }
            <button class="btn secondary icon run-scan-btn" data-site="${site.id}">▶ Run scan</button>
            <button class="icon-btn delete-site-btn" data-site="${site.id}" title="Delete">🗑</button>
          </div>
        </td>
      </tr>
    `);
    tbody.appendChild(tr);
  }

  tbody.querySelectorAll(".view-last-scan-link").forEach((a) =>
    a.addEventListener("click", (e) => {
      e.preventDefault();
      state.scanDetailId = a.dataset.scan;
      render();
    })
  );

  tbody.querySelectorAll(".run-scan-btn").forEach((btn) => {
    gateEdit(btn, "dashboard");
    btn.addEventListener("click", async () => {
      btn.disabled = true;
      btn.innerHTML = `<span class="spinner"></span> Scanning…`;
      try {
        await api(`/sites/${btn.dataset.site}/scan`, { method: "POST" });
        // Re-render right away so the new "running" row shows up immediately, instead
        // of waiting for the first poll tick — this is what makes a scan starting
        // visually distinguishable from nothing happening at all.
        await render();
        pollUntilScanCompletes();
      } catch (e) {
        alert("Failed to start scan: " + e.message);
        btn.disabled = false;
        btn.textContent = "▶ Run scan";
      }
    });
  });
  tbody.querySelectorAll(".delete-site-btn").forEach((btn) => {
    gateEdit(btn, "dashboard");
    btn.addEventListener("click", async () => {
      if (!confirm("Delete this site and all its scans?")) return;
      await api(`/sites/${btn.dataset.site}`, { method: "DELETE" });
      render();
    });
  });

  gateEdit(app.querySelector("#add-site-btn"), "dashboard");
  app.querySelector("#add-site-btn").addEventListener("click", () => {
    openModal({
      title: "Add site",
      fields: [
        { key: "name", label: "Name", type: "text", required: true },
        { key: "base_url", label: "Base URL", type: "text", required: true, placeholder: "https://www.biorxiv.org/" },
      ],
      onSubmit: async (values) => {
        await api("/sites", { method: "POST", body: values });
        render();
      },
    });
  });

  // ---- Scan URLs (what "Run scan" actually crawls — was previously invisible) ----
  const seedUrls = settings.seed_urls ? JSON.parse(settings.seed_urls) : [];
  app.appendChild(el(`<div class="section-title">Scan URLs</div>`));
  app.appendChild(
    el(`<p class="section-sub">The exact URLs "Run scan" checks, one per line. Add or remove as needed — for automatically-discovered URLs, see the Dynamic Article URLs section below.</p>`)
  );
  const urlsCard = el(`<div class="card card-pad"></div>`);
  const urlsTextarea = el(
    `<textarea id="seed-urls-textarea" rows="8" style="width:100%; font-family:ui-monospace,monospace; font-size:13px; padding:12px; border-radius:10px; border:1px solid var(--border);">${escapeHtml(
      seedUrls.join("\n")
    )}</textarea>`
  );
  urlsCard.appendChild(urlsTextarea);
  const urlsActions = el(`<div style="margin-top:12px; display:flex; align-items:center; gap:12px; flex-wrap:wrap;">
    <button class="btn secondary" id="save-urls-btn">Save URL list</button>
    <span class="muted" id="save-urls-status" style="font-size:13px;"></span>
  </div>`);
  urlsCard.appendChild(urlsActions);
  app.appendChild(urlsCard);
  gateEdit(urlsCard.querySelector("#save-urls-btn"), "dashboard");
  urlsCard.querySelector("#save-urls-btn").addEventListener("click", async () => {
    const lines = urlsTextarea.value.split("\n").map((l) => l.trim()).filter(Boolean);
    const status = urlsCard.querySelector("#save-urls-status");
    try {
      await api("/settings/seed_urls", { method: "PUT", body: { value: JSON.stringify(lines) } });
      status.textContent = `Saved ${lines.length} URL(s).`;
    } catch (e) {
      status.textContent = "Error: " + e.message;
    }
  });

  // ---- Dynamic article URLs (separate from the static list above) ----
  // Purely a display preference — set on the Settings page — independent of whether
  // dynamic URLs are actually enabled/refreshing/counting toward scans.
  const dynamicSectionHidden = settings.dynamic_urls_hidden_on_dashboard === "true";
  if (!dynamicSectionHidden) {
    const dynamicUrls = settings.dynamic_urls ? JSON.parse(settings.dynamic_urls) : [];
    const dynamicEnabled = settings.dynamic_urls_enabled === "true";
    app.appendChild(el(`<div class="section-title">Dynamic article URLs</div>`));
    app.appendChild(
      el(`<p class="section-sub">${
        dynamicEnabled
          ? 'Automatically refreshed (cleared and rediscovered) before every scheduled scan — enabled in Settings. Included in scans alongside the Scan URLs list above.'
          : 'Currently disabled — enable "Use dynamic article URLs" on the Settings page to have these refresh automatically and count toward scans. You can still preview a manual refresh below.'
      }</p>`)
    );
    const dynamicCard = el(`<div class="card card-pad"></div>`);
    const dynamicListEl = el(`
      <div id="dynamic-urls-list" style="font-family:ui-monospace,monospace; font-size:13px; max-height:220px; overflow-y:auto; border:1px solid var(--border); border-radius:10px; padding:12px; background:#fafafa;">
        ${
          dynamicUrls.length
            ? dynamicUrls.map((u) => `<div style="padding:2px 0; word-break:break-all;">${escapeHtml(u)}</div>`).join("")
            : `<span class="muted">No dynamic URLs discovered yet.</span>`
        }
      </div>
    `);
    dynamicCard.appendChild(dynamicListEl);
    const dynamicActions = el(`<div style="margin-top:12px; display:flex; align-items:center; gap:12px; flex-wrap:wrap;">
      <button class="btn secondary" id="refresh-dynamic-btn">🔀 Refresh now</button>
      <span class="muted" id="dynamic-urls-status" style="font-size:13px;">${dynamicUrls.length} URL(s) currently stored.</span>
    </div>`);
    dynamicCard.appendChild(dynamicActions);
    app.appendChild(dynamicCard);

    const refreshBtn = dynamicCard.querySelector("#refresh-dynamic-btn");
    gateEdit(refreshBtn, "dashboard");
    refreshBtn.addEventListener("click", async () => {
      const status = dynamicCard.querySelector("#dynamic-urls-status");
      if (sites.length === 0) {
        status.textContent = "Add a site first.";
        return;
      }
      refreshBtn.disabled = true;
      refreshBtn.innerHTML = `<span class="spinner"></span> Refreshing…`;
      status.textContent = "Clearing existing list, visiting the homepage and 2 random subject collections…";
      try {
        const result = await api(`/sites/${sites[0].id}/discover-urls`, { method: "POST" });
        const listEl = dynamicCard.querySelector("#dynamic-urls-list");
        listEl.innerHTML = result.discovered.length
          ? result.discovered.map((u) => `<div style="padding:2px 0; word-break:break-all;">${escapeHtml(u)}</div>`).join("")
          : `<span class="muted">No article URLs found.</span>`;
        status.textContent = `Found ${result.discovered.length} article URL(s) from ${result.collectionsVisited.length} collection(s).`;
      } catch (e) {
        status.textContent = "Error: " + e.message;
      } finally {
        refreshBtn.disabled = false;
        refreshBtn.textContent = "🔀 Refresh now";
      }
    });
  }

  app.appendChild(el(`<div class="section-title">Recent scans</div>`));
  app.appendChild(
    el(`<p class="section-sub">Only the most recent ${settings.scan_retention_count ?? 10} run(s) are kept — older scans (and their screenshots) are deleted automatically.</p>`)
  );
  const scansCard = el(`<div class="card"></div>`);
  scansCard.appendChild(
    el(`
    <table>
      <thead>
        <tr><th>Site</th><th>Started</th><th>Status</th><th>Pages</th><th>Violations</th><th></th></tr>
      </thead>
      <tbody id="scans-tbody"></tbody>
    </table>
  `)
  );
  app.appendChild(scansCard);
  const stbody = scansCard.querySelector("#scans-tbody");
  if (scans.length === 0) {
    stbody.appendChild(el(`<tr><td colspan="6" class="empty-state">No scans yet — run one above.</td></tr>`));
  }
  for (const scan of scans) {
    const tr = el(`
      <tr>
        <td><strong>${escapeHtml(scan.site_name)}</strong></td>
        <td class="muted">${fmtDate(scan.started_at)}</td>
        <td><span class="pill ${statusPillClass(scan.status)}">${cap(scan.status)}</span></td>
        <td>${scan.pages_scanned}/${scan.pages_total}</td>
        <td>${scan.violations_count}</td>
        <td><a href="#" class="link view-scan-link" data-scan="${scan.id}">View ↗</a></td>
      </tr>
    `);
    stbody.appendChild(tr);
  }
  stbody.querySelectorAll(".view-scan-link").forEach((a) =>
    a.addEventListener("click", (e) => {
      e.preventDefault();
      state.scanDetailId = a.dataset.scan;
      render();
    })
  );

  // ---- Pagination ----
  const totalPages = Math.max(1, Math.ceil(totalScans / scansPageSize));
  if (totalScans > 0) {
    const paginationEl = el(`
      <div style="display:flex; align-items:center; justify-content:center; gap:16px; margin-top:16px;">
        <button class="btn secondary icon" id="scans-prev-btn" ${state.scansPage <= 1 ? "disabled" : ""}>← Prev</button>
        <span class="muted" style="font-size:13px;">Page ${state.scansPage} of ${totalPages} (${totalScans} total)</span>
        <button class="btn secondary icon" id="scans-next-btn" ${state.scansPage >= totalPages ? "disabled" : ""}>Next →</button>
      </div>
    `);
    app.appendChild(paginationEl);
    paginationEl.querySelector("#scans-prev-btn").addEventListener("click", () => {
      if (state.scansPage > 1) {
        state.scansPage -= 1;
        render();
      }
    });
    paginationEl.querySelector("#scans-next-btn").addEventListener("click", () => {
      if (state.scansPage < totalPages) {
        state.scansPage += 1;
        render();
      }
    });
  }
}

let pollTimer = null;
function pollUntilScanCompletes() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(async () => {
    const { scans } = await api("/scans?page=1&pageSize=1");
    const latest = scans[0];
    if (!latest || latest.status !== "running") {
      clearInterval(pollTimer);
      pollTimer = null;
      if (state.tab === "dashboard" && !state.scanDetailId) render();
    }
  }, 3000);
}

// ---------------- Scan detail ----------------
async function renderScanDetail(id) {
  app.innerHTML = `<div class="empty-state">Loading…</div>`;
  const scan = await api(`/scans/${id}`);
  app.innerHTML = "";
  app.appendChild(
    el(`
    <div class="page-head">
      <div>
        <h1>Scan #${scan.id}</h1>
        <p>${scan.pages_scanned}/${scan.pages_total} pages checked · ${scan.violations_count} violation(s) · started ${fmtDate(
      scan.started_at
    )}</p>
      </div>
      <button class="btn secondary" id="back-btn">← Back to dashboard</button>
    </div>
  `)
  );
  app.querySelector("#back-btn").addEventListener("click", () => {
    state.scanDetailId = null;
    setActiveTab("dashboard");
  });

  if (scan.error_message) {
    app.appendChild(
      el(`
      <div class="banner" style="background:#fde2e2; border-color:#f5b5b5;">
        <span>⚠️</span>
        <div>
          <strong style="color:#7a1f1f;">Scan failed to complete</strong>
          <p style="color:#7a1f1f;">${escapeHtml(scan.error_message)}</p>
        </div>
      </div>
    `)
    );
  }

  const card = el(`<div class="card"></div>`);
  card.appendChild(
    el(`
    <table>
      <thead><tr><th>Screenshot</th><th>URL</th><th>Page type</th><th>HTTP</th><th>Status</th><th>Blocks</th><th>Why</th></tr></thead>
      <tbody id="pages-tbody"></tbody>
    </table>
  `)
  );
  app.appendChild(card);
  const tbody = card.querySelector("#pages-tbody");
  if (scan.pages.length === 0) {
    tbody.appendChild(el(`<tr><td colspan="7" class="empty-state">No pages recorded.</td></tr>`));
  }
  for (const p of scan.pages) {
    const chips = p.blocks
      .map((b) => `<span class="block-chip ${b.status}" title="${escapeHtml(b.reason ?? "")}">${escapeHtml(b.key)}</span>`)
      .join("");
    const reasons = (p.violations ?? []).map((v) => v.reason).filter(Boolean);
    const whyText = reasons.length ? reasons.join(" · ") : "";
    const thumb = p.screenshot_path
      ? `<a href="/screenshots/${p.screenshot_path}" target="_blank" rel="noopener"><img src="/screenshots/${p.screenshot_path}" class="thumb" alt="Screenshot of ${escapeHtml(p.url)}" /></a>`
      : `<span class="muted" style="font-size:12px;">—</span>`;
    const tr = el(`
      <tr>
        <td>${thumb}</td>
        <td class="mono" style="max-width:240px; word-break:break-all;">${escapeHtml(p.url)}</td>
        <td>${escapeHtml(p.page_type_key)}</td>
        <td>${p.http_status ?? "—"}</td>
        <td><span class="pill ${statusPillClass(p.status)}">${cap(p.status)}</span></td>
        <td>${p.blocks.length ? `<div class="blocks-list">${chips}</div>` : `<span class="muted">—</span>`}</td>
        <td style="max-width:260px; font-size:12px; color:var(--gray-text);">${escapeHtml(whyText)}</td>
      </tr>
    `);
    tbody.appendChild(tr);
  }
}

// ---------------- Page Types ----------------
async function renderPageTypes() {
  app.innerHTML = `<div class="empty-state">Loading…</div>`;
  const pageTypes = await api("/page-types");
  app.innerHTML = "";
  app.appendChild(
    el(`
    <div class="page-head">
      <div>
        <h1>Page types</h1>
        <p>Every scanned URL is classified against these patterns, in priority order, to decide which rules apply.</p>
      </div>
      <button class="btn" id="add-pt-btn">＋ Add page type</button>
    </div>
  `)
  );
  const card = el(`<div class="card"></div>`);
  card.appendChild(
    el(`
    <table>
      <thead><tr><th>Name</th><th>Key</th><th>URL pattern</th><th>Priority</th><th>Enabled</th><th></th></tr></thead>
      <tbody id="pt-tbody"></tbody>
    </table>
  `)
  );
  app.appendChild(card);
  const tbody = card.querySelector("#pt-tbody");
  for (const pt of pageTypes) {
    const tr = el(`
      <tr>
        <td class="name-cell"><strong>${escapeHtml(pt.name)}</strong><span>${escapeHtml(pt.description ?? "")}</span></td>
        <td class="mono">${escapeHtml(pt.key)}</td>
        <td class="mono">${escapeHtml(pt.url_pattern)}</td>
        <td>${pt.priority}</td>
        <td><button class="toggle ${pt.enabled ? "on" : ""}" data-id="${pt.id}" data-enabled="${pt.enabled}"></button></td>
        <td>
          <div class="row-actions">
            <button class="icon-btn edit-pt-btn" data-id="${pt.id}">✎</button>
            <button class="icon-btn delete-pt-btn" data-id="${pt.id}">🗑</button>
          </div>
        </td>
      </tr>
    `);
    tbody.appendChild(tr);
  }

  tbody.querySelectorAll(".toggle").forEach((btn) => {
    gateEdit(btn, "pageTypes");
    btn.addEventListener("click", async () => {
      const newVal = btn.dataset.enabled === "1" ? 0 : 1;
      await api(`/page-types/${btn.dataset.id}`, { method: "PUT", body: { enabled: !!newVal } });
      render();
    });
  });
  tbody.querySelectorAll(".delete-pt-btn").forEach((btn) => {
    gateEdit(btn, "pageTypes");
    btn.addEventListener("click", async () => {
      if (!confirm("Delete this page type?")) return;
      await api(`/page-types/${btn.dataset.id}`, { method: "DELETE" });
      render();
    });
  });
  tbody.querySelectorAll(".edit-pt-btn").forEach((btn) => {
    gateEdit(btn, "pageTypes");
    btn.addEventListener("click", () => {
      const pt = pageTypes.find((p) => String(p.id) === btn.dataset.id);
      openPageTypeModal(pt);
    });
  });
  gateEdit(app.querySelector("#add-pt-btn"), "pageTypes");
  app.querySelector("#add-pt-btn").addEventListener("click", () => openPageTypeModal(null));
}

function openPageTypeModal(pt) {
  openModal({
    title: pt ? "Edit page type" : "Add page type",
    fields: [
      { key: "name", label: "Name", type: "text", required: true, value: pt?.name },
      { key: "key", label: "Key", type: "text", required: true, value: pt?.key, disabled: !!pt },
      { key: "description", label: "Description", type: "text", value: pt?.description },
      { key: "url_pattern", label: "URL pattern (regex, tested against normalized path)", type: "text", required: true, value: pt?.url_pattern },
      { key: "priority", label: "Priority (lower = checked first)", type: "number", required: true, value: pt?.priority ?? 5 },
    ],
    onSubmit: async (values) => {
      values.priority = Number(values.priority);
      if (pt) {
        delete values.key;
        await api(`/page-types/${pt.id}`, { method: "PUT", body: values });
      } else {
        await api("/page-types", { method: "POST", body: values });
      }
      render();
    },
  });
}

// ---------------- Rules ----------------
async function renderRules() {
  app.innerHTML = `<div class="empty-state">Loading…</div>`;
  const [rules, sites, pageTypes] = await Promise.all([api("/rules"), api("/sites"), api("/page-types")]);
  app.innerHTML = "";
  app.appendChild(
    el(`
    <div class="page-head">
      <div>
        <h1>Content rules</h1>
        <p>Rules run against every page during a scan. Global rules apply to all sites; site rules apply only to one.</p>
      </div>
      <button class="btn" id="add-rule-btn">＋ Add rule</button>
    </div>
  `)
  );

  const card = el(`<div class="card"></div>`);
  card.appendChild(
    el(`
    <table>
      <thead><tr><th>Rule</th><th>Field</th><th>Check</th><th>Site</th><th>Page type</th><th>Severity</th><th>Enabled</th><th></th></tr></thead>
      <tbody id="rules-tbody"></tbody>
    </table>
  `)
  );
  app.appendChild(card);
  const tbody = card.querySelector("#rules-tbody");
  for (const r of rules) {
    const tr = el(`
      <tr>
        <td><strong>${escapeHtml(r.name)}</strong></td>
        <td class="mono">${escapeHtml(r.field)}</td>
        <td>${humanCheck(r.check_type, r.params)}</td>
        <td>${r.site_name ? escapeHtml(r.site_name) : "All sites"}</td>
        <td>${r.page_type_name ? escapeHtml(r.page_type_name) : "All page types"}</td>
        <td><span class="pill pill-${r.severity}">${r.severity}</span></td>
        <td><button class="toggle ${r.enabled ? "on" : ""}" data-id="${r.id}" data-enabled="${r.enabled}"></button></td>
        <td>
          <div class="row-actions">
            <button class="icon-btn edit-rule-btn" data-id="${r.id}">✎</button>
            <button class="icon-btn delete-rule-btn" data-id="${r.id}">🗑</button>
          </div>
        </td>
      </tr>
    `);
    tbody.appendChild(tr);
  }

  tbody.querySelectorAll(".toggle").forEach((btn) => {
    gateEdit(btn, "rules");
    btn.addEventListener("click", async () => {
      const newVal = btn.dataset.enabled === "1" ? 0 : 1;
      await api(`/rules/${btn.dataset.id}`, { method: "PUT", body: { enabled: !!newVal } });
      render();
    });
  });
  tbody.querySelectorAll(".delete-rule-btn").forEach((btn) => {
    gateEdit(btn, "rules");
    btn.addEventListener("click", async () => {
      if (!confirm("Delete this rule?")) return;
      await api(`/rules/${btn.dataset.id}`, { method: "DELETE" });
      render();
    });
  });
  tbody.querySelectorAll(".edit-rule-btn").forEach((btn) => {
    gateEdit(btn, "rules");
    btn.addEventListener("click", () => {
      const rule = rules.find((r) => String(r.id) === btn.dataset.id);
      openRuleModal(rule, sites, pageTypes);
    });
  });
  gateEdit(app.querySelector("#add-rule-btn"), "rules");
  app.querySelector("#add-rule-btn").addEventListener("click", () => openRuleModal(null, sites, pageTypes));
}

function humanCheck(type, params) {
  switch (type) {
    case "must_not_be_empty": return "Must not be empty";
    case "must_exist": return "Must exist";
    case "minimum_length": return `Minimum length (${params.minLength ?? "?"})`;
    case "minimum_count": return `Minimum count (${params.minCount ?? "?"})`;
    case "items_must_have_href": return "Items must have href";
    case "items_must_have_alt": return "Items must have alt";
    case "numeric_greater_than": return `Greater than ${params.min ?? "?"}`;
    default: return type;
  }
}

function openRuleModal(rule, sites, pageTypes) {
  openModal({
    title: rule ? "Edit rule" : "Add rule",
    fields: [
      { key: "name", label: "Rule name", type: "text", required: true, value: rule?.name },
      { key: "field", label: "Field (block key)", type: "text", required: true, value: rule?.field },
      {
        key: "check_type", label: "Check", type: "select", required: true, value: rule?.check_type,
        options: [
          ["must_not_be_empty", "Must not be empty"],
          ["must_exist", "Must exist"],
          ["minimum_length", "Minimum length"],
          ["minimum_count", "Minimum count"],
          ["items_must_have_href", "Items must have href"],
          ["items_must_have_alt", "Items must have alt"],
          ["numeric_greater_than", "Numeric value greater than"],
        ],
      },
      { key: "param_value", label: "Threshold (for minimum length/count/numeric checks)", type: "number", value: rule?.params?.minLength ?? rule?.params?.minCount ?? rule?.params?.min },
      { key: "site_id", label: "Site", type: "select", value: rule?.site_id ?? "", options: [["", "All sites"], ...sites.map((s) => [String(s.id), s.name])] },
      { key: "page_type_id", label: "Page type", type: "select", value: rule?.page_type_id ?? "", options: [["", "All page types"], ...pageTypes.map((p) => [String(p.id), p.name])] },
      { key: "severity", label: "Severity", type: "select", value: rule?.severity ?? "warning", options: [["critical", "Critical"], ["warning", "Warning"]] },
    ],
    onSubmit: async (values) => {
      const params = {};
      if (values.check_type === "minimum_length") params.minLength = Number(values.param_value || 1);
      if (values.check_type === "minimum_count") params.minCount = Number(values.param_value || 1);
      if (values.check_type === "numeric_greater_than") params.min = Number(values.param_value || 0);
      delete values.param_value;
      values.params = params;
      values.site_id = values.site_id ? Number(values.site_id) : null;
      values.page_type_id = values.page_type_id ? Number(values.page_type_id) : null;
      if (rule) {
        await api(`/rules/${rule.id}`, { method: "PUT", body: values });
      } else {
        await api("/rules", { method: "POST", body: values });
      }
      render();
    },
  });
}

// ---------------- Recipients ----------------
function renderRecipientGroup({ title, subtitle, list, recipientType, sites, addButtonId, alwaysSendSettingKey, alwaysSendValue }) {
  app.appendChild(el(`<div class="section-title">${escapeHtml(title)}</div>`));
  app.appendChild(el(`<p class="section-sub">${escapeHtml(subtitle)}</p>`));

  const alwaysSendCard = el(`<div class="card card-pad" style="margin-bottom:16px;"></div>`);
  const isAlwaysSend = alwaysSendValue !== "false";
  alwaysSendCard.appendChild(el(`
    <div style="display:flex; align-items:center; gap:12px;">
      <button class="toggle ${isAlwaysSend ? "on" : ""}" id="${alwaysSendSettingKey}-toggle" data-enabled="${isAlwaysSend ? 1 : 0}"></button>
      <span style="font-weight:600;">Send email even when all checks pass</span>
    </div>
  `));
  alwaysSendCard.appendChild(el(`<p class="muted" style="font-size:12px; margin:8px 0 0 54px;">${
    isAlwaysSend
      ? "On: every run sends a report to this group, pass or fail."
      : "Off: this group only gets emailed when a run finds at least one violation — clean passes stay silent."
  }</p>`));
  app.appendChild(alwaysSendCard);
  gateEdit(alwaysSendCard.querySelector(`#${alwaysSendSettingKey}-toggle`), "recipients");
  alwaysSendCard.querySelector(`#${alwaysSendSettingKey}-toggle`).addEventListener("click", async (e) => {
    const newVal = e.target.dataset.enabled === "1" ? "false" : "true";
    try {
      await api(`/settings/${alwaysSendSettingKey}`, { method: "PUT", body: { value: newVal } });
      render();
    } catch (err) {
      alert("Error: " + err.message);
    }
  });

  const card = el(`<div class="card"></div>`);
  card.appendChild(
    el(`
    <table>
      <thead><tr><th>Email</th><th>Alerts for</th><th></th></tr></thead>
      <tbody></tbody>
    </table>
  `)
  );
  app.appendChild(card);
  const tbody = card.querySelector("tbody");
  if (list.length === 0) {
    tbody.appendChild(el(`<tr><td colspan="3" class="empty-state">No ${escapeHtml(title.toLowerCase())} recipients yet.</td></tr>`));
  }
  for (const r of list) {
    const tr = el(`
      <tr>
        <td>${escapeHtml(r.email)}</td>
        <td class="muted">${r.site_name ? escapeHtml(r.site_name) : "All sites"}</td>
        <td class="row-actions"><button class="icon-btn delete-recipient-btn" data-id="${r.id}">🗑</button></td>
      </tr>
    `);
    tbody.appendChild(tr);
  }
  tbody.querySelectorAll(".delete-recipient-btn").forEach((btn) => {
    gateEdit(btn, "recipients");
    btn.addEventListener("click", async () => {
      await api(`/recipients/${btn.dataset.id}`, { method: "DELETE" });
      render();
    });
  });

  const addBtn = el(`<button class="btn secondary" style="margin-top:12px;" id="${addButtonId}">＋ Add ${escapeHtml(title.toLowerCase())} recipient</button>`);
  app.appendChild(addBtn);
  gateEdit(addBtn, "recipients");
  addBtn.addEventListener("click", () => {
    openModal({
      title: `Add ${title.toLowerCase()} recipient`,
      fields: [
        { key: "email", label: "Email", type: "text", required: true },
        { key: "site_id", label: "Site", type: "select", value: "", options: [["", "All sites"], ...sites.map((s) => [String(s.id), s.name])] },
      ],
      onSubmit: async (values) => {
        values.site_id = values.site_id ? Number(values.site_id) : null;
        values.recipient_type = recipientType;
        await api("/recipients", { method: "POST", body: values });
        render();
      },
    });
  });
}

async function renderRecipients() {
  app.innerHTML = `<div class="empty-state">Loading…</div>`;
  const [recipients, settings, sites] = await Promise.all([api("/recipients"), api("/settings"), api("/sites")]);
  app.innerHTML = "";
  app.appendChild(
    el(`
    <div class="page-head">
      <div>
        <h1>Email recipients</h1>
        <p>Internal team gets a complete report after every scan run. Clients get one daily summary — the last run of the previous day.</p>
      </div>
    </div>
  `)
  );

  const emailEnabled = settings.email_enabled === "true";
  const banner = el(`
    <div class="banner">
      <span>✉️</span>
      <div>
        <strong>${emailEnabled ? "Email sending is enabled" : "Email sending is currently disabled"}</strong>
        <p>${
          emailEnabled
            ? "Internal recipients get every scan's complete report; client recipients get one summary per day."
            : "Scans still run and record results, but no emails will go out until this is turned back on."
        }</p>
      </div>
    </div>
  `);
  app.appendChild(banner);

  const toggleWrap = el(`
    <div style="margin:-12px 0 24px; display:flex; align-items:center; gap:10px;">
      <button class="toggle ${emailEnabled ? "on" : ""}" id="email-toggle" data-enabled="${emailEnabled ? 1 : 0}"></button>
      <span class="muted" style="font-size:13px;">Toggle email sending</span>
    </div>
  `);
  app.appendChild(toggleWrap);
  gateEdit(toggleWrap.querySelector("#email-toggle"), "recipients");
  toggleWrap.querySelector("#email-toggle").addEventListener("click", async (e) => {
    const newVal = e.target.dataset.enabled === "1" ? "false" : "true";
    await api("/settings/email_enabled", { method: "PUT", body: { value: newVal } });
    render();
  });

  const internalRecipients = recipients.filter((r) => r.recipient_type !== "client");
  const clientRecipients = recipients.filter((r) => r.recipient_type === "client");

  renderRecipientGroup({
    title: "Internal team",
    subtitle: "Gets a report after every scan run (toggle below controls whether that includes clean passes).",
    list: internalRecipients,
    recipientType: "internal",
    sites,
    addButtonId: "add-internal-btn",
    alwaysSendSettingKey: "internal_email_always_send",
    alwaysSendValue: settings.internal_email_always_send,
  });

  renderRecipientGroup({
    title: "Clients",
    subtitle: "Gets one daily summary email — the last run of the previous day, sent shortly after midnight UTC (toggle below controls whether that includes clean-pass days).",
    list: clientRecipients,
    recipientType: "client",
    sites,
    addButtonId: "add-client-btn",
    alwaysSendSettingKey: "client_email_always_send",
    alwaysSendValue: settings.client_email_always_send,
  });

  const testCard = el(`
    <div class="card card-pad">
      <div style="font-weight:700; margin-bottom:4px;">Send a test email</div>
      <div class="muted" style="font-size:13px; margin-bottom:16px;">Confirm email delivery is configured correctly before relying on alerts.</div>
      <div class="test-email-row">
        <input type="email" id="test-email-input" placeholder="you@example.com" />
        <button class="btn secondary" id="send-test-btn">➤ Send test</button>
      </div>
      <div id="test-result" class="muted" style="font-size:13px; margin-top:10px;"></div>
    </div>
  `);
  app.appendChild(testCard);
  gateEdit(testCard.querySelector("#send-test-btn"), "recipients");
  testCard.querySelector("#send-test-btn").addEventListener("click", async () => {
    const email = testCard.querySelector("#test-email-input").value.trim();
    const resultEl = testCard.querySelector("#test-result");
    if (!email) { resultEl.textContent = "Enter an email address first."; return; }
    resultEl.textContent = "Sending…";
    try {
      const result = await api("/recipients/send-test", { method: "POST", body: { email } });
      resultEl.textContent = result.sent ? "Test email sent." : `Not sent: ${result.reason}`;
    } catch (e) {
      resultEl.textContent = "Error: " + e.message;
    }
  });
}

// ---------------- Settings ----------------
async function renderSettingsPage() {
  app.innerHTML = `<div class="empty-state">Loading…</div>`;
  const settings = await api("/settings");
  app.innerHTML = "";
  app.appendChild(
    el(`
    <div class="page-head">
      <div>
        <h1>Settings</h1>
        <p>Scan behavior and automatic scheduling.</p>
      </div>
    </div>
  `)
  );

  // ---- Scan settings (timeouts, PDF threshold) ----
  app.appendChild(el(`<div class="section-title">Scan settings</div>`));
  app.appendChild(el(`<p class="section-sub">Applied to every scan, manual or scheduled.</p>`));
  const scanSettingsCard = el(`<div class="card card-pad"></div>`);
  scanSettingsCard.appendChild(el(`
    <div>
      <div style="display:flex; gap:24px; flex-wrap:wrap;">
        <div class="form-row" style="width:220px;">
          <label>Navigation/HTTP timeout (ms)</label>
          <input type="number" id="nav-timeout-input" value="${escapeHtml(settings.nav_timeout_ms ?? "30000")}" min="1000" step="1000" />
        </div>
        <div class="form-row" style="width:220px;">
          <label>JS-render wait (ms)</label>
          <input type="number" id="js-wait-input" value="${escapeHtml(settings.js_wait_ms ?? "15000")}" min="0" step="1000" />
        </div>
        <div class="form-row" style="width:220px;">
          <label>Minimum PDF size (bytes)</label>
          <input type="number" id="min-pdf-bytes-input" value="${escapeHtml(settings.min_pdf_bytes ?? "5000")}" min="0" step="1000" />
        </div>
      </div>
      <div style="margin-top:12px; display:flex; align-items:center; gap:12px;">
        <button class="btn secondary" id="save-scan-settings-btn">Save</button>
        <span class="muted" id="save-scan-settings-status" style="font-size:13px;"></span>
      </div>
    </div>
  `));
  app.appendChild(scanSettingsCard);
  gateEdit(scanSettingsCard.querySelector("#save-scan-settings-btn"), "settings");
  scanSettingsCard.querySelector("#save-scan-settings-btn").addEventListener("click", async () => {
    const navVal = scanSettingsCard.querySelector("#nav-timeout-input").value;
    const waitVal = scanSettingsCard.querySelector("#js-wait-input").value;
    const pdfBytesVal = scanSettingsCard.querySelector("#min-pdf-bytes-input").value;
    const status = scanSettingsCard.querySelector("#save-scan-settings-status");
    try {
      await api("/settings/nav_timeout_ms", { method: "PUT", body: { value: navVal } });
      await api("/settings/js_wait_ms", { method: "PUT", body: { value: waitVal } });
      await api("/settings/min_pdf_bytes", { method: "PUT", body: { value: pdfBytesVal } });
      status.textContent = "Saved.";
    } catch (e) {
      status.textContent = "Error: " + e.message;
    }
  });

  // ---- Scheduled scanning ----
  app.appendChild(el(`<div class="section-title">Scheduled scanning</div>`));
  app.appendChild(
    el(`<p class="section-sub">Runs automatically in the background, in addition to manual "Run scan" — same rules, same email alerts. Checked every 60 seconds; takes effect within a minute of saving, no restart needed.</p>`)
  );
  const schedEnabled = settings.scheduled_scan_enabled === "true";
  const scheduleCard = el(`<div class="card card-pad"></div>`);
  scheduleCard.appendChild(el(`
    <div>
      <div style="display:flex; align-items:center; gap:12px; margin-bottom:16px;">
        <button class="toggle ${schedEnabled ? "on" : ""}" id="sched-enabled-toggle" data-enabled="${schedEnabled ? 1 : 0}"></button>
        <span style="font-weight:600;">Enable scheduled scanning</span>
      </div>
      <div class="form-row" style="width:260px;">
        <label>Interval (minutes)</label>
        <input type="number" id="sched-interval-input" value="${escapeHtml(settings.scheduled_scan_interval_minutes ?? "60")}" min="1" step="1" placeholder="e.g. 15, 60, 360" />
      </div>
      <p class="muted" style="font-size:12px; margin:8px 0 0;">Examples: 15 for every 15 minutes, 60 for hourly, 1440 for daily.</p>
      <div style="margin-top:16px; display:flex; align-items:center; gap:12px;">
        <button class="btn secondary" id="save-sched-btn">Save</button>
        <span class="muted" id="save-sched-status" style="font-size:13px;"></span>
      </div>
    </div>
  `));
  app.appendChild(scheduleCard);
  gateEdit(scheduleCard.querySelector("#sched-enabled-toggle"), "settings");
  gateEdit(scheduleCard.querySelector("#sched-interval-input"), "settings");
  gateEdit(scheduleCard.querySelector("#save-sched-btn"), "settings");

  let schedEnabledState = schedEnabled;
  scheduleCard.querySelector("#sched-enabled-toggle").addEventListener("click", (e) => {
    schedEnabledState = !schedEnabledState;
    e.target.classList.toggle("on", schedEnabledState);
    e.target.dataset.enabled = schedEnabledState ? "1" : "0";
  });

  scheduleCard.querySelector("#save-sched-btn").addEventListener("click", async () => {
    const intervalVal = scheduleCard.querySelector("#sched-interval-input").value;
    const status = scheduleCard.querySelector("#save-sched-status");
    try {
      await api("/settings/scheduled_scan_enabled", { method: "PUT", body: { value: schedEnabledState ? "true" : "false" } });
      await api("/settings/scheduled_scan_interval_minutes", { method: "PUT", body: { value: intervalVal } });
      status.textContent = schedEnabledState
        ? `Saved. Scheduled scans will run roughly every ${intervalVal} minute(s).`
        : "Saved. Scheduled scanning is off.";
    } catch (e) {
      status.textContent = "Error: " + e.message;
    }
  });

  // ---- Dynamic article URLs ----
  app.appendChild(el(`<div class="section-title">Dynamic article URLs</div>`));
  app.appendChild(
    el(`<p class="section-sub">When enabled, the scheduler clears the current dynamic URL list and rediscovers a fresh one (2 random subject collections, 2-3 random articles each) before every scheduled scan. The list is shown on the Dashboard, separate from the manually-maintained Scan URLs.</p>`)
  );
  const dynUrlsEnabled = settings.dynamic_urls_enabled === "true";
  const dynUrlsHidden = settings.dynamic_urls_hidden_on_dashboard === "true";
  const dynUrlsCard = el(`<div class="card card-pad"></div>`);
  dynUrlsCard.appendChild(el(`
    <div>
      <div style="display:flex; align-items:center; gap:12px;">
        <button class="toggle ${dynUrlsEnabled ? "on" : ""}" id="dyn-urls-toggle" data-enabled="${dynUrlsEnabled ? 1 : 0}"></button>
        <span style="font-weight:600;">Use dynamic article URLs</span>
      </div>
      <div style="display:flex; align-items:center; gap:12px; margin-top:16px;">
        <button class="toggle ${dynUrlsHidden ? "on" : ""}" id="dyn-urls-hide-toggle" data-enabled="${dynUrlsHidden ? 1 : 0}"></button>
        <span style="font-weight:600;">Hide Dynamic Article URLs section on Dashboard</span>
      </div>
      <p class="muted" style="font-size:12px; margin:6px 0 0 54px;">Display-only — refreshing and counting toward scans still follow the toggle above regardless of this.</p>
      <div style="margin-top:16px; display:flex; align-items:center; gap:12px;">
        <button class="btn secondary" id="save-dyn-urls-btn">Save</button>
        <span class="muted" id="save-dyn-urls-status" style="font-size:13px;"></span>
      </div>
    </div>
  `));
  app.appendChild(dynUrlsCard);
  gateEdit(dynUrlsCard.querySelector("#dyn-urls-toggle"), "settings");
  gateEdit(dynUrlsCard.querySelector("#dyn-urls-hide-toggle"), "settings");
  gateEdit(dynUrlsCard.querySelector("#save-dyn-urls-btn"), "settings");

  let dynUrlsEnabledState = dynUrlsEnabled;
  dynUrlsCard.querySelector("#dyn-urls-toggle").addEventListener("click", (e) => {
    dynUrlsEnabledState = !dynUrlsEnabledState;
    e.target.classList.toggle("on", dynUrlsEnabledState);
    e.target.dataset.enabled = dynUrlsEnabledState ? "1" : "0";
  });

  let dynUrlsHiddenState = dynUrlsHidden;
  dynUrlsCard.querySelector("#dyn-urls-hide-toggle").addEventListener("click", (e) => {
    dynUrlsHiddenState = !dynUrlsHiddenState;
    e.target.classList.toggle("on", dynUrlsHiddenState);
    e.target.dataset.enabled = dynUrlsHiddenState ? "1" : "0";
  });

  dynUrlsCard.querySelector("#save-dyn-urls-btn").addEventListener("click", async () => {
    const status = dynUrlsCard.querySelector("#save-dyn-urls-status");
    try {
      await api("/settings/dynamic_urls_enabled", { method: "PUT", body: { value: dynUrlsEnabledState ? "true" : "false" } });
      await api("/settings/dynamic_urls_hidden_on_dashboard", { method: "PUT", body: { value: dynUrlsHiddenState ? "true" : "false" } });
      status.textContent = "Saved.";
    } catch (e) {
      status.textContent = "Error: " + e.message;
    }
  });
}

// ---------------- Users & Permissions (admin only) ----------------
async function renderUsersPage() {
  const role = state.currentUser?.role;
  if (role !== "admin" && role !== "superadmin") {
    app.innerHTML = `<div class="empty-state">Admins only.</div>`;
    return;
  }

  let targetSite = role === "admin" ? state.currentUser.siteName : state.usersPageSite;
  const sites = role === "superadmin" ? await api("/sites") : [];
  if (role === "superadmin" && !targetSite && sites.length > 0) {
    // Default to the MOST RECENTLY created site (highest id), not the first one returned —
    // "the site I just made" is a far more likely intent right after creating it in Manage
    // Sites than the original auto-seeded site, which would otherwise always win here.
    targetSite = sites[sites.length - 1].name;
    state.usersPageSite = targetSite;
  }

  app.innerHTML = "";
  app.appendChild(
    el(`
    <div class="page-head">
      <div>
        <h1>Users &amp; Permissions</h1>
        <p>Configure who can log in, and exactly what each person can see or change on every page.</p>
      </div>
      <button class="btn" id="add-user-btn">＋ Add user</button>
    </div>
  `)
  );

  if (role === "superadmin") {
    const siteSelectRow = el(`
      <div class="banner" style="background:#dbeafe; border-color:#93c5fd; margin-bottom:20px;">
        <span>🌐</span>
        <div style="flex:1;">
          <strong style="color:#1d4ed8;">Managing users for: ${escapeHtml(targetSite)}</strong>
          <p style="color:#1d4ed8;">Any user or admin you add below is created for this site only. Double-check this before adding someone, especially right after creating a new site.</p>
          <div class="form-row" style="max-width:280px; margin-top:10px; margin-bottom:0;">
            <label>Switch site</label>
            <select id="users-site-select"></select>
          </div>
        </div>
      </div>
    `);
    const select = siteSelectRow.querySelector("select");
    for (const s of sites) {
      const opt = el(`<option value="${escapeHtml(s.name)}">${escapeHtml(s.name)}</option>`);
      if (s.name === targetSite) opt.selected = true;
      select.appendChild(opt);
    }
    app.appendChild(siteSelectRow);
    select.addEventListener("change", () => {
      state.usersPageSite = select.value;
      render();
    });
  }

  if (!targetSite) {
    app.appendChild(el(`<div class="empty-state">No sites exist yet — create one on Manage Sites first.</div>`));
    return;
  }

  const [users, pageKeys] = await Promise.all([
    api(`/auth/users?site=${encodeURIComponent(targetSite)}`),
    api("/auth/page-keys"),
  ]);

  const card = el(`<div class="card"></div>`);
  card.appendChild(
    el(`
    <table>
      <thead><tr><th>Username</th><th>Role</th><th>Created</th><th></th></tr></thead>
      <tbody></tbody>
    </table>
  `)
  );
  app.appendChild(card);
  const tbody = card.querySelector("tbody");
  for (const u of users) {
    const isSelf = u.username.toLowerCase() === state.currentUser.username.toLowerCase();
    const tr = el(`
      <tr>
        <td><strong>${escapeHtml(u.username)}</strong>${isSelf ? ` <span class="muted" style="font-size:12px;">(you)</span>` : ""}</td>
        <td><span class="pill ${u.role === "admin" ? "pill-pass" : "pill-other"}">${escapeHtml(u.role)}</span></td>
        <td class="muted">${fmtDate(u.createdAt)}</td>
        <td class="row-actions">
          <button class="icon-btn edit-user-btn" data-username="${escapeHtml(u.username)}">✎</button>
          <button class="icon-btn delete-user-btn" data-username="${escapeHtml(u.username)}" ${isSelf && role !== "superadmin" ? "disabled title=\"You can't delete your own account.\"" : ""}>🗑</button>
        </td>
      </tr>
    `);
    tbody.appendChild(tr);
  }
  tbody.querySelectorAll(".delete-user-btn").forEach((btn) =>
    btn.addEventListener("click", async () => {
      if (btn.disabled) return;
      if (!confirm(`Delete user '${btn.dataset.username}'? This can't be undone.`)) return;
      try {
        await api(`/auth/users/${encodeURIComponent(btn.dataset.username)}?site=${encodeURIComponent(targetSite)}`, { method: "DELETE" });
        render();
      } catch (e) {
        alert("Error: " + e.message);
      }
    })
  );
  tbody.querySelectorAll(".edit-user-btn").forEach((btn) =>
    btn.addEventListener("click", () => {
      const user = users.find((u) => u.username === btn.dataset.username);
      openUserModal(user, pageKeys, targetSite, role);
    })
  );
  app.querySelector("#add-user-btn").addEventListener("click", () => openUserModal(null, pageKeys, targetSite, role));
}

function openUserModal(user, pageKeys, targetSite, actorRole) {
  const isNew = !user;
  const initialPerms = user?.permissions ?? Object.fromEntries(pageKeys.map((k) => [k, { view: true, edit: false }]));

  const backdrop = el(`<div class="modal-backdrop"></div>`);
  const modal = el(`<div class="modal" style="width:520px;"><h2>${isNew ? "Add user" : `Edit '${escapeHtml(user.username)}'`}</h2><form id="user-form"></form></div>`);
  backdrop.appendChild(modal);
  const form = modal.querySelector("#user-form");

  form.appendChild(
    el(`
    <div class="form-row">
      <label>Username</label>
      <input type="text" name="username" value="${isNew ? "" : escapeHtml(user.username)}" ${isNew ? "" : "disabled"} required />
    </div>
  `)
  );
  form.appendChild(
    el(`
    <div class="form-row">
      <label>${isNew ? "Password" : "New password (leave blank to keep current)"}</label>
      <input type="password" name="password" ${isNew ? "required" : ""} autocomplete="new-password" />
    </div>
  `)
  );
  const roleRow = el(`<div class="form-row"><label>Role</label><select name="role"></select></div>`);
  const roleSelect = roleRow.querySelector("select");
  const roleOptions =
    actorRole === "superadmin"
      ? [["user", "Normal user"], ["admin", "Admin (full access to this site, bypasses the grid below)"]]
      : [["user", "Normal user"]]; // a site admin can only ever create normal users — only superadmin creates admins
  for (const [val, label] of roleOptions) {
    const opt = el(`<option value="${val}">${label}</option>`);
    if ((user?.role ?? "user") === val) opt.selected = true;
    roleSelect.appendChild(opt);
  }
  form.appendChild(roleRow);

  form.appendChild(el(`<div class="form-row"><label>Page permissions</label></div>`));
  const permTable = el(`
    <table class="perm-grid">
      <thead><tr><th>Page</th><th>View</th><th>Edit</th></tr></thead>
      <tbody></tbody>
    </table>
  `);
  const permTbody = permTable.querySelector("tbody");
  const pageLabels = { dashboard: "Dashboard", pageTypes: "Page Types", rules: "Rules", recipients: "Recipients", settings: "Settings" };
  for (const key of pageKeys) {
    const p = initialPerms[key] ?? { view: true, edit: false };
    permTbody.appendChild(
      el(`
      <tr>
        <td>${pageLabels[key] ?? key}</td>
        <td><input type="checkbox" data-page="${key}" data-mode="view" ${p.view ? "checked" : ""} /></td>
        <td><input type="checkbox" data-page="${key}" data-mode="edit" ${p.edit ? "checked" : ""} /></td>
      </tr>
    `)
    );
  }
  form.appendChild(permTable);
  form.appendChild(
    el(`<p class="muted" style="font-size:12px; margin-top:8px;">Ignored entirely if role is Admin — admins always have full access to every page.</p>`)
  );

  const actions = el(`
    <div class="modal-actions">
      <button type="button" class="btn secondary" id="user-modal-cancel">Cancel</button>
      <button type="submit" class="btn" id="user-modal-submit">Save</button>
    </div>
  `);
  form.appendChild(actions);

  document.body.appendChild(backdrop);
  backdrop.addEventListener("click", (e) => { if (e.target === backdrop) backdrop.remove(); });
  modal.querySelector("#user-modal-cancel").addEventListener("click", () => backdrop.remove());

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const username = form.querySelector('[name="username"]').value.trim();
    const password = form.querySelector('[name="password"]').value;
    const role = form.querySelector('[name="role"]').value;
    const permissions = {};
    for (const key of pageKeys) {
      permissions[key] = {
        view: form.querySelector(`[data-page="${key}"][data-mode="view"]`).checked,
        edit: form.querySelector(`[data-page="${key}"][data-mode="edit"]`).checked,
      };
    }
    const submitBtn = modal.querySelector("#user-modal-submit");
    submitBtn.disabled = true;
    submitBtn.textContent = "Saving…";
    try {
      if (isNew) {
        await api("/auth/users", { method: "POST", body: { username, password, role, permissions, siteName: targetSite } });
      } else {
        const body = { role, permissions, siteName: targetSite };
        if (password) body.password = password;
        await api(`/auth/users/${encodeURIComponent(user.username)}`, { method: "PUT", body });
      }
      backdrop.remove();
      render();
    } catch (err) {
      alert("Error: " + err.message);
      submitBtn.disabled = false;
      submitBtn.textContent = "Save";
    }
  });
}

// ---------------- Manage Sites (superadmin only) ----------------
const FEATURE_LABELS = { dashboard: "Dashboard", pageTypes: "Page Types", rules: "Rules", recipients: "Recipients", settings: "Settings" };

async function renderManageSitesPage() {
  if (state.currentUser?.role !== "superadmin") {
    app.innerHTML = `<div class="empty-state">Superadmin only.</div>`;
    return;
  }
  app.innerHTML = `<div class="empty-state">Loading…</div>`;
  const sites = await api("/sites");
  app.innerHTML = "";
  app.appendChild(
    el(`
    <div class="page-head">
      <div>
        <h1>Manage Sites</h1>
        <p>Create sites and decide exactly which features each one has — an admin can't turn a feature back on here; this is the ceiling.</p>
      </div>
      <button class="btn" id="add-site-superadmin-btn">＋ Add site</button>
    </div>
  `)
  );

  const card = el(`<div class="card"></div>`);
  card.appendChild(
    el(`
    <table>
      <thead><tr><th>Name</th><th>Base URL</th><th>Enabled features</th><th></th></tr></thead>
      <tbody></tbody>
    </table>
  `)
  );
  app.appendChild(card);
  const tbody = card.querySelector("tbody");
  for (const site of sites) {
    let features = {};
    try { features = JSON.parse(site.enabled_features ?? "{}"); } catch {}
    const chips = Object.keys(FEATURE_LABELS)
      .map((k) => `<span class="block-chip ${features[k] === false ? "FAIL" : "PASS"}">${FEATURE_LABELS[k]}</span>`)
      .join(" ");
    const tr = el(`
      <tr>
        <td><strong>${escapeHtml(site.name)}</strong></td>
        <td class="mono">${escapeHtml(site.base_url)}</td>
        <td><div class="blocks-list">${chips}</div></td>
        <td class="row-actions">
          <button class="icon-btn edit-site-btn" data-id="${site.id}">✎</button>
          <button class="icon-btn delete-site-superadmin-btn" data-id="${site.id}">🗑</button>
        </td>
      </tr>
    `);
    tbody.appendChild(tr);
  }
  tbody.querySelectorAll(".edit-site-btn").forEach((btn) =>
    btn.addEventListener("click", () => {
      const site = sites.find((s) => String(s.id) === btn.dataset.id);
      openSiteModal(site);
    })
  );
  tbody.querySelectorAll(".delete-site-superadmin-btn").forEach((btn) =>
    btn.addEventListener("click", async () => {
      if (!confirm("Delete this site? This does not delete its login-info/users.json file.")) return;
      try {
        await api(`/sites/${btn.dataset.id}`, { method: "DELETE" });
        render();
      } catch (e) {
        alert("Error: " + e.message);
      }
    })
  );
  app.querySelector("#add-site-superadmin-btn").addEventListener("click", () => openSiteModal(null));
}

function openSiteModal(site) {
  const isNew = !site;
  let initialFeatures = { dashboard: true, pageTypes: true, rules: true, recipients: true, settings: true };
  if (!isNew) {
    try { initialFeatures = { ...initialFeatures, ...JSON.parse(site.enabled_features ?? "{}") }; } catch {}
  }

  const backdrop = el(`<div class="modal-backdrop"></div>`);
  const modal = el(`<div class="modal" style="width:480px;"><h2>${isNew ? "Add site" : `Edit '${escapeHtml(site.name)}'`}</h2><form id="site-form"></form></div>`);
  backdrop.appendChild(modal);
  const form = modal.querySelector("#site-form");

  form.appendChild(el(`
    <div class="form-row">
      <label>Name</label>
      <input type="text" name="name" value="${isNew ? "" : escapeHtml(site.name)}" required />
    </div>
  `));
  form.appendChild(el(`
    <div class="form-row">
      <label>Base URL</label>
      <input type="text" name="base_url" value="${isNew ? "" : escapeHtml(site.base_url)}" placeholder="https://www.biorxiv.org/" required />
    </div>
  `));

  form.appendChild(el(`<div class="form-row"><label>Enabled features</label></div>`));
  const featTable = el(`
    <table class="perm-grid">
      <thead><tr><th>Feature</th><th>Enabled</th></tr></thead>
      <tbody></tbody>
    </table>
  `);
  const featTbody = featTable.querySelector("tbody");
  for (const key of Object.keys(FEATURE_LABELS)) {
    featTbody.appendChild(el(`
      <tr>
        <td>${FEATURE_LABELS[key]}</td>
        <td><input type="checkbox" data-feature="${key}" ${initialFeatures[key] ? "checked" : ""} /></td>
      </tr>
    `));
  }
  form.appendChild(featTable);

  const actions = el(`
    <div class="modal-actions">
      <button type="button" class="btn secondary" id="site-modal-cancel">Cancel</button>
      <button type="submit" class="btn" id="site-modal-submit">Save</button>
    </div>
  `);
  form.appendChild(actions);

  document.body.appendChild(backdrop);
  backdrop.addEventListener("click", (e) => { if (e.target === backdrop) backdrop.remove(); });
  modal.querySelector("#site-modal-cancel").addEventListener("click", () => backdrop.remove());

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const name = form.querySelector('[name="name"]').value.trim();
    const base_url = form.querySelector('[name="base_url"]').value.trim();
    const enabled_features = {};
    for (const key of Object.keys(FEATURE_LABELS)) {
      enabled_features[key] = form.querySelector(`[data-feature="${key}"]`).checked;
    }
    const submitBtn = modal.querySelector("#site-modal-submit");
    submitBtn.disabled = true;
    submitBtn.textContent = "Saving…";
    try {
      if (isNew) {
        await api("/sites", { method: "POST", body: { name, base_url, enabled_features } });
      } else {
        await api(`/sites/${site.id}`, { method: "PUT", body: { name, base_url, enabled_features } });
      }
      backdrop.remove();
      render();
    } catch (err) {
      alert("Error: " + err.message);
      submitBtn.disabled = false;
      submitBtn.textContent = "Save";
    }
  });
}

// ---------------- Modal ----------------
function openModal({ title, fields, onSubmit }) {
  const backdrop = el(`<div class="modal-backdrop"></div>`);
  const modal = el(`<div class="modal"><h2>${escapeHtml(title)}</h2><form id="modal-form"></form></div>`);
  backdrop.appendChild(modal);
  const form = modal.querySelector("#modal-form");

  for (const f of fields) {
    const row = el(`<div class="form-row"><label>${escapeHtml(f.label)}</label></div>`);
    let input;
    if (f.type === "select") {
      input = el(`<select name="${f.key}"></select>`);
      for (const [val, label] of f.options) {
        const opt = el(`<option value="${escapeHtml(val)}">${escapeHtml(label)}</option>`);
        if (String(f.value ?? "") === val) opt.selected = true;
        input.appendChild(opt);
      }
    } else {
      input = el(`<input type="${f.type}" name="${f.key}" />`);
      if (f.value !== undefined && f.value !== null) input.value = f.value;
      if (f.placeholder) input.placeholder = f.placeholder;
      if (f.required) input.required = true;
      if (f.disabled) input.disabled = true;
    }
    row.appendChild(input);
    form.appendChild(row);
  }

  const actions = el(`
    <div class="modal-actions">
      <button type="button" class="btn secondary" id="modal-cancel">Cancel</button>
      <button type="submit" class="btn" id="modal-submit">Save</button>
    </div>
  `);
  form.appendChild(actions);

  document.body.appendChild(backdrop);
  backdrop.addEventListener("click", (e) => { if (e.target === backdrop) backdrop.remove(); });
  modal.querySelector("#modal-cancel").addEventListener("click", () => backdrop.remove());

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const values = {};
    for (const f of fields) {
      if (f.disabled) continue;
      const input = form.querySelector(`[name="${f.key}"]`);
      values[f.key] = input.value;
    }
    const submitBtn = modal.querySelector("#modal-submit");
    submitBtn.disabled = true;
    submitBtn.textContent = "Saving…";
    try {
      await onSubmit(values);
      backdrop.remove();
    } catch (err) {
      alert("Error: " + err.message);
      submitBtn.disabled = false;
      submitBtn.textContent = "Save";
    }
  });
}

// ---------------- utils ----------------
function escapeHtml(str) {
  return String(str ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function cap(s) {
  return String(s ?? "").split("_").map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(" ");
}

bootstrapAuth();
