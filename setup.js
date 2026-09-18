"use strict";

const fs = require("fs");
const http = require("http");
const https = require("https");
const os = require("os");
const path = require("path");
const { spawn, spawnSync } = require("child_process");
const net = require("net");
const sql = require("mssql");

const CREDENTIALS_PATH = path.join(__dirname, ".db-config.json");

const CONTAINER = process.env.SQLSERVER_CONTAINER || "sqlserver";
const SQL_IMAGE =
  process.env.SQLSERVER_IMAGE || "mcr.microsoft.com/mssql/server:2022-latest";
const HOST = process.env.DB_HOST || "localhost";
const PORT = Number(process.env.DB_PORT || 1433);
const DOCKER_WAIT_MS = 180000;
const SQL_WAIT_MS = 180000;

const STEP_DEFS = [
  { id: "docker-installed", label: "Docker is installed" },
  { id: "docker-running", label: "Docker is running" },
  { id: "sql-image", label: "SQL Server image" },
  { id: "sql-start", label: "SQL Server is starting" },
  { id: "sql-ready", label: "Database is ready" },
];

let dockerCmd = "docker";
let running = false;
let onReady = null;
let credentialsWaiter = null;
let dbCreds = { user: "", password: "", database: "" };

const status = {
  ready: false,
  needsCredentials: false,
  needsDockerDownload: false,
  canRetry: false,
  error: null,
  headline: "Starting…",
  steps: STEP_DEFS.map((step) => ({
    ...step,
    status: "pending",
    detail: "",
  })),
};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function run(cmd, args, opts = {}) {
  return spawnSync(cmd, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    ...opts,
  });
}

function runAsync(cmd, args, { maxOutput = 8192 } = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      stdio: ["ignore", maxOutput === 0 ? "ignore" : "pipe", maxOutput === 0 ? "ignore" : "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const append = (current, chunk) => {
      if (maxOutput === 0) return "";
      const next = current + String(chunk);
      return next.length > maxOutput ? next.slice(next.length - maxOutput) : next;
    };
    if (maxOutput !== 0) {
      child.stdout.on("data", (chunk) => {
        stdout = append(stdout, chunk);
      });
      child.stderr.on("data", (chunk) => {
        stderr = append(stderr, chunk);
      });
    }
    child.on("error", (error) => {
      resolve({ status: 1, error, stdout, stderr });
    });
    child.on("close", (code) => {
      resolve({ status: code ?? 1, stdout, stderr });
    });
  });
}

function lastProgressLine(text) {
  const value = String(text);
  const slice = value.length > 500 ? value.slice(value.length - 500) : value;
  const parts = slice.split(/[\r\n]+/);
  for (let i = parts.length - 1; i >= 0; i -= 1) {
    const line = parts[i].trim();
    if (line) return line;
  }
  return "";
}

function getStatus() {
  return status;
}

function isReady() {
  return status.ready;
}

function setHeadline(text) {
  status.headline = text;
}

function setStep(id, state, detail = "") {
  const step = status.steps.find((item) => item.id === id);
  if (!step) return;
  step.status = state;
  step.detail = detail;
  if (state === "running" && detail) setHeadline(detail);
  else if (state === "ok") setHeadline(step.label);
  else if (state === "action" || state === "error") {
    setHeadline(detail || step.label);
  }
}

function resetSteps() {
  status.ready = false;
  status.needsCredentials = false;
  status.needsDockerDownload = false;
  status.canRetry = false;
  status.error = null;
  status.headline = "Starting…";
  for (const step of status.steps) {
    step.status = "pending";
    step.detail = "";
  }
}

function loadSavedCredentials() {
  try {
    const data = JSON.parse(fs.readFileSync(CREDENTIALS_PATH, "utf8"));
    const user = String(data.user || "").trim();
    const password = String(data.password || "");
    const database = String(data.database || "").trim();
    if (user && password && database) {
      dbCreds = { user, password, database };
      return dbCreds;
    }
  } catch (_) {
    /* first run */
  }
  return null;
}

function getCredentials() {
  if (dbCreds.user && dbCreds.password && dbCreds.database) return { ...dbCreds };
  return loadSavedCredentials();
}

function applyCredentialsTo(config) {
  const creds = getCredentials();
  if (!creds) return;
  config.user = creds.user;
  config.password = creds.password;
  config.database = creds.database;
}

