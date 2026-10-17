#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { resolveDevStackConfig, stopDevStack } from "./dev-stack.mjs";

const config = resolveDevStackConfig();
const API_ORIGIN = `http://127.0.0.1:${config.apiPort}`;

/**
 * Utility promise-based sleep helper.
 *
 * @param {number} ms - Milliseconds to sleep.
 * @returns {Promise<void>}
 */
async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Polls the API /readyz endpoint until it returns HTTP 200 with ok: true.
 *
 * @param {number} [maxWaitMs=150000] - Maximum milliseconds to wait.
 * @returns {Promise<boolean>}
 * @throws {Error} If readiness probe times out.
 */
async function waitForReadyz(maxWaitMs = 150000) {
  const start = Date.now();
  console.log(`Waiting for ${API_ORIGIN}/readyz to report ok: true...`);
  while (Date.now() - start < maxWaitMs) {
    try {
      const res = await fetch(`${API_ORIGIN}/readyz`, { signal: AbortSignal.timeout(2000) });
      if (res.ok) {
        const body = await res.json();
        if (body.ok === true) {
          console.log("Readyz check PASSED:", JSON.stringify(body));
          return true;
        }
      }
    } catch {
      // API not ready yet
    }
    await sleep(2000);
  }
  throw new Error(`Timed out waiting for ${API_ORIGIN}/readyz`);
}

/**
 * Claims the initial owner account using the generated setup token.
 *
 * @param {string} setupToken - Raw token read from secrets/setup-token.
 * @returns {Promise<{ claimData: any, cookie: string | null }>}
 * @throws {Error} If the claim request fails.
 */
async function claimOwner(setupToken) {
  console.log("Claiming initial owner account over HTTP...");
  const claimRes = await fetch(`${API_ORIGIN}/api/setup/claim`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      token: setupToken,
      email: "contributor@example.com",
      password: "DevPassword123!456"
    })
  });

  if (!claimRes.ok) {
    const errorText = await claimRes.text();
    throw new Error(`Owner claim failed (${claimRes.status}): ${errorText}`);
  }

  const claimData = await claimRes.json();
  const setCookie = claimRes.headers.get("set-cookie");
  console.log("Owner claimed successfully. User:", claimData.user?.email);
  return { claimData, cookie: setCookie };
}

/**
 * Ensures a starter room exists, verifies an OpenCode CLI pane is active,
 * and asserts that the CLI session endpoint returns a valid session.
 *
 * @param {string | null} cookie - Session cookie from owner claim.
 * @returns {Promise<void>}
 * @throws {Error} If starter room creation, pane query, or CLI session verification fails.
 */
