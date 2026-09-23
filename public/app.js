const state = {
  objects: [],
  meta: null,
  schema: null,
  table: null,
  page: 1,
  pageSize: 50,
  sort: "",
  dir: "asc",
  q: "",
  tab: "data",
  rowsRequestId: 0,
};

const $ = (id) => document.getElementById(id);

async function api(url, options) {
  const res = await fetch(url, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  const data = await res.json().catch(() => ({ error: res.statusText }));
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

function fmt(n) {
  if (n == null) return "";
  return Number(n).toLocaleString();
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function displayValue(value) {
  if (value === null || value === undefined) {
    return { html: '<span class="null">NULL</span>', raw: "NULL" };
  }
  if (value && value.__type === "binary") {
    const text = `binary(${value.length}) ${value.preview}`;
    return { html: escapeHtml(text), raw: text };
  }
  if (typeof value === "object") {
    const text = JSON.stringify(value);
    return { html: escapeHtml(text), raw: text };
  }
  return { html: escapeHtml(value), raw: String(value) };
}

function renderObjects() {
  const q = $("objectSearch").value.trim().toLowerCase();
  const filtered = state.objects.filter((o) => {
    const hay = `${o.schema_name}.${o.object_name}`.toLowerCase();
    return !q || hay.includes(q);
  });
  const groups = {};
  for (const obj of filtered) {
    (groups[obj.schema_name] ||= []).push(obj);
  }
  $("objectList").innerHTML =
    Object.keys(groups)
      .map((schema) => {
        const rows = groups[schema]
          .map((obj) => {
            const active =
              state.schema === obj.schema_name && state.table === obj.object_name
                ? "active"
                : "";
            const count = obj.object_type === "VIEW" ? "view" : fmt(obj.row_count);
            const typeClass = obj.object_type === "VIEW" ? "type-view" : "";
            return `<button class="obj ${active}" data-schema="${escapeHtml(obj.schema_name)}" data-table="${escapeHtml(obj.object_name)}">
            <span class="name">${escapeHtml(obj.object_name)}</span>
            <span class="badge ${typeClass}">${count}</span>
          </button>`;
          })
          .join("");
        return `<div class="schema-label">${escapeHtml(schema)}</div>${rows}`;
      })
      .join("") || `<div class="schema-label">No matching objects</div>`;
}

function renderOverview() {
  const m = state.meta || {};
  const biggest = [...state.objects]
    .filter((o) => o.object_type === "TABLE")
    .sort((a, b) => Number(b.row_count) - Number(a.row_count))
    .slice(0, 12);
  $("overview").innerHTML = `
        <h1 class="overview-title">Database overview</h1>
        <p class="overview-sub">Browse tables from the sidebar, inspect structure, or run a read query.</p>
        <div class="cards">
          <div class="card"><div class="label">Database</div><div class="value">${escapeHtml(m.database_name || m.database || "—")}</div></div>
          <div class="card"><div class="label">Tables</div><div class="value">${fmt(m.table_count)}</div></div>
          <div class="card"><div class="label">Views</div><div class="value">${fmt(m.view_count)}</div></div>
          <div class="card"><div class="label">Size (MB)</div><div class="value">${m.size_mb ?? "—"}</div></div>
        </div>
        <div style="margin:0 0 20px">
          <button class="btn" id="overviewExport" type="button">Export .bacpac</button>
        </div>
        <div class="card">
          <div class="label">Largest tables</div>
          <div class="table-wrap" style="max-height:none;margin:12px 0 0;box-shadow:none">
            <table>
              <thead><tr><th>Schema</th><th>Table</th><th>Rows</th></tr></thead>
              <tbody>
                ${biggest
                  .map(
                    (t) => `<tr>
                  <td>${escapeHtml(t.schema_name)}</td>
                  <td class="cell" data-open="${escapeHtml(t.schema_name)}.${escapeHtml(t.object_name)}">${escapeHtml(t.object_name)}</td>
                  <td>${fmt(t.row_count)}</td>
                </tr>`
                  )
                  .join("")}
              </tbody>
            </table>
          </div>
        </div>`;
  $("overview").style.display = state.table ? "none" : "block";
  $("dataFilters").style.display = state.table ? "flex" : "none";
  $("pager").style.display = state.table ? "flex" : "none";
  $("dataWrap").style.display = state.table ? "" : "none";
  if (!state.table) $("crumbs").textContent = "Overview";
}

const CELL_PREVIEW = 160;
let cellRawByTarget = new WeakMap();

function renderTable(target, columns, rows, options = {}) {
  if (!columns.length) {
    cellRawByTarget.delete(target);
    target.innerHTML = `<div class="empty">No rows returned.</div>`;
    return;
  }
  const rawValues = [];
  cellRawByTarget.set(target, rawValues);
  const thead = columns
    .map((col) => {
      let cls = "";
      if (options.sort === col) cls = options.dir === "desc" ? "sort-desc" : "sort-asc";
      return `<th data-col="${escapeHtml(col)}" class="${cls}">${escapeHtml(col)}</th>`;
    })
    .join("");
  const body = rows
    .map((row) => {
      const tds = columns
        .map((col) => {
          const shown = displayValue(row[col]);
          const idx = rawValues.length;
          rawValues.push(shown.raw);
          let html = shown.html;
          if (shown.raw !== "NULL" && shown.raw.length > CELL_PREVIEW) {
            html = `${escapeHtml(shown.raw.slice(0, CELL_PREVIEW))}…`;
          }
          return `<td class="cell" data-col="${escapeHtml(col)}" data-raw-i="${idx}">${html}</td>`;
        })
        .join("");
      return `<tr>${tds}</tr>`;
    })
    .join("");
  target.innerHTML = `<table><thead><tr>${thead}</tr></thead><tbody>${body}</tbody></table>`;
}

function cellRawValue(cell) {
  const table = cell.closest("table");
  const wrap = table && table.parentElement;
  const rawValues = wrap && cellRawByTarget.get(wrap);
  const idx = Number(cell.dataset.rawI);
  if (rawValues && Number.isInteger(idx)) return rawValues[idx] || "";
  return "";
}

async function loadMeta() {
  try {
    const meta = await api("/api/meta");
    state.meta = meta;
    $("dot").classList.toggle("ok", !!meta.connected);
    $("connText").textContent = `${meta.user}@${meta.host}:${meta.port} / ${meta.database}`;
  } catch (err) {
    $("dot").classList.remove("ok");
    $("connText").textContent = err.message;
  }
}

async function loadObjects() {
  const data = await api("/api/objects");
  state.objects = data.objects;
  renderObjects();
  if (!state.table) renderOverview();
}

async function loadRows() {
  if (!state.table) return;
  const requestId = ++state.rowsRequestId;
  $("crumbs").innerHTML = `${escapeHtml(state.schema)}<span> / </span>${escapeHtml(state.table)}`;
  $("dataWrap").innerHTML = `<div class="empty">Loading…</div>`;
  try {
    const params = new URLSearchParams({
      page: String(state.page),
      pageSize: String(state.pageSize),
      sort: state.sort,
      dir: state.dir,
      q: state.q,
    });
    const data = await api(
      `/api/objects/${encodeURIComponent(state.schema)}/${encodeURIComponent(state.table)}/rows?${params}`
    );
    if (requestId !== state.rowsRequestId) return;
    state.sort = data.sort;
    state.dir = data.dir;
    renderTable($("dataWrap"), data.columns, data.rows, data);
    const from = data.total === 0 ? 0 : (data.page - 1) * data.pageSize + 1;
    const to = Math.min(data.total, data.page * data.pageSize);
    $("pageInfo").textContent = `${fmt(from)}–${fmt(to)} of ${fmt(data.total)}`;
    $("prevPage").disabled = data.page <= 1;
    $("nextPage").disabled = to >= data.total;
  } catch (err) {
    if (requestId !== state.rowsRequestId) return;
    $("dataWrap").innerHTML = `<div class="status-error">${escapeHtml(err.message)}</div>`;
  }
}

async function loadStructure() {
  if (!state.table) {
    $("structWrap").innerHTML = `<div class="empty">Select a table to inspect columns, types, and keys.</div>`;
    return;
  }
  try {
    const data = await api(
      `/api/objects/${encodeURIComponent(state.schema)}/${encodeURIComponent(state.table)}/columns`
    );
    const rows = data.columns
      .map((c) => {
        const length = ["varchar", "nvarchar", "char", "nchar", "varbinary"].includes(c.type_name)
          ? c.max_length === -1
            ? "max"
            : c.type_name.startsWith("n")
              ? c.max_length / 2
              : c.max_length
          : "";
        const type = length !== "" ? `${c.type_name}(${length})` : c.type_name;
        return `<tr>
            <td>${c.is_pk ? '<span class="pill pk">PK</span> ' : ""}${escapeHtml(c.name)}</td>
            <td>${escapeHtml(type)}</td>
            <td>${c.is_nullable ? "YES" : "NO"}</td>
            <td>${c.is_identity ? "YES" : ""}</td>
            <td class="cell">${c.default_value ? escapeHtml(c.default_value) : '<span class="null">NULL</span>'}</td>
          </tr>`;
      })
      .join("");
    $("structWrap").innerHTML = `<table>
          <thead><tr><th>Column</th><th>Type</th><th>Nullable</th><th>Identity</th><th>Default</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>`;
  } catch (err) {
    $("structWrap").innerHTML = `<div class="status-error">${escapeHtml(err.message)}</div>`;
  }
}

async function runQuery() {
  const sql = $("sql").value.trim();
  $("queryWrap").innerHTML = `<div class="empty">Running…</div>`;
  try {
    const data = await api("/api/query", { method: "POST", body: JSON.stringify({ sql }) });
    if (!data.sets.length) {
      $("queryWrap").innerHTML = `<div class="empty">Command completed. Rows affected: ${escapeHtml(
        (data.rowsAffected || []).join(", ") || "0"
      )}</div>`;
      return;
    }
    $("queryWrap").innerHTML = data.sets
      .map((set, i) => {
        const note = set.truncated
          ? `<div class="empty">Showing first 2,000 of ${fmt(set.rowCount)} rows</div>`
          : "";
        return `${note}<div id="query-set-${i}"></div>`;
      })
      .join("");
    data.sets.forEach((set, i) => {
      const target = document.getElementById(`query-set-${i}`) || $("queryWrap");
      renderTable(target, set.columns.length ? set.columns : Object.keys(set.rows[0] || {}), set.rows);
    });
  } catch (err) {
    $("queryWrap").innerHTML = `<div class="status-error">${escapeHtml(err.message)}</div>`;
  }
}

function setTab(tab) {
  state.tab = tab;
  document.querySelectorAll(".tab").forEach((el) => el.classList.toggle("active", el.dataset.tab === tab));
  document.querySelectorAll(".panel").forEach((el) => el.classList.toggle("active", el.id === `panel-${tab}`));
  if (tab === "structure") loadStructure();
  if (tab === "export") {
    $("crumbs").textContent = "Export backup";
    if (state.meta && state.meta.database) $("exportDatabase").value = state.meta.database;
  }
  if (tab === "restore") {
    $("crumbs").textContent = "Restore backup";
    if (state.meta && state.meta.database) $("restoreDatabase").value = state.meta.database;
  }
}

function selectObject(schema, table) {
  state.schema = schema;
  state.table = table;
  state.page = 1;
  state.sort = "";
  state.dir = "asc";
  state.q = "";
  $("rowSearch").value = "";
  renderObjects();
  renderOverview();
  if (state.tab === "structure") loadStructure();
  else {
    setTab("data");
    loadRows();
  }
}

function openModal(title, body) {
  $("modalTitle").textContent = title || "Value";
  $("modalBody").textContent = body;
  $("modal").classList.add("open");
}

const SIDEBAR_KEY = "drap-db-viewer-sidebar";

function setSidebarCollapsed(collapsed) {
  document.body.classList.toggle("sidebar-collapsed", collapsed);
  const label = collapsed ? "Show tables" : "Hide tables";
  ["sidebarToggle", "sidebarCollapse"].forEach((id) => {
    const btn = $(id);
    if (!btn) return;
    btn.title = label;
    btn.setAttribute("aria-label", label);
    btn.setAttribute("aria-expanded", String(!collapsed));
  });
  localStorage.setItem(SIDEBAR_KEY, collapsed ? "collapsed" : "open");
}

function toggleSidebar() {
  setSidebarCollapsed(!document.body.classList.contains("sidebar-collapsed"));
}

setSidebarCollapsed(localStorage.getItem(SIDEBAR_KEY) === "collapsed");
$("sidebarToggle").addEventListener("click", toggleSidebar);
$("sidebarCollapse").addEventListener("click", toggleSidebar);
document.addEventListener("keydown", (e) => {
  if (e.key === "[" && !e.metaKey && !e.ctrlKey && !e.altKey) {
    const tag = (e.target && e.target.tagName) || "";
    if (tag === "INPUT" || tag === "TEXTAREA") return;
    e.preventDefault();
    toggleSidebar();
  }
});

$("objectList").addEventListener("click", (e) => {
  const btn = e.target.closest(".obj");
  if (btn) selectObject(btn.dataset.schema, btn.dataset.table);
});
$("objectSearch").addEventListener("input", renderObjects);
$("reloadBtn").addEventListener("click", loadRows);
$("pageSize").addEventListener("change", () => {
  state.pageSize = Number($("pageSize").value);
  state.page = 1;
  loadRows();
});
let searchTimer = null;
function searchRowsNow() {
  state.q = $("rowSearch").value.trim();
  state.page = 1;
  loadRows();
}
$("rowSearch").addEventListener("input", () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(searchRowsNow, 200);
});
$("rowSearch").addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    clearTimeout(searchTimer);
    searchRowsNow();
  }
});
$("prevPage").addEventListener("click", () => {
  state.page -= 1;
  loadRows();
});
$("nextPage").addEventListener("click", () => {
  state.page += 1;
  loadRows();
});
$("dataWrap").addEventListener("click", (e) => {
  const th = e.target.closest("th[data-col]");
  if (th) {
    const col = th.dataset.col;
    state.dir = state.sort === col && state.dir === "asc" ? "desc" : "asc";
    state.sort = col;
    loadRows();
    return;
  }
  const cell = e.target.closest("td.cell");
  if (cell) openModal(cell.dataset.col, cellRawValue(cell));
});
$("overview").addEventListener("click", (e) => {
  if (e.target.closest("#overviewExport")) {
    setTab("export");
    return;
  }
  const cell = e.target.closest("[data-open]");
  if (!cell) return;
  const [schema, table] = cell.dataset.open.split(".");
  selectObject(schema, table);
});
document.querySelectorAll(".tab").forEach((tab) => {
  tab.addEventListener("click", () => setTab(tab.dataset.tab));
});
$("runSql").addEventListener("click", runQuery);
$("sql").addEventListener("keydown", (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
    e.preventDefault();
    runQuery();
  }
});
async function runRestore() {
  const sourcePath = $("restorePath").value.trim();
  const database = $("restoreDatabase").value.trim();
  const replace = $("restoreReplace").checked;
  if (!sourcePath) {
    $("restoreLog").textContent = "Enter the full path to a .bacpac file.";
    return;
  }
  if (replace && !window.confirm(`This will drop database [${database}] and import the backup. Continue?`)) {
    return;
  }
  $("runRestore").disabled = true;
  $("restoreLog").textContent = "Starting import…\n";
  try {
    const res = await fetch("/api/restore", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sourcePath, database, replace }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({ error: res.statusText }));
      throw new Error(data.error || res.statusText);
    }
    const text = await streamJobLog(res, $("restoreLog"));
    if (text.includes("\nDONE")) {
      state.table = null;
      await loadMeta();
      await loadObjects();
    }
  } catch (err) {
    $("restoreLog").textContent += `\n${err.message}`;
  } finally {
    $("runRestore").disabled = false;
  }
}
$("browseBacpac").addEventListener("click", () => $("restoreFile").click());
$("restoreFile").addEventListener("change", async (e) => {
  const file = e.target.files && e.target.files[0];
  e.target.value = "";
  if (!file) return;
  const sizeMb = (file.size / (1024 * 1024)).toFixed(1);
  $("restoreLog").textContent = `Uploading ${file.name} (${sizeMb} MB)…\n`;
  $("browseBacpac").disabled = true;
  try {
    const res = await fetch("/api/restore/upload", {
      method: "POST",
      headers: {
        "Content-Type": "application/octet-stream",
        "X-Filename": file.name,
      },
      body: file,
    });
    const data = await res.json().catch(() => ({ error: res.statusText }));
    if (!res.ok) throw new Error(data.error || res.statusText);
    $("restorePath").value = data.path;
    $("restoreLog").textContent += `Saved as ${data.path}\nReady to import.`;
  } catch (err) {
    $("restoreLog").textContent += err.message;
  } finally {
    $("browseBacpac").disabled = false;
  }
});
$("runRestore").addEventListener("click", runRestore);
async function streamJobLog(res, logEl) {
  if (!res.body) {
    const data = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(data.error || res.statusText);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
    if (text.length > 80000) text = text.slice(text.length - 80000);
    logEl.textContent = text;
    logEl.scrollTop = logEl.scrollHeight;
  }
  return text;
}
async function runExport() {
  const database = $("exportDatabase").value.trim();
  if (!database) {
    $("exportLog").textContent = "Enter a database name.";
    return;
  }
  $("runExport").disabled = true;
  $("exportLog").textContent = "Starting export…\n";
  try {
    const res = await fetch("/api/export", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ database }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({ error: res.statusText }));
      throw new Error(data.error || res.statusText);
    }
    const text = await streamJobLog(res, $("exportLog"));
    const done = text.match(/\nDONE (\S+)(?: (\S+))?/);
    if (done) {
      const file = done[1];
      const name = done[2] || file;
      const link = document.createElement("a");
      link.href = `/api/export/download/${encodeURIComponent(file)}?name=${encodeURIComponent(name)}`;
      link.download = name;
      document.body.appendChild(link);
      link.click();
      link.remove();
      $("exportLog").textContent += "\nDownload started.";
    } else if (text.includes("ERROR:")) {
      /* already shown */
    }
  } catch (err) {
    $("exportLog").textContent += `\n${err.message}`;
  } finally {
    $("runExport").disabled = false;
  }
}
$("runExport").addEventListener("click", runExport);
$("queryWrap").addEventListener("click", (e) => {
  const cell = e.target.closest("td.cell");
  if (cell) openModal(cell.dataset.col, cellRawValue(cell));
});
$("closeModal").addEventListener("click", () => $("modal").classList.remove("open"));
$("modal").addEventListener("click", (e) => {
  if (e.target.id === "modal") $("modal").classList.remove("open");
});

