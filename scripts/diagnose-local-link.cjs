#!/usr/bin/env node

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");

const mobileDir = path.resolve(__dirname, "..");
const defaultDesktopDir = path.resolve(mobileDir, "..", "deepseektuidesk");
const defaultMobilePort = 5174;
const defaultBridgePort = 8765;

const args = parseArgs(process.argv.slice(2));
const timeoutMs = numberArg("timeout-ms", 8000);
const mobilePort = numberArg("mobile-port", defaultMobilePort);
const mobileUrl = stringArg("mobile-url", `http://127.0.0.1:${mobilePort}`);
const desktopDir = path.resolve(stringArg("desktop-dir", defaultDesktopDir));
const shouldStartWeb = !hasFlag("no-start-web");
const shouldFetch = !hasFlag("no-fetch");
const skipBridge = hasFlag("skip-bridge");
const jsonOutput = hasFlag("json");

const checks = [];
let startedWebProcess = null;

process.on("SIGINT", () => {
  cleanup();
  process.exit(130);
});
process.on("SIGTERM", () => {
  cleanup();
  process.exit(143);
});
process.on("exit", cleanup);

main().catch((error) => {
  addCheck("diagnostic runner", "fail", error.message || String(error));
  printReport();
  process.exitCode = 1;
});

async function main() {
  if (hasFlag("help") || hasFlag("h")) {
    printHelp();
    return;
  }

  const mobilePackage = readPackageJson(mobileDir);
  const desktopPackage = readPackageJson(desktopDir);

  addCheck("mobile package", mobilePackage ? "pass" : "fail", mobilePackage
    ? `${mobilePackage.name}@${mobilePackage.version}`
    : `missing package.json in ${mobileDir}`);
  addCheck("desktop package", desktopPackage ? "pass" : "fail", desktopPackage
    ? `${desktopPackage.name}@${desktopPackage.version}`
    : `missing package.json in ${desktopDir}`);

  checkGitVersion("mobile repo", mobileDir, shouldFetch);
  if (fs.existsSync(desktopDir)) {
    checkGitVersion("desktop repo", desktopDir, shouldFetch);
  } else {
    addCheck("desktop repo", "fail", `desktop dir not found: ${desktopDir}`);
  }

  if (desktopPackage) {
    checkInstalledDesktopApp(desktopPackage.version);
  }

  await checkMobileWeb();

  if (skipBridge) {
    addCheck("desktop bridge", "warn", "skipped by --skip-bridge");
  } else {
    await checkDesktopBridge();
  }

  printReport();
  cleanup();
  process.exitCode = checks.some((check) => check.status === "fail") ? 1 : 0;
}

async function checkMobileWeb() {
  let existing = await requestText(mobileUrl).catch(() => null);
  if (!existing && shouldStartWeb) {
    startedWebProcess = startMobileWebServer(mobilePort);
    existing = await waitForWeb(mobileUrl);
  }

  if (!existing) {
    addCheck("mobile web page", "fail", `not reachable: ${mobileUrl}`);
    return;
  }

  const ok = existing.status >= 200 && existing.status < 300;
  const hasTitle = existing.text.includes("DeepSeek TUI Mobile");
  addCheck("mobile web page", ok && hasTitle ? "pass" : "fail", `${mobileUrl} HTTP ${existing.status}${hasTitle ? "" : "; title marker missing"}`);
}

async function checkDesktopBridge() {
  const settings = loadDesktopSettings();
  const bridgeUrl = normalizeUrl(stringArg("bridge-url", bridgeUrlFromSettings(settings)));
  const bridgeToken = stringArg("bridge-token", process.env.DEEPSEEK_TUI_BRIDGE_TOKEN || settings?.mobileBridgeToken || "");

  const health = await requestJson(`${bridgeUrl}/api/v1/health`).catch((error) => ({ error }));
  if (health.error) {
    addCheck("desktop bridge health", "fail", `${bridgeUrl}/api/v1/health unreachable: ${health.error.message}`);
    return;
  }
  addCheck("desktop bridge health", health.status >= 200 && health.status < 300 ? "pass" : "fail", `${bridgeUrl} HTTP ${health.status}`);

  const cors = await requestText(`${bridgeUrl}/api/v1/status`, { method: "OPTIONS" }).catch((error) => ({ error }));
  if (cors.error) {
    addCheck("desktop bridge CORS", "warn", cors.error.message);
  } else {
    const allowOrigin = cors.headers.get("access-control-allow-origin") || "";
    addCheck("desktop bridge CORS", allowOrigin === "*" ? "pass" : "warn", `access-control-allow-origin: ${allowOrigin || "(missing)"}`);
  }

  if (!bridgeToken) {
    addCheck("authenticated bridge status", "warn", "missing bridge token; pass --bridge-token or set DEEPSEEK_TUI_BRIDGE_TOKEN");
    return;
  }

  const status = await requestJson(`${bridgeUrl}/api/v1/status`, {
    headers: { authorization: `Bearer ${bridgeToken}` }
  }).catch((error) => ({ error }));

  if (status.error) {
    addCheck("authenticated bridge status", "fail", status.error.message);
    return;
  }

  if (status.status === 401 || status.status === 403) {
    addCheck("authenticated bridge status", "fail", `HTTP ${status.status}; token rejected`);
    return;
  }

  const payload = status.payload || {};
  const remoteStatus = payload.status || {};
  const connected = payload.ok === true && remoteStatus.auth && remoteStatus.auth.desktopId;
  addCheck("authenticated bridge status", connected ? "pass" : "fail", connected
    ? `desktop ${remoteStatus.auth.desktopId}; relay=${remoteStatus.relay?.connected ? "connected" : "not-connected"}; control=${remoteStatus.mobileRemoteControlEnabled ? "enabled" : "disabled"}`
    : `unexpected response HTTP ${status.status}`);
}