async function ensureCredentials() {
  if (getCredentials()) {
    status.needsCredentials = false;
    return;
  }

  status.needsCredentials = true;
  setHeadline("Enter user, password, and database");
  await new Promise((resolve) => {
    credentialsWaiter = resolve;
  });
  status.needsCredentials = false;
}

function saveCredentials({ user, password, database }) {
  const next = {
    user: String(user || "").trim(),
    password: String(password || ""),
    database: String(database || "").trim(),
  };
  if (!next.user || !next.password || !next.database) {
    throw new Error("User, password, and database are required.");
  }
  fs.writeFileSync(CREDENTIALS_PATH, JSON.stringify(next, null, 2) + "\n");
  dbCreds = next;
  status.needsCredentials = false;
  if (credentialsWaiter) {
    const done = credentialsWaiter;
    credentialsWaiter = null;
    done();
  }
}

function dockerDownloadUrl() {
  if (process.platform === "darwin") {
    return process.arch === "arm64"
      ? "https://desktop.docker.com/mac/main/arm64/Docker.dmg"
      : "https://desktop.docker.com/mac/main/amd64/Docker.dmg";
  }
  if (process.platform === "win32") {
    return process.arch === "arm64"
      ? "https://desktop.docker.com/win/main/arm64/Docker%20Desktop%20Installer.exe"
      : "https://desktop.docker.com/win/main/amd64/Docker%20Desktop%20Installer.exe";
  }
  return "https://docs.docker.com/engine/install/";
}

function dockerAppPath() {
  return "/Applications/Docker.app";
}

function dockerDesktopAppInstalled() {
  return process.platform === "darwin" && fs.existsSync(dockerAppPath());
}