function renderSetup(data) {
  $("setupHeadline").textContent = data.headline || "Checking Docker and SQL Server…";
  $("connText").textContent = data.headline || "Starting…";
  const form = $("setupCredentials");
  form.hidden = !data.needsCredentials;
  $("setupSteps").hidden = !!data.needsCredentials;
  if (data.needsCredentials) {
    $("setupActions").innerHTML = "";
    const active = document.activeElement;
    if (!form.contains(active)) $("setupUser").focus();
    return;
  }
  $("setupSteps").innerHTML = (data.steps || [])
    .map(
      (step) => `<li class="setup-step ${escapeHtml(step.status)}">
        <span class="setup-icon" aria-hidden="true"></span>
        <div>
          <div class="setup-label">${escapeHtml(step.label)}</div>
          ${step.detail ? `<div class="setup-detail">${escapeHtml(step.detail)}</div>` : ""}
        </div>
      </li>`
    )
    .join("");

  const actions = [];
  if (data.needsDockerDownload) {
    actions.push(
      `<button class="btn primary" id="downloadDocker" type="button">Download Docker</button>
       <p class="setup-hint">Install Docker, then this page will continue automatically.</p>`
    );
  }
  if (data.error && data.canRetry) {
    actions.push(`<button class="btn" id="retrySetup" type="button">Retry</button>`);
  }
  $("setupActions").innerHTML = actions.join("");
}