async function verifyStarterRoomAndCliPane(cookie) {
  console.log("Ensuring starter room and verifying CLI pane...");
  const roomRes = await fetch(`${API_ORIGIN}/api/setup/starter-room`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Cookie: cookie || ""
    }
  });

  if (!roomRes.ok) {
    const errorText = await roomRes.text();
    throw new Error(`Starter room request failed (${roomRes.status}): ${errorText}`);
  }

  const roomData = await roomRes.json();
  const roomId = roomData.room.id;
  console.log(`Starter room ensured: "${roomData.room.name}" (${roomId})`);

  // List panes in the room
  const panesRes = await fetch(`${API_ORIGIN}/api/rooms`, {
    headers: { Cookie: cookie || "" }
  });
  if (!panesRes.ok) {
    const errorText = await panesRes.text();
    throw new Error(`Failed to list rooms (${panesRes.status}): ${errorText}`);
  }

  const allRooms = await panesRes.json();
  const roomsList = Array.isArray(allRooms.data) ? allRooms.data : (Array.isArray(allRooms) ? allRooms : []);
  const targetRoom = roomsList.find((r) => r.id === roomId) || allRooms.items?.find((r) => r.id === roomId) || roomData.room || {};

  // Locate OpenCode CLI pane or create one if absent
  let opencodePaneId = targetRoom.panes?.find((p) => p.terminalRuntimeId === "cli:opencode" || p.mode === "TERMINAL")?.id;
  if (!opencodePaneId) {
    console.log("Creating OpenCode CLI pane in room...");
    const createPaneRes = await fetch(`${API_ORIGIN}/api/rooms/${encodeURIComponent(roomId)}/panes`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: cookie || ""
      },
      body: JSON.stringify({
        panes: [
          {
            mode: "TERMINAL",
            terminalRuntimeId: "cli:opencode"
          }
        ]
      })
    });
    if (createPaneRes.ok) {
      const createdPaneData = await createPaneRes.json();
      opencodePaneId = createdPaneData.data?.[0]?.id || createdPaneData.pane?.id || createdPaneData.id;
    } else {
      const errText = await createPaneRes.text();
      throw new Error(`OpenCode CLI pane not found and failed to create pane (${createPaneRes.status}): ${errText}`);
    }
  }

  if (!opencodePaneId) {
    throw new Error(`Required OpenCode CLI pane is missing in starter room ${roomId}`);
  }

  console.log(`Starting OpenCode CLI session on pane ${opencodePaneId}...`);
  const startSessionRes = await fetch(`${API_ORIGIN}/api/panes/${encodeURIComponent(opencodePaneId)}/cli/session`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Cookie: cookie || ""
    },
    body: JSON.stringify({
      runtimeId: "cli:opencode"
    })
  });
  if (!startSessionRes.ok) {
    const errText = await startSessionRes.text();
    console.warn(`Initial CLI start returned ${startSessionRes.status}: ${errText}`);
  }

  // Poll CLI session until status is active/running
  let sessionConfirmed = false;
  let lastSessionData = null;
  for (let attempt = 0; attempt < 10; attempt++) {
    const sessionRes = await fetch(`${API_ORIGIN}/api/panes/${encodeURIComponent(opencodePaneId)}/cli/session`, {
      headers: { Cookie: cookie || "" }
    });
    if (sessionRes.ok) {
      lastSessionData = await sessionRes.json().catch(() => null);
      if (lastSessionData && typeof lastSessionData === "object") {
        const sessionObj = lastSessionData.session || lastSessionData;
        const sessionId = sessionObj.id || sessionObj.sessionId;
        const status = sessionObj.status;
        if (sessionId || status === "RUNNING" || status === "ACTIVE") {
          sessionConfirmed = true;
          break;
        }
      }
    }
    await sleep(1000);
  }

  if (!sessionConfirmed) {
    throw new Error(`OpenCode CLI session failed to start or verify running: ${JSON.stringify(lastSessionData)}`);
  }
  const sessionInfo = lastSessionData?.session?.id || lastSessionData?.session?.sessionId || lastSessionData?.id || lastSessionData?.status || "RUNNING";
  console.log(`CLI session verified successfully:`, sessionInfo);
}

/**
 * Triggers dev-stack stop and purge, and asserts that the state directory,
 * containers, volumes, and child processes are completely removed.
 *
 * @param {Array<{ name: string, pid: number }>} [preRecordedPids=[]]
 * @returns {Promise<void>}
 * @throws {Error} If cleanup assertions fail.
 */
async function verifyResetCleanup(preRecordedPids = []) {
  console.log("Running dev:stack -- reset to verify full cleanup...");

  // Capture any lingering dev-stack child PIDs from pidfile if available
  const recordedPids = [...preRecordedPids];
  if (existsSync(config.pidFile)) {
    try {
      const pidsObj = JSON.parse(readFileSync(config.pidFile, "utf8"));
      for (const [name, pid] of Object.entries(pidsObj)) {
        if (typeof pid === "number" && !recordedPids.some((p) => p.pid === pid)) {
          recordedPids.push({ name, pid });
        }
      }
    } catch {
      // Ignore read error
    }
  }

  await stopDevStack(config, { purge: true });

  if (existsSync(config.stateRoot)) {
    throw new Error(`State root still exists after reset: ${config.stateRoot}`);
  }

  // Assert all recorded dev-stack child processes have exited
  for (const { name, pid } of recordedPids) {
    let running = false;
    try {
      process.kill(pid, 0);
      running = true;
    } catch {
      running = false;
    }
    if (running) {
      throw new Error(`Dev-stack child process '${name}' (PID ${pid}) is still running after reset`);
    }
  }

  // Assert Compose project has no lingering containers
  const psCheck = spawnSync("docker", ["compose", "-p", config.composeProject, "ps", "-a", "-q"], {
    encoding: "utf8"
  });
  if (psCheck.status !== 0) {
    throw new Error(`Failed to query Docker containers after reset (exit code ${psCheck.status}): ${psCheck.stderr || psCheck.stdout}`);
  }
  if (psCheck.stdout.trim().length > 0) {
    throw new Error(`Compose project containers still exist after reset: ${psCheck.stdout.trim()}`);
  }

  // Assert Compose project has no lingering volumes
  const volCheck = spawnSync("docker", ["volume", "ls", "--filter", `label=com.docker.compose.project=${config.composeProject}`, "-q"], {
    encoding: "utf8"
  });
  if (volCheck.status !== 0) {
    throw new Error(`Failed to query Docker volumes after reset (exit code ${volCheck.status}): ${volCheck.stderr || volCheck.stdout}`);
  }
  if (volCheck.stdout.trim().length > 0) {
    throw new Error(`Compose project volumes still exist after reset: ${volCheck.stdout.trim()}`);
  }

  console.log("Reset cleanup verified cleanly (state directory, child processes, containers, and volumes absent)!");
}