function applescriptString(value) {
  return `"${String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function runOsascriptAdmin(shellCommand) {
  const script = `do shell script ${applescriptString(shellCommand)} with administrator privileges`;
  return runAsync("osascript", ["-e", script]);
}

function downloadFile(url, dest, onProgress) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "curl",
      ["-L", "--fail", "--retry", "2", "-o", dest, url],
      { stdio: ["ignore", "ignore", "pipe"] }
    );
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
      if (stderr.length > 2000) stderr = stderr.slice(stderr.length - 2000);
    });
    const timer = setInterval(() => {
      if (typeof onProgress !== "function") return;
      try {
        const size = fs.statSync(dest).size;
        onProgress(`Downloading Docker Desktop… ${Math.round(size / 1048576)} MB`);
      } catch (_) {
        /* file may not exist yet */
      }
    }, 1000);
    child.on("error", (error) => {
      clearInterval(timer);
      if (error && error.code === "ENOENT") {
        downloadFileNode(url, dest, onProgress).then(resolve, reject);
        return;
      }
      reject(error);
    });
    child.on("close", (code) => {
      clearInterval(timer);
      if (code === 0) resolve();
      else reject(new Error(stderr.trim() || "Failed to download Docker Desktop."));
    });
  });
}

function downloadFileNode(url, dest, onProgress) {
  return new Promise((resolve, reject) => {
    const request = (current, redirects = 0) => {
      if (redirects > 8) {
        reject(new Error("Too many redirects while downloading Docker Desktop."));
        return;
      }
      const lib = current.startsWith("http:") ? http : https;
      const req = lib.get(current, { headers: { "User-Agent": "drap-db-viewer" } }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          request(new URL(res.headers.location, current).toString(), redirects + 1);
          return;
        }
        if (res.statusCode !== 200) {
          reject(new Error(`Failed to download Docker Desktop (${res.statusCode}).`));
          return;
        }
        const file = fs.createWriteStream(dest, { highWaterMark: 64 * 1024 });
        let received = 0;
        let lastPct = -1;
        res.on("data", (chunk) => {
          received += chunk.length;
          if (typeof onProgress !== "function") return;
          const pct = Math.min(100, Math.round(received / 1048576));
          if (pct === lastPct) return;
          lastPct = pct;
          onProgress(`Downloading Docker Desktop… ${pct} MB`);
        });
        res.pipe(file);
        file.on("finish", () => file.close(resolve));
        file.on("error", reject);
        res.on("error", reject);
      });
      req.on("error", reject);
    };
    request(url);
  });
}

async function installDockerDesktopMac() {
  const dmgPath = path.join(os.tmpdir(), "Docker.dmg");
  let skipDownload = false;
  try {
    skipDownload = fs.statSync(dmgPath).size > 400 * 1024 * 1024;
  } catch (_) {
    skipDownload = false;
  }

  if (!skipDownload) {
    setStep("docker-installed", "running", "Downloading Docker Desktop…");
    await downloadFile(dockerDownloadUrl(), dmgPath, (msg) => {
      setStep("docker-installed", "running", msg);
    });
  } else {
    setStep("docker-installed", "running", "Using the downloaded Docker installer…");
  }

  setStep("docker-installed", "running", "Installing Docker Desktop…");
  const attach = await runAsync("hdiutil", ["attach", dmgPath, "-nobrowse"]);
  if (attach.status !== 0) {
    try {
      fs.unlinkSync(dmgPath);
    } catch (_) {
      /* ignore */
    }
    throw new Error(
      (attach.stderr || "").trim() || "Failed to open the Docker installer."
    );
  }
  const volumeMatch = `${attach.stdout}\n${attach.stderr}`.match(/\/Volumes\/[^\s]+/);
  const volume = volumeMatch ? volumeMatch[0] : "/Volumes/Docker";
  const installer = path.join(volume, "Docker.app", "Contents", "MacOS", "install");
  const appSrc = path.join(volume, "Docker.app");

  try {
    if (!fs.existsSync(appSrc)) {
      throw new Error("Docker.app was not found in the downloaded installer.");
    }

    setStep(
      "docker-installed",
      "running",
      "macOS may ask for your password to install Docker Desktop…"
    );

    const user = String(os.userInfo().username || "").replace(/[^A-Za-z0-9._-]/g, "");
    const installCmd = fs.existsSync(installer)
      ? `${installer} --accept-license${user ? ` --user=${user}` : ""}`
      : `rm -rf /Applications/Docker.app && cp -R ${appSrc} /Applications`;

    let installed = await runOsascriptAdmin(installCmd);
    if (installed.status !== 0 && fs.existsSync(installer)) {
      installed = await runOsascriptAdmin(
        `rm -rf /Applications/Docker.app && cp -R ${appSrc} /Applications`
      );
    }
    if (installed.status !== 0) {
      throw new Error(
        (installed.stderr || "").trim() ||
          "Failed to install Docker Desktop. Enter your Mac password when asked."
      );
    }
  } finally {
    await runAsync("hdiutil", ["detach", volume, "-quiet"], { maxOutput: 0 });
    try {
      fs.unlinkSync(dmgPath);
    } catch (_) {
      /* ignore */
    }
  }

  if (!dockerDesktopAppInstalled()) {
    throw new Error("Docker Desktop install finished, but Docker.app was not found.");
  }
}

async function installDockerDesktopWin() {
  const dest = path.join(os.tmpdir(), "DockerDesktopInstaller.exe");
  setStep("docker-installed", "running", "Downloading Docker Desktop…");
  await downloadFile(dockerDownloadUrl(), dest, (msg) => {
    setStep("docker-installed", "running", msg);
  });
  setStep("docker-installed", "running", "Installing Docker Desktop…");
  const installed = await runAsync(dest, [
    "install",
    "--quiet",
    "--accept-license",
  ]);
  if (installed.status !== 0) {
    throw new Error(
      (installed.stderr || "").trim() || "Failed to install Docker Desktop."
    );
  }
}

async function ensureDockerInstalled() {
  setStep("docker-installed", "running", "Checking Docker…");
  if (resolveDockerCmd()) {
    setStep("docker-installed", "ok");
    return;
  }
  if (dockerDesktopAppInstalled()) {
    dockerCmd = path.join(dockerAppPath(), "Contents", "Resources", "bin", "docker");
    setStep("docker-installed", "ok");
    return;
  }

  if (process.platform === "darwin") {
    await installDockerDesktopMac();
  } else if (process.platform === "win32") {
    await installDockerDesktopWin();
  } else {
    status.needsDockerDownload = true;
    setStep(
      "docker-installed",
      "action",
      "Docker is not installed. Download it to continue."
    );
    while (!resolveDockerCmd()) {
      await sleep(3000);
    }
    status.needsDockerDownload = false;
    setStep("docker-installed", "ok");
    return;
  }

  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    if (resolveDockerCmd() || dockerDesktopAppInstalled()) break;
    await sleep(2000);
  }
  if (!resolveDockerCmd() && dockerDesktopAppInstalled()) {
    dockerCmd = path.join(dockerAppPath(), "Contents", "Resources", "bin", "docker");
  }
  if (!resolveDockerCmd() && !dockerDesktopAppInstalled()) {
    throw new Error("Docker Desktop did not install correctly.");
  }
  setStep("docker-installed", "ok");
}

function openUrl(url) {
  if (process.platform === "darwin") {
    spawn("open", [url], { stdio: "ignore", detached: true }).unref();
    return;
  }
  if (process.platform === "win32") {
    spawn("cmd", ["/c", "start", "", url], {
      stdio: "ignore",
      detached: true,
    }).unref();
    return;
  }
  spawn("xdg-open", [url], { stdio: "ignore", detached: true }).unref();
}

function openDockerDownload() {
  openUrl(dockerDownloadUrl());
}

function resolveDockerCmd() {
  const candidates = [
    "docker",
    "/usr/local/bin/docker",
    "/opt/homebrew/bin/docker",
    "/Applications/Docker.app/Contents/Resources/bin/docker",
  ];
  for (const cmd of candidates) {
    const result = run(cmd, ["--version"]);
    if (result.error && result.error.code === "ENOENT") continue;
    if (result.status === 0) {
      dockerCmd = cmd;
      return cmd;
    }
  }
  return null;
}

async function dockerAvailable() {
  const result = await runAsync(dockerCmd, ["info"], { maxOutput: 0 });
  return result.status === 0;
}

function sqlPlatformArgs() {
  if (process.arch === "arm64") return ["--platform", "linux/amd64"];
  return [];
}

function sqlImagePresent() {
  return run(dockerCmd, ["image", "inspect", SQL_IMAGE]).status === 0;
}

function sqlContainerExists() {
  return run(dockerCmd, ["inspect", CONTAINER]).status === 0;
}

function sqlContainerRunning() {
  const inspect = run(dockerCmd, [
    "inspect",
    "-f",
    "{{.State.Running}}",
    CONTAINER,
  ]);
  return inspect.status === 0 && String(inspect.stdout || "").trim() === "true";
}

async function ensureDockerRunning() {
  setStep("docker-running", "running", "Checking if Docker is running…");
  if (await dockerAvailable()) {
    setStep("docker-running", "ok");
    return;
  }

  if (process.platform === "darwin") {
    setStep("docker-running", "running", "Starting Docker Desktop…");
    spawn("open", ["-a", "Docker"], { stdio: "ignore", detached: true }).unref();
  } else {
    setStep(
      "docker-running",
      "running",
      "Start Docker, then this page will continue."
    );
  }

  const deadline = Date.now() + DOCKER_WAIT_MS;
  while (Date.now() < deadline) {
    if (await dockerAvailable()) {
      setStep("docker-running", "ok");
      return;
    }
    await sleep(2000);
  }
  throw new Error("Docker did not become ready in time.");
}

async function ensureSqlServerImage() {
  if (sqlImagePresent()) {
    setStep("sql-image", "ok", "SQL Server is already downloaded");
    return;
  }

  setStep("sql-image", "running", "Downloading SQL Server…");
  const child = spawn(dockerCmd, ["pull", ...sqlPlatformArgs(), SQL_IMAGE], {
    stdio: ["ignore", "pipe", "pipe"],
  });

  const onChunk = (chunk) => {
    const line = lastProgressLine(String(chunk));
    if (line) setStep("sql-image", "running", line);
  };
  child.stdout.on("data", onChunk);
  child.stderr.on("data", onChunk);

  const code = await new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", resolve);
  });
  if (code !== 0) {
    throw new Error("Failed to download SQL Server image.");
  }
  setStep("sql-image", "ok", "SQL Server downloaded");
}

function createSqlServerContainer() {
  const password = dbCreds.password;
  if (!password) {
    throw new Error("Database password is required to create the SQL Server container.");
  }

  setStep("sql-start", "running", `Creating container "${CONTAINER}"…`);
  const created = run(dockerCmd, [
    "run",
    "-d",
    "--name",
    CONTAINER,
    ...sqlPlatformArgs(),
    "-e",
    "ACCEPT_EULA=Y",
    "-e",
    `MSSQL_SA_PASSWORD=${password}`,
    "-p",
    `${PORT}:1433`,
    SQL_IMAGE,
  ]);
  if (created.status !== 0) {
    throw new Error(
      (created.stderr || "").trim() ||
        `Failed to create SQL Server container "${CONTAINER}".`
    );
  }
}

function startSqlServerContainer() {
  if (!sqlContainerExists()) {
    createSqlServerContainer();
    return;
  }

  if (sqlContainerRunning()) {
    setStep("sql-start", "ok", `Container "${CONTAINER}" is already running`);
    return;
  }

  setStep("sql-start", "running", `Starting container "${CONTAINER}"…`);
  const started = run(dockerCmd, ["start", CONTAINER]);
  if (started.status !== 0) {
    throw new Error(
      (started.stderr || "").trim() ||
        `Failed to start container "${CONTAINER}".`
    );
  }
}

function portOpen() {
  return new Promise((resolve) => {
    const socket = net.connect({ host: HOST, port: PORT });
    socket.setTimeout(1500);
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("timeout", () => {
      socket.destroy();
      resolve(false);
    });
    socket.once("error", () => {
      socket.destroy();
      resolve(false);
    });
  });
}

async function loginReady() {
  const pool = new sql.ConnectionPool({
    user: dbCreds.user,
    password: dbCreds.password,
    server: HOST,
    port: PORT,
    database: "master",
    options: {
      encrypt: String(process.env.DB_ENCRYPT || "false").toLowerCase() === "true",
      trustServerCertificate:
        String(process.env.DB_TRUST_SERVER_CERTIFICATE || "true").toLowerCase() ===
        "true",
      enableArithAbort: true,
    },
    connectionTimeout: 5000,
    requestTimeout: 5000,
    pool: { max: 1, min: 0, idleTimeoutMillis: 1000 },
  });

  try {
    await pool.connect();
    await pool.request().query("SELECT 1 AS ok");
    return true;
  } catch (err) {
    return err;
  } finally {
    try {
      await pool.close();
    } catch (_) {
      /* ignore */
    }
  }
}

async function waitForSqlServer() {
  setStep("sql-start", "running", `Waiting for SQL Server on ${HOST}:${PORT}…`);
  const deadline = Date.now() + SQL_WAIT_MS;

  while (Date.now() < deadline) {
    if (!(await portOpen())) {
      await sleep(2000);
      continue;
    }

    setStep("sql-start", "running", "SQL Server is starting…");
    const result = await loginReady();
    if (result === true) {
      setStep("sql-start", "ok", "SQL Server is running");
      return;
    }

    const message = result && result.message ? result.message : String(result);
    setStep("sql-start", "running", `Not ready yet (${message})`);
    await sleep(3000);
  }

  throw new Error(
    `SQL Server did not become ready on ${HOST}:${PORT} in time.`
  );
}

async function runSetup() {
  if (running) return;
  running = true;
  resetSteps();
  setHeadline("Starting…");

  try {
    await ensureCredentials();
    await ensureDockerInstalled();
    await ensureDockerRunning();
    await ensureSqlServerImage();
    startSqlServerContainer();
    await waitForSqlServer();
    setStep("sql-ready", "running", "Connecting to the database…");
    if (typeof onReady === "function") {
      try {
        await onReady();
        setStep("sql-ready", "ok", "Connected");
      } catch (err) {
        setStep("sql-ready", "ok", err.message);
      }
    } else {
      setStep("sql-ready", "ok", "SQL Server is ready");
    }
    status.ready = true;
    status.error = null;
    status.canRetry = false;
    setHeadline("Ready");
  } catch (err) {
    status.error = err.message;
    status.canRetry = true;
    status.ready = false;
    const active = status.steps.find((step) => step.status === "running");
    if (active) setStep(active.id, "error", err.message);
    setHeadline(err.message);
  } finally {
    running = false;
  }
}

function start(options = {}) {
  onReady = options.onReady || null;
  return runSetup();
}

function retry() {
  if (running || status.ready) return;
  return runSetup();
}

module.exports = {
  applyCredentialsTo,
  getStatus,
  isReady,
  openDockerDownload,
  openUrl,
  retry,
  saveCredentials,
  start,
};
