"use strict";

const { spawnSync } = require("child_process");

const VIEWER_PORT = Number(process.env.DB_VIEWER_PORT || 5050);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function pidsOnPort(port) {
  const result = spawnSync(
    "lsof",
    ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }
  );
  if (result.status !== 0) return [];
  return String(result.stdout || "")
    .split(/\s+/)
    .map((value) => Number(value))
    .filter((pid) => pid > 0 && pid !== process.pid);
}

async function freeViewerPort() {
  let pids = pidsOnPort(VIEWER_PORT);
  if (!pids.length) return;

  console.log(
    `Port ${VIEWER_PORT} is already in use. Stopping old db-viewer process(es): ${pids.join(", ")}`
  );
  for (const pid of pids) {
    try {
      process.kill(pid, "SIGTERM");
    } catch (_) {
      /* ignore */
    }
  }

  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    await sleep(300);
    pids = pidsOnPort(VIEWER_PORT);
    if (!pids.length) return;
  }

  for (const pid of pids) {
    try {
      process.kill(pid, "SIGKILL");
    } catch (_) {
      /* ignore */
    }
  }
  await sleep(300);
}

(async () => {
  try {
    await freeViewerPort();
    require("./server.js");
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
})();