async function initApp() {
  try {
    await loadMeta();
    await loadObjects();
  } catch (err) {
    $("objectList").innerHTML = `<div class="schema-label">${escapeHtml(err.message)}</div>`;
    $("overview").innerHTML = `<div class="status-error">${escapeHtml(err.message)}</div>`;
  }
}

async function waitForSetup() {
  const overlay = $("setupOverlay");

  while (true) {
    try {
      const data = await api("/api/setup/status");
      renderSetup(data);
      if (data.ready) {
        await new Promise((resolve) => setTimeout(resolve, 900));
        overlay.classList.add("done");
        await initApp();
        return;
      }
    } catch (err) {
      $("setupHeadline").textContent = err.message;
      $("connText").textContent = err.message;
    }
    await new Promise((resolve) => setTimeout(resolve, 700));
  }
}

$("setupActions").addEventListener("click", async (e) => {
  if (e.target.id === "downloadDocker") {
    try {
      await api("/api/setup/docker-download", {
        method: "POST",
        body: JSON.stringify({}),
      });
    } catch (err) {
      $("setupHeadline").textContent = err.message;
    }
  }
  if (e.target.id === "retrySetup") {
    try {
      await api("/api/setup/retry", {
        method: "POST",
        body: JSON.stringify({}),
      });
    } catch (err) {
      $("setupHeadline").textContent = err.message;
    }
  }
});

$("setupCredentials").addEventListener("submit", async (e) => {
  e.preventDefault();
  const errorEl = $("setupCredError");
  errorEl.textContent = "";
  try {
    await api("/api/setup/credentials", {
      method: "POST",
      body: JSON.stringify({
        user: $("setupUser").value,
        password: $("setupPassword").value,
        database: $("setupDatabase").value,
      }),
    });
  } catch (err) {
    errorEl.textContent = err.message;
  }
});

waitForSetup();