function checkGitVersion(label, repoDir, fetchFirst) {
  if (!fs.existsSync(path.join(repoDir, ".git"))) {
    addCheck(label, "warn", `not a git repo: ${repoDir}`);
    return;
  }

  if (fetchFirst) {
    const fetch = run("git", ["fetch", "--quiet", "--prune"], repoDir, 20000);
    if (fetch.status !== 0) {
      addCheck(`${label} fetch`, "warn", trimOutput(fetch.stderr || fetch.stdout) || "git fetch failed");
    }
  }

  const branch = run("git", ["branch", "--show-current"], repoDir).stdout.trim() || "(detached)";
  const head = run("git", ["rev-parse", "--short", "HEAD"], repoDir).stdout.trim();
  const dirty = run("git", ["status", "--porcelain"], repoDir).stdout.trim();
  const upstream = run("git", ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"], repoDir);

  if (upstream.status !== 0) {
    addCheck(label, "warn", `${branch}@${head}; no upstream configured${dirty ? "; dirty worktree" : ""}`);
    return;
  }

  const counts = run("git", ["rev-list", "--left-right", "--count", "HEAD...@{u}"], repoDir);
  if (counts.status !== 0) {
    addCheck(label, "warn", `${branch}@${head}; unable to compare upstream`);
    return;
  }

  const [ahead, behind] = counts.stdout.trim().split(/\s+/).map((value) => Number(value || 0));
  const status = behind > 0 ? "fail" : dirty ? "warn" : "pass";
  const detail = `${branch}@${head}; ahead=${ahead}; behind=${behind}; upstream=${upstream.stdout.trim()}${dirty ? "; dirty worktree" : ""}`;
  addCheck(label, status, detail);
}

function checkInstalledDesktopApp(expectedVersion) {
  const appPath = path.resolve(stringArg("app-path", "/Applications/DeepSeek TUI Desktop.app"));
  if (!fs.existsSync(appPath)) {
    addCheck("installed desktop app", "warn", `not found: ${appPath}`);
    return;
  }

  const plistPath = path.join(appPath, "Contents", "Info.plist");
  const version = readPlistValue(plistPath, "CFBundleShortVersionString") || readPlistValue(plistPath, "CFBundleVersion");
  if (!version) {
    addCheck("installed desktop app", "warn", `unable to read version from ${plistPath}`);
    return;
  }

  addCheck("installed desktop app", version === expectedVersion ? "pass" : "fail", `installed=${version}; repo=${expectedVersion}; path=${appPath}`);
}

function loadDesktopSettings() {
  const explicit = stringArg("settings-file", process.env.DEEPSEEK_TUI_DESKTOP_SETTINGS || "");
  const candidates = [
    explicit,
    path.join(os.homedir(), "Library", "Application Support", "DeepSeek TUI Desktop", "settings.json"),
    path.join(os.homedir(), "Library", "Application Support", "deepseek-tui-desktop", "settings.json"),
    path.join(os.homedir(), "Library", "Application Support", "deepseek-tui-desktop", "settings.json")
  ].filter(Boolean);

  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) {
        const parsed = JSON.parse(fs.readFileSync(candidate, "utf8"));
        addCheck("desktop settings", "pass", candidate);
        return parsed;
      }
    } catch (error) {
      addCheck("desktop settings", "warn", `${candidate}: ${error.message}`);
    }
  }

  addCheck("desktop settings", "warn", "settings.json not found; using default bridge URL and env/CLI token");
  return null;
}

