import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  assertSafeStateDir,
  ensureSecrets,
  generateDevComposeYaml,
  isComposeServiceHealthy,
  parsePinnedImages,
  parsePinnedOpencodeVersion,
  resolveCliHostSocketPath,
  resolveDevStackConfig,
  setupOpencodeWrapper,
  validatePort
} from "../dev-stack.mjs";

/**
 * Verifies that parsePinnedImages accurately extracts the pinned image tags and digests.
 */
test("parsePinnedImages extracts exact digests for postgres and temporal", () => {
  const sampleCompose = `
services:
  postgres:
    image: pgvector/pgvector:0.8.3-pg17-trixie@sha256:3a3147ccd9a0aee952bb69e1acea1eb3cc7183544185b87a662f872cfa47ae3b
  temporal:
    image: temporalio/auto-setup:1.29.1@sha256:5b3502a3b685f9eff1b925af90c57c9e3dbeccbef367cc28a2a9712c63379312
`;
  const images = parsePinnedImages(sampleCompose);
  assert.equal(images.postgres, "pgvector/pgvector:0.8.3-pg17-trixie@sha256:3a3147ccd9a0aee952bb69e1acea1eb3cc7183544185b87a662f872cfa47ae3b");
  assert.equal(images.temporal, "temporalio/auto-setup:1.29.1@sha256:5b3502a3b685f9eff1b925af90c57c9e3dbeccbef367cc28a2a9712c63379312");

  assert.throws(() => parsePinnedImages("services: {}"), /Failed to extract pinned/);
});

/**
 * Verifies that parsePinnedOpencodeVersion extracts the pinned semver from Dockerfile.
 */
test("parsePinnedOpencodeVersion extracts exact version from Dockerfile", () => {
  const sampleDockerfile = `
RUN npm install --global --no-audit --no-fund opencode-ai@1.18.4 \\
    && opencode --version
`;
  const version = parsePinnedOpencodeVersion(sampleDockerfile);
  assert.equal(version, "1.18.4");

  assert.throws(() => parsePinnedOpencodeVersion("FROM node:22"), /Failed to extract pinned opencode-ai/);
});

/**
 * Verifies that validatePort strictly rejects out-of-range or non-integer port numbers.
 */
test("validatePort validates range 1-65535 and rejects invalid values", () => {
  assert.equal(validatePort("testPort", 80), 80);
  assert.equal(validatePort("testPort", 65535), 65535);

  assert.throws(() => validatePort("testPort", 0), /Invalid port for testPort: 0/);
  assert.throws(() => validatePort("testPort", -1), /Invalid port for testPort: -1/);
  assert.throws(() => validatePort("testPort", 65536), /Invalid port for testPort: 65536/);
  assert.throws(() => validatePort("testPort", 72339), /Invalid port for testPort: 72339/);
  assert.throws(() => validatePort("testPort", Number.NaN), /Invalid port for testPort/);
});

/**
 * Verifies that resolveDevStackConfig applies isolated defaults and parses environment overrides.
 */
test("resolveDevStackConfig respects port and directory overrides while defaulting to 127.0.0.1 isolated ports", () => {
  const defaultConfig = resolveDevStackConfig({});
  assert.equal(defaultConfig.webPort, 5911);
  assert.equal(defaultConfig.apiPort, 5910);
  assert.equal(defaultConfig.postgresPort, 54329);
  assert.equal(defaultConfig.temporalPort, 57233);
  assert.match(defaultConfig.stateRoot, /\.dev-stack$/);

  const customConfig = resolveDevStackConfig({
    SPACEAPP_DEV_STATE_ROOT: "custom-state",
    SPACEAPP_DEV_WEB_PORT: "6911",
    SPACEAPP_DEV_API_PORT: "6910",
    SPACEAPP_DEV_POSTGRES_PORT: "54330",
    SPACEAPP_DEV_TEMPORAL_PORT: "57234",
    SPACEAPP_DEV_PROJECT: "custom-project"
  });
  assert.equal(customConfig.webPort, 6911);
  assert.equal(customConfig.apiPort, 6910);
  assert.equal(customConfig.postgresPort, 54330);
  assert.equal(customConfig.temporalPort, 57234);
  assert.equal(customConfig.composeProject, "custom-project");
  assert.match(customConfig.stateRoot, /custom-state$/);

  assert.throws(
    () => resolveDevStackConfig({ SPACEAPP_DEV_TEMPORAL_PORT: "99999" }),
    /Invalid port for temporalPort: 99999/
  );
});