/**
 * Main CI gate execution flow.
 *
 * @returns {Promise<void>}
 */
async function main() {
  let devStackProcess = null;
  let isShuttingDown = false;
  let unexpectedExitError = null;
  const activePids = [];

  try {
    console.log("Starting dev:stack without a TTY...");
    devStackProcess = spawn(process.execPath, [path.join(process.cwd(), "scripts", "dev-stack.mjs")], {
      stdio: "inherit",
      env: process.env
    });

    devStackProcess.on("error", (err) => {
      console.error("Failed to spawn dev-stack process:", err);
      unexpectedExitError = err;
    });

    devStackProcess.on("exit", (code, signal) => {
      if (!isShuttingDown && (code !== 0 || signal)) {
        unexpectedExitError = new Error(`dev:stack process exited unexpectedly with code ${code ?? signal}`);
      }
    });

    await waitForReadyz(150000);
    if (unexpectedExitError) throw unexpectedExitError;

    // Capture live dev-stack child PIDs while stack is actively running
    if (existsSync(config.pidFile)) {
      try {
        const pidsObj = JSON.parse(readFileSync(config.pidFile, "utf8"));
        for (const [name, pid] of Object.entries(pidsObj)) {
          if (typeof pid === "number" && !activePids.some((p) => p.pid === pid)) {
            activePids.push({ name, pid });
          }
        }
      } catch {}
    }

    // Read setup token
    const tokenFile = path.join(config.secretsDir, "setup-token");
    if (!existsSync(tokenFile)) {
      throw new Error(`Setup token file not found at ${tokenFile}`);
    }
    const setupToken = readFileSync(tokenFile, "utf8").trim();

    const { cookie } = await claimOwner(setupToken);
    await verifyStarterRoomAndCliPane(cookie);

    if (unexpectedExitError) throw unexpectedExitError;
    console.log("All functional gate assertions PASSED!");
  } finally {
    isShuttingDown = true;
    if (activePids.length === 0 && existsSync(config.pidFile)) {
      try {
        const pidsObj = JSON.parse(readFileSync(config.pidFile, "utf8"));
        for (const [name, pid] of Object.entries(pidsObj)) {
          if (typeof pid === "number" && !activePids.some((p) => p.pid === pid)) {
            activePids.push({ name, pid });
          }
        }
      } catch {}
    }

    if (devStackProcess) {
      try {
        devStackProcess.kill("SIGTERM");
        await new Promise((resolve) => {
          const timeout = setTimeout(() => {
            try {
              devStackProcess.kill("SIGKILL");
            } catch {}
            resolve();
          }, 10000);
          devStackProcess.once("exit", () => {
            clearTimeout(timeout);
            resolve();
          });
        });
      } catch {}
    }
    await verifyResetCleanup(activePids);
    if (unexpectedExitError) throw unexpectedExitError;
  }
}

main().catch((err) => {
  console.error(`\n[FATAL Gate Error] ${err.message}`);
  process.exit(1);
});