function bridgeUrlFromSettings(settings) {
  const port = Number(settings?.mobileBridgePort) || defaultBridgePort;
  const host = settings?.mobileBridgeHost && settings.mobileBridgeHost !== "0.0.0.0"
    ? settings.mobileBridgeHost
    : "127.0.0.1";
  return `http://${host}:${port}`;
}

function startMobileWebServer(port) {
  const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
  const child = spawn(npmCommand, ["run", "dev", "--", "--host", "127.0.0.1", "--port", String(port)], {
    cwd: mobileDir,
    env: { ...process.env, BROWSER: "none" },
    stdio: ["ignore", "pipe", "pipe"]
  });
  child.stdout.on("data", () => undefined);
  child.stderr.on("data", () => undefined);
  return child;
}

async function waitForWeb(url) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const result = await requestText(url);
      if (result.status >= 200 && result.status < 500) return result;
    } catch (error) {
      lastError = error;
    }
    await sleep(250);
  }
  if (lastError) {
    addCheck("mobile web startup", "fail", lastError.message);
  }
  return null;
}

async function requestJson(url, options = {}) {
  const result = await requestText(url, options);
  let payload = null;
  try {
    payload = result.text ? JSON.parse(result.text) : null;
  } catch {
    payload = { raw: result.text };
  }
  return { ...result, payload };
}

async function requestText(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    return {
      status: response.status,
      headers: response.headers,
      text: await response.text()
    };
  } finally {
    clearTimeout(timer);
  }
}

function readPackageJson(repoDir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(repoDir, "package.json"), "utf8"));
  } catch {
    return null;
  }
}

function readPlistValue(plistPath, key) {
  if (!fs.existsSync(plistPath)) return "";
  const result = run("/usr/libexec/PlistBuddy", ["-c", `Print :${key}`, plistPath], mobileDir);
  return result.status === 0 ? result.stdout.trim() : "";
}

function run(command, commandArgs, cwd, timeout = 10000) {
  return spawnSync(command, commandArgs, {
    cwd,
    encoding: "utf8",
    timeout,
    env: process.env
  });
}

function addCheck(name, status, detail) {
  checks.push({ name, status, detail });
}

function printReport() {
  if (jsonOutput) {
    console.log(JSON.stringify({ ok: !checks.some((check) => check.status === "fail"), checks }, null, 2));
    return;
  }

  console.log("\nDeepSeek TUI local link diagnostic\n");
  for (const check of checks) {
    const mark = check.status === "pass" ? "PASS" : check.status === "warn" ? "WARN" : "FAIL";
    console.log(`[${mark}] ${check.name}`);
    if (check.detail) console.log(`       ${check.detail}`);
  }
  console.log("");
}

function printHelp() {
  console.log(`DeepSeek TUI local link diagnostic

Usage:
  npm run diagnose:local -- [options]

Options:
  --mobile-url <url>       Mobile web URL to check. Default: http://127.0.0.1:5174
  --mobile-port <port>     Port used when starting the local mobile Vite server. Default: 5174
  --no-start-web           Do not start the mobile web server if the page is not already reachable.
  --desktop-dir <path>     Desktop repo path. Default: ../deepseektuidesk
  --bridge-url <url>       Desktop local Bridge URL. Default: settings or http://127.0.0.1:8765
  --bridge-token <token>   Desktop Bridge token. Default: settings or DEEPSEEK_TUI_BRIDGE_TOKEN
  --settings-file <path>   Desktop settings.json path.
  --app-path <path>        Installed macOS app path. Default: /Applications/DeepSeek TUI Desktop.app
  --no-fetch               Skip git fetch before latest-version comparison.
  --skip-bridge            Skip desktop Bridge communication checks.
  --timeout-ms <ms>        Request/startup timeout. Default: 8000
  --json                   Print machine-readable JSON.
`);
}

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (!item.startsWith("--")) continue;
    const key = item.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) {
      parsed[key] = true;
    } else {
      parsed[key] = next;
      index += 1;
    }
  }
  return parsed;
}

function hasFlag(name) {
  return args[name] === true;
}

function stringArg(name, fallback) {
  return typeof args[name] === "string" && args[name].trim() ? args[name].trim() : fallback;
}

function numberArg(name, fallback) {
  const value = Number(args[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function normalizeUrl(url) {
  return String(url || "").replace(/\/+$/, "");
}

function trimOutput(value) {
  return String(value || "").trim().split(/\r?\n/).slice(0, 3).join(" ");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function cleanup() {
  if (startedWebProcess && !startedWebProcess.killed) {
    startedWebProcess.kill("SIGTERM");
    startedWebProcess = null;
  }
}