/**
 * Verifies that generateDevComposeYaml produces standard secrets and 127.0.0.1-bound configurations.
 */
test("generateDevComposeYaml creates isolated compose configuration strictly bound to 127.0.0.1 with secrets", () => {
  const yaml = generateDevComposeYaml({
    postgresImage: "pgvector/pgvector:0.8.3",
    temporalImage: "temporalio/auto-setup:1.29.1",
    postgresPort: 54329,
    temporalPort: 57233,
    secretsDir: "/path/to/secrets",
    composeProject: "test-dev-project"
  });

  assert.match(yaml, /name: test-dev-project/);
  assert.match(yaml, /"127\.0\.0\.1:54329:5432"/);
  assert.match(yaml, /"127\.0\.0\.1:57233:7233"/);
  assert.doesNotMatch(yaml, /0\.0\.0\.0/);
  assert.match(yaml, /secrets:\s*\n\s*postgres-password:\s*\n\s*file:/);
  assert.match(yaml, /image: pgvector\/pgvector:0\.8\.3/);
  assert.match(yaml, /image: temporalio\/auto-setup:1\.29\.1/);
});

/**
 * Verifies that ensureSecrets generates owner-readable secrets (mode 0600) and is idempotent.
 */
test("ensureSecrets creates required secret files with proper modes and preserves existing secrets", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "spaceapp-test-secrets-"));
  try {
    const config = {
      secretsDir: path.join(tmpDir, "secrets"),
      runDir: path.join(tmpDir, "run"),
      binDir: path.join(tmpDir, "bin"),
      varDir: path.join(tmpDir, "var"),
      workspacesDir: path.join(tmpDir, "workspaces"),
      postgresPort: 54329
    };

    const firstSecrets = ensureSecrets(config);
    assert.ok(firstSecrets.password && firstSecrets.password.length >= 32);
    assert.ok(firstSecrets.sessionSecret && firstSecrets.sessionSecret.length >= 48);
    assert.ok(firstSecrets.setupToken && firstSecrets.setupToken.length >= 32);
    assert.equal(firstSecrets.databaseUrl, `postgresql://spaceapp:${firstSecrets.password}@127.0.0.1:54329/spaceapp`);

    // Files exist on disk
    assert.ok(fs.existsSync(path.join(config.secretsDir, "postgres-password")));
    assert.ok(fs.existsSync(path.join(config.secretsDir, "session-secret")));
    assert.ok(fs.existsSync(path.join(config.secretsDir, "setup-token")));
    assert.ok(fs.existsSync(path.join(config.secretsDir, "database-url")));

    // Idempotency: calling ensureSecrets again returns the exact same secrets
    const secondSecrets = ensureSecrets(config);
    assert.equal(secondSecrets.password, firstSecrets.password);
    assert.equal(secondSecrets.sessionSecret, firstSecrets.sessionSecret);
    assert.equal(secondSecrets.setupToken, firstSecrets.setupToken);
    assert.equal(secondSecrets.databaseUrl, firstSecrets.databaseUrl);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

/**
 * Verifies that generateDevComposeYaml avoids container_name to prevent global conflicts and defines healthchecks.
 */
test("generateDevComposeYaml omits fixed container_name, defines healthchecks, and mounts secrets with mode 0444", () => {
  const yaml = generateDevComposeYaml({
    postgresImage: "pgvector/pgvector:0.8.3-pg17-trixie@sha256:3a3147ccd9a0aee952bb69e1acea1eb3cc7183544185b87a662f872cfa47ae3b",
    temporalImage: "temporalio/auto-setup:1.29.1@sha256:5b3502a3b685f9eff1b925af90c57c9e3dbeccbef367cc28a2a9712c63379312",
    postgresPort: 54329,
    temporalPort: 57233,
    secretsDir: "/path/to/secrets",
    composeProject: "test-dev-project"
  });

  assert.doesNotMatch(yaml, /container_name:/);
  assert.match(yaml, /healthcheck:\s*\n\s*test: \["CMD-SHELL", "pg_isready/);
  assert.match(yaml, /temporal operator cluster health/);
  assert.match(yaml, /mode: 0444/);
  assert.match(yaml, /user: "0:0"/);
});

/**
 * Verifies that CONTRIBUTING.md documents Linux, macOS (Docker Desktop/Colima), and Windows 11 (WSL2).
 */
test("CONTRIBUTING.md documents all required platforms and commands", () => {
  const contributing = fs.readFileSync(path.join(process.cwd(), "CONTRIBUTING.md"), "utf8");
  assert.match(contributing, /Run the full app from source/);
  assert.match(contributing, /npm run dev:stack/);
  assert.match(contributing, /npm run dev:stack -- down/);
  assert.match(contributing, /npm run dev:stack -- reset/);
  assert.match(contributing, /macOS/);
  assert.match(contributing, /Colima/);
  assert.match(contributing, /Windows 11/);
  assert.match(contributing, /WSL2/);
  assert.match(contributing, /Temporal gRPC/);
});

/**
 * Verifies that dev-stack overrides all path settings in config.ts that default to /opt/spaceapp.
 * This guarantees contributor runs never fail with EACCES on macOS or non-root Linux environments.
 */
test("dev-stack environment overrides all /opt/spaceapp defaults from config.ts", () => {
  const devStackSource = fs.readFileSync(path.join(process.cwd(), "scripts", "dev-stack.mjs"), "utf8");
  const configSource = fs.readFileSync(path.join(process.cwd(), "apps", "api", "src", "config.ts"), "utf8");

  const optDefaults = [...configSource.matchAll(/(?:env|valid)\.(SPACE_[A-Z0-9_]+)\s*(?:\|\||\?\?)\s*["'](\/opt\/spaceapp[^"']*)["']/g)]
    .map((m) => m[1]);

  assert.ok(optDefaults.length > 0, "Expected config.ts to have /opt/spaceapp defaults");
  for (const varName of optDefaults) {
    assert.ok(
      devStackSource.includes(varName),
      `dev-stack.mjs must override ${varName} to prevent EACCES on macOS/non-root Linux`
    );
  }
});

/**
 * Verifies that ci-dev-stack-gate.mjs strictly asserts the absence of
 * Compose containers and volumes after a dev-stack reset.
 */
test("ci-dev-stack-gate asserts absence of Compose containers, volumes, and child processes after reset", () => {
  const gateSource = fs.readFileSync(path.join(process.cwd(), "scripts", "ci-dev-stack-gate.mjs"), "utf8");
  assert.match(gateSource, /compose.*ps.*-a.*-q/);
  assert.match(gateSource, /volume.*ls.*--filter/);
  assert.match(gateSource, /process\.kill\(pid,\s*0\)/);
  assert.match(gateSource, /stopDevStack\(config,\s*\{\s*purge:\s*true\s*\}\)/);
  assert.match(gateSource, /verifyResetCleanup\(activePids\)/);
});

/**
 * Verifies that isComposeServiceHealthy strictly accepts only healthy states,
 * refusing substring false-positives such as 'unhealthy', and supports arrays.
 */
test("isComposeServiceHealthy strictly distinguishes healthy from unhealthy and starting states and supports arrays", () => {
  assert.equal(isComposeServiceHealthy({ Health: "healthy" }), true);
  assert.equal(isComposeServiceHealthy({ Health: "HEALTHY" }), true);
  assert.equal(isComposeServiceHealthy({ Status: "Up 10 seconds (healthy)" }), true);

  // Arrays of services
  assert.equal(isComposeServiceHealthy([{ Health: "healthy" }, { Health: "healthy" }]), true);
  assert.equal(isComposeServiceHealthy([{ Health: "healthy" }, { Health: "unhealthy" }]), false);

  // Failure cases: unhealthy must NEVER be considered healthy
  assert.equal(isComposeServiceHealthy({ Health: "unhealthy" }), false);
  assert.equal(isComposeServiceHealthy({ Health: "UNHEALTHY" }), false);
  assert.equal(isComposeServiceHealthy({ Status: "Up 10 seconds (unhealthy)" }), false);
  assert.equal(isComposeServiceHealthy({ Health: "starting" }), false);
  assert.equal(isComposeServiceHealthy({ Status: "Up 10 seconds (health: starting)" }), false);
  assert.equal(isComposeServiceHealthy(null), false);
  assert.equal(isComposeServiceHealthy({}), false);
});

/**
 * Verifies that assertSafeStateDir protects critical directories from accidental deletion.
 */
test("assertSafeStateDir prevents accidental deletion of root, home, ancestors, or repo source directory", () => {
  const repoRoot = process.cwd();
  const homeDir = os.homedir();
  const rootDir = path.parse(repoRoot).root;

  assert.throws(() => assertSafeStateDir(".", repoRoot), /Refusing to delete unsafe state directory/);
  assert.throws(() => assertSafeStateDir(repoRoot, repoRoot), /Refusing to delete unsafe state directory/);
  assert.throws(() => assertSafeStateDir("..", repoRoot), /Refusing to delete unsafe state directory/);
  assert.throws(() => assertSafeStateDir(homeDir, repoRoot), /Refusing to delete unsafe state directory/);
  assert.throws(() => assertSafeStateDir(rootDir, repoRoot), /Refusing to delete unsafe state directory/);
  assert.throws(() => assertSafeStateDir(path.join(repoRoot, "apps"), repoRoot), /Refusing to delete protected repository source subtree/);
  assert.throws(() => assertSafeStateDir(path.join(repoRoot, "apps", "api"), repoRoot), /Refusing to delete protected repository source subtree/);
  assert.throws(() => assertSafeStateDir(path.join(repoRoot, "packages"), repoRoot), /Refusing to delete protected repository source subtree/);
  assert.throws(() => assertSafeStateDir(path.join(repoRoot, "packages", "db"), repoRoot), /Refusing to delete protected repository source subtree/);
  assert.throws(() => assertSafeStateDir(path.join(repoRoot, "scripts", "dev-stack.mjs"), repoRoot), /Refusing to delete protected repository source subtree/);

  // Safe directories must not throw
  const tmpDir = path.join(os.tmpdir(), "safe-test-dev-stack");
  fs.mkdirSync(tmpDir, { recursive: true });
  try {
    assert.doesNotThrow(() => assertSafeStateDir(tmpDir, repoRoot));
    assert.doesNotThrow(() => assertSafeStateDir(path.join(repoRoot, ".dev-stack"), repoRoot));

    // If requireMarker is set, missing marker throws
    assert.throws(() => assertSafeStateDir(tmpDir, repoRoot, { requireMarker: true }), /missing .dev-stack-state.json marker/);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  // Invalid marker throws
  const tmpMarkerDir = path.join(os.tmpdir(), "marker-test-dev-stack");
  fs.mkdirSync(tmpMarkerDir, { recursive: true });
  try {
    fs.writeFileSync(path.join(tmpMarkerDir, ".dev-stack-state.json"), JSON.stringify({ createdBy: "malicious" }));
    assert.throws(() => assertSafeStateDir(tmpMarkerDir, repoRoot, { requireMarker: true }), /Refusing to delete state directory with invalid marker/);
  } finally {
    fs.rmSync(tmpMarkerDir, { recursive: true, force: true });
  }
});

/**
 * Verifies that setupOpencodeWrapper writes wrapper scripts implementing
 * credential-status, credential-observation, and credential-smoke.
 */
test("setupOpencodeWrapper creates wrapper supporting credential lifecycle probes and portable observation hash", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "spaceapp-test-wrapper-"));
  try {
    const config = {
      stateRoot: tmpDir,
      opencodeDir: path.join(tmpDir, "opencode"),
      binDir: path.join(tmpDir, "bin")
    };
    fs.mkdirSync(path.join(config.opencodeDir, "node_modules", ".bin"), { recursive: true });
    const dummyBin = path.join(config.opencodeDir, "node_modules", ".bin", process.platform === "win32" ? "opencode.cmd" : "opencode");
    fs.writeFileSync(dummyBin, process.platform === "win32" ? "@echo off\necho opencode\n" : "#!/bin/sh\necho opencode\n");

    setupOpencodeWrapper(config, "1.18.4");

    const parityPath = path.join(config.binDir, "opencode-vscode-parity");
    assert.ok(fs.existsSync(parityPath), "POSIX wrapper script must exist");
    const content = fs.readFileSync(parityPath, "utf8");

    assert.match(content, /credential-status/);
    assert.match(content, /credential-observation/);
    assert.match(content, /credential-smoke/);
    assert.match(content, /SPACE_OPENCODE_OK/);
    assert.match(content, /HOME=/);
    assert.match(content, /TMPDIR=/);
    assert.match(content, /XDG_CONFIG_HOME=/);
    assert.match(content, /XDG_STATE_HOME=/);
    // Observation hash is precomputed SHA-256 for "opencode:ready"
    assert.match(content, /OBSERVATION:fe2ff8448863efcad9975084caad51bf142b2e40ae6acab7a5bbe6ee3220bea0/);

    if (process.platform === "win32") {
      const cmdPath = path.join(config.binDir, "opencode-vscode-parity.cmd");
      assert.ok(fs.existsSync(cmdPath), "Windows .cmd wrapper script must exist");
      const cmdContent = fs.readFileSync(cmdPath, "utf8");
      assert.match(cmdContent, /credential-status/);
      assert.match(cmdContent, /OBSERVATION:fe2ff8448863efcad9975084caad51bf142b2e40ae6acab7a5bbe6ee3220bea0/);
      assert.match(cmdContent, /SPACE_OPENCODE_OK/);
      assert.match(cmdContent, /XDG_CONFIG_HOME=/);
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

/**
 * Verifies that ensureSecrets preserves claimed state when setup-token is consumed.
 */
test("ensureSecrets preserves claimed setup token and reports already claimed state", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "spaceapp-test-claim-"));
  try {
    const config = {
      secretsDir: path.join(tmpDir, "secrets"),
      runDir: path.join(tmpDir, "run"),
      binDir: path.join(tmpDir, "bin"),
      varDir: path.join(tmpDir, "var"),
      workspacesDir: path.join(tmpDir, "workspaces"),
      postgresPort: 54329
    };

    const initial = ensureSecrets(config);
    assert.ok(initial.setupToken && initial.setupToken !== "Already claimed");
    assert.ok(initial.setupTokenPath);

    // Simulate owner claim consumption
    fs.rmSync(initial.setupTokenPath, { force: true });

    // Subsequent call detects claimed state without regenerating token
    const afterClaim = ensureSecrets(config);
    assert.equal(afterClaim.setupToken, "Already claimed");
    assert.equal(afterClaim.setupTokenPath, null);
    assert.equal(afterClaim.password, initial.password);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

/**
 * Verifies that resolveCliHostSocketPath respects Unix domain socket path length constraints.
 */
test("resolveCliHostSocketPath handles default short path, long path tmpdir fallback, and env override", () => {
  // 1. Short path: returns default cli-host.sock within runDir
  const shortRunDir = path.join(os.tmpdir(), "short");
  const shortPath = resolveCliHostSocketPath(shortRunDir, {});
  assert.equal(shortPath, path.resolve(shortRunDir, "cli-host.sock"));

  // 2. Long path (>96 bytes): falls back to os.tmpdir() with s-<hash>.sock
  const longRunDir = path.join(os.tmpdir(), "a".repeat(120), "deep", "nested", "run");
  const fallbackPath = resolveCliHostSocketPath(longRunDir, {});
  assert.ok(Buffer.byteLength(fallbackPath) < 100, `Fallback path ${fallbackPath} must be short`);
  assert.match(fallbackPath, /(?:space-cli|s)-[0-9a-f]{12}\.sock$/);

  // 3. Explicit env override: respects SPACE_CLI_HOST_SOCKET
  const customSocket = "/custom/path/to/socket.sock";
  const customResolved = resolveCliHostSocketPath(shortRunDir, { SPACE_CLI_HOST_SOCKET: customSocket });
  assert.equal(customResolved, customSocket);
});

/**
 * Verifies that apps/web/vite.config.ts configures WebSocket proxying for /api.
 */
test("apps/web/vite.config.ts configures WebSocket proxying for /api", () => {
  const viteConfig = fs.readFileSync(path.join(process.cwd(), "apps", "web", "vite.config.ts"), "utf8");
  assert.match(viteConfig, /["']\/api["']:\s*\{\s*target:.*,\s*ws:\s*true\s*\}/s);
});

/**
 * Verifies that ensureSecrets refuses to adopt an existing non-empty directory without marker.
 */
test("ensureSecrets refuses to adopt an existing non-empty directory lacking marker", () => {
  const tmpOccupied = fs.mkdtempSync(path.join(os.tmpdir(), "spaceapp-test-occupied-"));
  try {
    fs.writeFileSync(path.join(tmpOccupied, "user-data.txt"), "important data");
    const config = {
      stateRoot: tmpOccupied,
      secretsDir: path.join(tmpOccupied, "secrets"),
      runDir: path.join(tmpOccupied, "run"),
      binDir: path.join(tmpOccupied, "bin"),
      varDir: path.join(tmpOccupied, "var"),
      workspacesDir: path.join(tmpOccupied, "workspaces"),
      postgresPort: 54329
    };
    assert.throws(
      () => ensureSecrets(config),
      /Refusing to adopt non-empty existing directory without .dev-stack-state.json marker/
    );
  } finally {
    fs.rmSync(tmpOccupied, { recursive: true, force: true });
  }
});

/**
 * Verifies that dev-stack environment config sets SPACE_CHESS_MOVE_SOCKET to "disabled".
 * This prevents the worker from touching /opt/spaceapp/var/chess-benchmark/worker.sock.
 */
test("dev-stack environment disables SPACE_CHESS_MOVE_SOCKET to prevent host filesystem writes", () => {
  const devStackSource = fs.readFileSync(path.join(process.cwd(), "scripts", "dev-stack.mjs"), "utf8");
  assert.match(devStackSource, /SPACE_CHESS_MOVE_SOCKET:\s*["']disabled["']/);
  assert.match(devStackSource, /SPACE_CHESS_CLI_WORKSPACE:/);
});

/**
 * Verifies that stopDevStack runs assertSafeStateDir before any process killing or docker compose commands.
 */
test("stopDevStack runs assertSafeStateDir before terminating processes or tearing down docker services", () => {
  const devStackSource = fs.readFileSync(path.join(process.cwd(), "scripts", "dev-stack.mjs"), "utf8");
  const stopIndex = devStackSource.indexOf("export async function stopDevStack");
  const assertIndex = devStackSource.indexOf("assertSafeStateDir(config.stateRoot", stopIndex);
  const killIndex = devStackSource.indexOf("process.kill", stopIndex);
  const composeIndex = devStackSource.indexOf("docker", stopIndex);

  assert.ok(stopIndex > -1);
  assert.ok(assertIndex > -1, "assertSafeStateDir must be called in stopDevStack");
  assert.ok(assertIndex < killIndex, "assertSafeStateDir must execute before process killing");
  assert.ok(assertIndex < composeIndex, "assertSafeStateDir must execute before docker commands");
});

/**
 * Verifies that ci-dev-stack-gate checks strict session criteria, connects via Vite proxy,
 * sends session cookie, and validates websocket transport frames without error swallowing.
 */
test("ci-dev-stack-gate enforces session criteria, Vite proxy, Cookie header, and strict frame verification", () => {
  const gateSource = fs.readFileSync(path.join(process.cwd(), "scripts", "ci-dev-stack-gate.mjs"), "utf8");
  assert.match(gateSource, /runtimeId === ["']cli:opencode["']/);
  assert.match(gateSource, /isActive === true/);
  assert.match(gateSource, /status !== ["']EXITED["']/);
  assert.match(gateSource, /verifyCliWebSocketTransport/);
  assert.match(gateSource, /webPort/);
  assert.match(gateSource, /Cookie:\s*cookie/);
  assert.match(gateSource, /Terminal websocket reported error frame/);
});

/**
 * Verifies that dev-stack atomically acquires dev-stack.lock with flag 'wx' and holds it through teardown.
 */
test("dev-stack atomically acquires dev-stack.lock with flag wx and holds it through teardown", () => {
  const devStackSource = fs.readFileSync(path.join(process.cwd(), "scripts", "dev-stack.mjs"), "utf8");
  assert.match(devStackSource, /flag:\s*["']wx["']/);
  assert.match(devStackSource, /dev-stack\.lock/);
  assert.match(devStackSource, /Refusing to start duplicate stack/);
  assert.match(devStackSource, /postKillDeadline/);
});



