#!/usr/bin/env node
/**
 * Opt-in release acceptance test against real Claude Code and/or Codex installations.
 *
 * This is intentionally not part of hermetic CI: it clones the configured marketplace, downloads
 * the published pinned runtimes, and performs one authenticated extraction with each selected
 * host. It uses fresh host homes and runs all runtime checks from the installed cache path, never
 * from this checkout.
 *
 * Usage:
 *   COMMONWEALTH_FRESH_MARKETPLACE_SMOKE=1 \
 *     ANTHROPIC_API_KEY=... OPENAI_API_KEY=... \
 *     node scripts/smoke-fresh-marketplace.mjs both
 */
import { spawn } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { clearTimeout, setTimeout } from "node:timers";
import { fileURLToPath, pathToFileURL } from "node:url";
import { PLUGIN_RUNTIME_FILES } from "./release.mjs";

const ENABLE_ENV = "COMMONWEALTH_FRESH_MARKETPLACE_SMOKE";
const source = process.env.COMMONWEALTH_MARKETPLACE_SOURCE ?? "kristoffeys/commonwealth";
const marketplaceSha = process.env.COMMONWEALTH_MARKETPLACE_SHA ?? "";
const selected = process.argv[2] ?? "both";
const hosts = selected === "both" ? ["claude", "codex"] : [selected];
const checkoutRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function fail(message) {
  throw new Error(message);
}

function assert(condition, message) {
  if (!condition) fail(message);
}

function assertConfiguration() {
  if (process.env[ENABLE_ENV] !== "1") {
    fail(`refusing network/authenticated smoke without ${ENABLE_ENV}=1`);
  }
  if (!hosts.every((host) => ["claude", "codex"].includes(host))) {
    fail("usage: node scripts/smoke-fresh-marketplace.mjs <claude|codex|both>");
  }
  if (!/^[0-9a-f]{40}$/i.test(marketplaceSha)) {
    fail("COMMONWEALTH_MARKETPLACE_SHA must be the full 40-character release commit SHA");
  }
  if (
    hosts.includes("claude") &&
    !process.env.ANTHROPIC_API_KEY &&
    !process.env.CLAUDE_CODE_OAUTH_TOKEN
  ) {
    fail("Claude smoke needs ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN for the clean host home");
  }
  if (hosts.includes("codex") && !process.env.OPENAI_API_KEY) {
    fail("Codex smoke needs OPENAI_API_KEY for the clean CODEX_HOME");
  }
}

async function prepareMarketplace(root, cwd, env) {
  const marketplaceRoot = path.join(root, "marketplace");
  const gitSource =
    source.includes("://") || source.startsWith("git@") || path.isAbsolute(source)
      ? source
      : `https://github.com/${source}.git`;
  await checked(
    "git",
    ["clone", "--filter=blob:none", "--no-checkout", gitSource, marketplaceRoot],
    {
      cwd,
      env,
      timeoutMs: 240_000,
    },
  );
  await checked("git", ["-C", marketplaceRoot, "checkout", "--detach", marketplaceSha], {
    cwd,
    env,
    timeoutMs: 240_000,
  });
  const resolved = (
    await checked("git", ["-C", marketplaceRoot, "rev-parse", "HEAD"], { cwd, env })
  ).trim();
  assert(
    resolved.toLowerCase() === marketplaceSha.toLowerCase(),
    `marketplace checkout resolved ${resolved}, expected immutable commit ${marketplaceSha}`,
  );
  return { marketplaceRoot, gitSource };
}

function run(command, args, { cwd, env, input, timeoutMs = 180_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback(value);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.stdout.on("data", (chunk) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk) => (stderr += chunk.toString()));
    child.on("error", (error) => finish(reject, error));
    child.on("close", (code, signal) => {
      finish(resolve, { code, signal, stdout, stderr, timedOut });
    });
    child.stdin.on("error", (error) => finish(reject, error));
    child.stdin.end(input ?? "");
  });
}

async function checked(command, args, options) {
  const result = await run(command, args, options);
  if (result.code !== 0) {
    const detail = result.stderr.trim().replace(/\s+/g, " ").slice(0, 1_000);
    fail(`${command} ${args.join(" ")} failed (${String(result.code)}): ${detail}`);
  }
  return result.stdout;
}

function parseJson(output, description) {
  try {
    return JSON.parse(output);
  } catch {
    fail(`${description} did not return JSON`);
  }
}

function installedPath(host, listing) {
  const entries = Array.isArray(listing) ? listing : (listing?.plugins ?? []);
  const plugin = entries.find((entry) => entry.id === "commonwealth@commonwealth");
  return host === "claude" ? plugin?.installPath : undefined;
}

function assertInstalledPayload(root) {
  if (!root || !existsSync(root))
    fail(`host did not report a live plugin installation path: ${root}`);
  const resolved = path.resolve(root);
  if (resolved === checkoutRoot || resolved.startsWith(`${checkoutRoot}${path.sep}`)) {
    fail(
      `host resolved the plugin inside the source checkout instead of its install cache: ${root}`,
    );
  }
  const missing = PLUGIN_RUNTIME_FILES.filter((file) => !existsSync(path.join(root, file)));
  if (missing.length > 0) fail(`installed plugin payload is incomplete: ${missing.join(", ")}`);
}

function installedVersion(pluginRoot) {
  const claude = JSON.parse(
    readFileSync(path.join(pluginRoot, ".claude-plugin", "plugin.json"), "utf8"),
  );
  const codex = JSON.parse(
    readFileSync(path.join(pluginRoot, ".codex-plugin", "plugin.json"), "utf8"),
  );
  assert(
    typeof claude.version === "string" && claude.version === codex.version,
    `installed host manifest versions disagree at ${pluginRoot}`,
  );
  return claude.version;
}

async function install(host, marketplaceRoot, gitSource, cwd, env) {
  if (host === "claude") {
    await checked("claude", ["plugin", "marketplace", "add", marketplaceRoot, "--scope", "user"], {
      cwd,
      env,
    });
    await checked("claude", ["plugin", "install", "commonwealth@commonwealth", "--scope", "user"], {
      cwd,
      env,
    });
    const output = await checked("claude", ["plugin", "list", "--json"], { cwd, env });
    return installedPath(host, parseJson(output, "claude plugin list"));
  }

  await checked(
    "codex",
    ["plugin", "marketplace", "add", gitSource, "--ref", marketplaceSha, "--json"],
    { cwd, env, timeoutMs: 240_000 },
  );
  const added = parseJson(
    await checked("codex", ["plugin", "add", "commonwealth@commonwealth", "--json"], {
      cwd,
      env,
    }),
    "codex plugin add",
  );
  const installRoot = added?.installedPath;
  assert(
    typeof installRoot === "string" && installRoot.length > 0,
    "codex plugin add did not report its installed cache path",
  );
  const listed = parseJson(
    await checked("codex", ["plugin", "list", "--json"], { cwd, env }),
    "codex plugin list",
  );
  const entries = Array.isArray(listed) ? listed : (listed?.installed ?? []);
  assert(
    entries.some((entry) => entry?.pluginId === "commonwealth@commonwealth"),
    "codex plugin list did not confirm the installed plugin",
  );
  return installRoot;
}

async function initializePublishedBrain(version, brainDir, projectRoot, env) {
  await checked(
    "npx",
    [
      "-y",
      `@cmnwlth/cli@${version}`,
      "init",
      "--brain",
      brainDir,
      "--yes",
      "--no-seed",
      "--no-plugin",
      "--no-daemon",
      "--no-build",
      "--sync",
      projectRoot,
      "--agent",
      selected,
    ],
    { cwd: projectRoot, env, timeoutMs: 240_000 },
  );
  assert(
    existsSync(path.join(brainDir, ".commonwealth", "schema-version")),
    `published @cmnwlth/cli@${version} did not initialize the brain`,
  );
  assert(
    existsSync(path.join(env.HOME, ".commonwealth", "config.json")),
    "published init did not create the isolated user registry/scope config",
  );
  console.error(`brain: initialized by @cmnwlth/cli@${version}`);
}

async function probeCurate(pluginRoot, cwd, env) {
  const moduleUrl = pathToFileURL(path.join(pluginRoot, "hooks", "lib.mjs")).href;
  const output = await checked(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      `
        const module = await import(${JSON.stringify(moduleUrl)});
        const result = await module.probeCurateRuntime({ timeoutMs: 180000 });
        process.stdout.write(JSON.stringify(result));
      `,
    ],
    { cwd, env, timeoutMs: 200_000 },
  );
  const probe = parseJson(output, "installed curate probe");
  if (!probe.ok) fail(`installed curate runtime failed: ${probe.command}: ${probe.error}`);
  console.error(`  curate: ${probe.kind} (${probe.version})`);
}

async function stopProcessTree(child, cwd, env) {
  const signal = (name) => {
    try {
      if (process.platform !== "win32" && child.pid) process.kill(-child.pid, name);
      else child.kill(name);
    } catch {
      // The process tree may already be gone.
    }
  };
  if (process.platform === "win32" && child.pid) {
    await run("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
      cwd,
      env,
      timeoutMs: 10_000,
    }).catch(() => null);
  } else {
    signal("SIGTERM");
    await Promise.race([
      new Promise((resolve) => child.once("exit", resolve)),
      new Promise((resolve) => setTimeout(resolve, 5_000)),
    ]);
    signal("SIGKILL");
  }
  child.stdin.destroy();
  child.stdout.destroy();
  child.stderr.destroy();
}

async function exerciseMcp(pluginRoot, brainDir, cwd, env, marker) {
  const config = JSON.parse(readFileSync(path.join(pluginRoot, ".mcp.json"), "utf8"));
  const server = config.mcpServers?.commonwealth;
  if (!server || typeof server.command !== "string" || !Array.isArray(server.args)) {
    fail("installed .mcp.json has no commonwealth stdio server");
  }
  const child = spawn(server.command, server.args, {
    cwd,
    env: { ...env, COMMONWEALTH_BRAIN_DIR: brainDir },
    stdio: ["pipe", "pipe", "pipe"],
    detached: process.platform !== "win32",
  });
  let buffer = "";
  let stderr = "";
  let spawnError = null;
  const pending = new Map();
  const rejectPending = (error) => {
    spawnError = error;
    for (const entry of pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    pending.clear();
  };
  child.on("error", rejectPending);
  child.stdin.on("error", rejectPending);
  child.on("exit", (code, signal) => {
    if (pending.size === 0) return;
    rejectPending(
      new Error(
        `published MCP server exited before replying (code=${String(code)}, signal=${String(signal)}): ${stderr.trim().slice(0, 500)}`,
      ),
    );
  });
  child.stderr.on("data", (chunk) => (stderr += chunk.toString()));
  child.stdout.on("data", (chunk) => {
    buffer += chunk.toString();
    for (;;) {
      const newline = buffer.indexOf("\n");
      if (newline < 0) break;
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      try {
        const message = JSON.parse(line);
        const entry = pending.get(message.id);
        if (!entry) continue;
        clearTimeout(entry.timer);
        pending.delete(message.id);
        if (message.error) {
          entry.reject(new Error(`${entry.method} failed: ${JSON.stringify(message.error)}`));
        } else {
          entry.resolve(message.result);
        }
      } catch {
        // Ignore non-protocol diagnostics; stderr is included if the request times out.
      }
    }
  });
  const request = (id, method, params = {}) =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        const detail = spawnError?.message ?? stderr.trim().slice(0, 500);
        reject(new Error(`${method} timed out: ${detail}`));
      }, 180_000);
      pending.set(id, { resolve, reject, timer, method });
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });

  try {
    await request(1, "initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "commonwealth-release-smoke", version: "1" },
    });
    child.stdin.write(
      `${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`,
    );
    const listed = await request(2, "tools/list");
    const names = (listed?.tools ?? []).map((tool) => tool.name).sort();
    const expected = ["ask", "list-work-state", "read", "remember", "search", "who-is"];
    if (JSON.stringify(names) !== JSON.stringify(expected)) {
      fail(`published MCP tool inventory mismatch: ${names.join(", ")}`);
    }

    const title = `Marketplace write ${marker}`;
    const body = `The standalone release proof marker is ${marker}.`;
    const remembered = await request(3, "tools/call", {
      name: "remember",
      arguments: { kind: "memory", title, body, tags: ["release-smoke"] },
    });
    assert(!remembered?.isError, `MCP remember failed: ${JSON.stringify(remembered)}`);
    assert(
      ["promoted", "staged"].includes(remembered?.structuredContent?.status),
      `MCP remember did not accept the note: ${JSON.stringify(remembered?.structuredContent)}`,
    );

    const searched = await request(4, "tools/call", {
      name: "search",
      arguments: { query: marker, limit: 10 },
    });
    assert(!searched?.isError, `MCP search failed: ${JSON.stringify(searched)}`);
    const hit = searched?.structuredContent?.results?.find((entry) => entry.title === title);
    assert(hit?.path, `MCP search could not find the remembered marker ${marker}`);

    const read = await request(5, "tools/call", {
      name: "read",
      arguments: { path: hit.path },
    });
    assert(!read?.isError, `MCP read failed: ${JSON.stringify(read)}`);
    assert(
      read?.structuredContent?.body === body,
      `MCP read returned the wrong body for ${hit.path}`,
    );
    console.error(`  MCP: remember → search → read (${names.length} tools over stdio)`);
    return { title, body, path: hit.path };
  } finally {
    await stopProcessTree(child, cwd, env);
  }
}

async function invokeSessionStart(host, pluginRoot, projectRoot, env) {
  const entry =
    host === "codex"
      ? path.join(pluginRoot, "hooks", "codex-hook.mjs")
      : path.join(pluginRoot, "hooks", "session-start.mjs");
  const args = host === "codex" ? [entry, "SessionStart"] : [entry];
  const stdout = await checked(process.execPath, args, {
    cwd: projectRoot,
    env,
    input: JSON.stringify({ cwd: projectRoot, session_id: `release-smoke-${host}` }),
    timeoutMs: 180_000,
  });
  return parseJson(stdout, `${host} installed SessionStart hook`);
}

function injectedContext(output) {
  return output?.hookSpecificOutput?.additionalContext ?? "";
}

async function assertProactiveContext(host, pluginRoot, projectRoot, env, marker) {
  const output = await invokeSessionStart(host, pluginRoot, projectRoot, env);
  assert(
    injectedContext(output).includes(marker),
    `${host} SessionStart did not inject the MCP-written marker ${marker}`,
  );
  console.error("  context: installed SessionStart injected the remembered note");
}

function installFakeExtractor(projectRoot, host, candidate) {
  const binDir = mkdtempSync(path.join(projectRoot, `.fake-${host}-extractor-`));
  const payload = host === "codex" ? { candidates: [candidate] } : [candidate];
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64");
  const code = `process.stdout.write(Buffer.from('${encoded}','base64').toString())`;
  if (process.platform === "win32") {
    writeFileSync(
      path.join(binDir, `${host}.cmd`),
      `@echo off\r\n"${process.execPath}" -e "${code}"\r\n`,
    );
  } else {
    const executable = path.join(binDir, host);
    writeFileSync(executable, `#!${process.execPath}\n${code}\n`);
    chmodSync(executable, 0o755);
  }
  return binDir;
}

async function runInstalledCaptureEntry(host, pluginRoot, projectRoot, env, input) {
  const entry =
    host === "codex"
      ? path.join(pluginRoot, "hooks", "codex-hook.mjs")
      : path.join(pluginRoot, "hooks", "session-end.mjs");
  const args = host === "codex" ? [entry, "Stop"] : [entry];
  await checked(process.execPath, args, {
    cwd: projectRoot,
    env,
    input: JSON.stringify(input),
    timeoutMs: 30_000,
  });
}

async function waitForReceipt(file, expected) {
  const deadline = Date.now() + 240_000;
  for (;;) {
    try {
      const receipt = JSON.parse(readFileSync(file, "utf8"));
      if (typeof receipt?.message === "string" && receipt.message.includes(expected))
        return receipt;
    } catch {
      // The detached worker has not atomically produced a readable receipt yet.
    }
    if (Date.now() >= deadline)
      fail(`timed out waiting for capture receipt containing ${expected}`);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

async function exerciseCapture(host, pluginRoot, projectRoot, env, marker) {
  const title = `Captured from ${host} ${marker}`;
  const body = `The installed ${host} lifecycle captured deterministic marker ${marker}.`;
  const transcript = path.join(projectRoot, `${host}-capture-transcript.jsonl`);
  writeFileSync(transcript, `${JSON.stringify({ message: { role: "user", content: body } })}\n`);
  const candidate = { kind: "memory", title, body, tags: ["release-smoke", host] };
  const binDir = installFakeExtractor(projectRoot, host, candidate);
  const receiptPath = path.join(projectRoot, `${host}-${marker}-success-receipt.json`);
  const captureEnv = {
    ...env,
    PATH: `${binDir}${path.delimiter}${env.PATH ?? ""}`,
    COMMONWEALTH_RECEIPT: receiptPath,
    COMMONWEALTH_PROMPT_CAPTURE_MS: "1",
  };
  await runInstalledCaptureEntry(host, pluginRoot, projectRoot, captureEnv, {
    cwd: projectRoot,
    transcript_path: transcript,
    session_id: `release-smoke-${host}-${marker}`,
  });
  await waitForReceipt(receiptPath, title);

  // SessionStart proves the actual detached entry/worker persisted the note and consumes the real
  // deferred receipt written by that worker.
  const start = await invokeSessionStart(host, pluginRoot, projectRoot, captureEnv);
  assert(
    injectedContext(start).includes(marker),
    `${host} SessionStart could not read the captured note`,
  );
  assert(
    start?.systemMessage?.includes(title),
    `${host} SessionStart did not surface the successful capture receipt`,
  );
  console.error("  capture: installed host entry + detached worker persisted and receipted a note");
  return transcript;
}

async function exerciseFailureReceipt(host, pluginRoot, projectRoot, env, transcript) {
  const emptyBin = mkdtempSync(path.join(projectRoot, `.missing-${host}-extractor-`));
  const receiptPath = path.join(projectRoot, `${host}-failure-receipt.json`);
  const failureEnv = {
    ...env,
    PATH: emptyBin,
    COMMONWEALTH_RECEIPT: receiptPath,
    COMMONWEALTH_PROMPT_CAPTURE_MS: "1",
  };
  await runInstalledCaptureEntry(host, pluginRoot, projectRoot, failureEnv, {
    cwd: projectRoot,
    transcript_path: transcript,
    session_id: `release-smoke-${host}-forced-failure`,
  });
  await waitForReceipt(receiptPath, "capture FAILED");
  const start = await invokeSessionStart(host, pluginRoot, projectRoot, failureEnv);
  const receipt = start?.systemMessage ?? "";
  assert(
    receipt.includes("capture FAILED") && receipt.includes(`${host} extractor`),
    `${host} failure receipt was missing or not host-specific: ${receipt}`,
  );
  console.error("  failure: forced extractor failure produced a loud host-specific receipt");
}

async function exercisePublishedSync(version, brainDir, projectRoot, env) {
  const args = ["-y", `@cmnwlth/sync@${version}`, "sync", "--dir", brainDir];
  const first = await run("npx", args, { cwd: projectRoot, env, timeoutMs: 240_000 });
  assert(first.code === 0, `published sync failed: ${first.stderr.trim().slice(0, 500)}`);
  const second = await run("npx", args, { cwd: projectRoot, env, timeoutMs: 240_000 });
  assert(second.code === 0, `published sync no-op failed: ${second.stderr.trim().slice(0, 500)}`);
  assert(
    /committed=false pulled=false pushed=false conflicts=0/.test(second.stderr),
    `published sync did not reach an idempotent no-op: ${second.stderr.trim().slice(0, 500)}`,
  );
  console.error(`sync: @cmnwlth/sync@${version} completed and repeated as a no-op`);
}

async function probeExtractor(host, pluginRoot, projectRoot, env) {
  const transcript = path.join(projectRoot, `${host}-transcript.jsonl`);
  const durable = "The release checklist requires a standalone marketplace smoke before tagging.";
  const line =
    host === "claude"
      ? { message: { role: "user", content: durable } }
      : {
          type: "response_item",
          payload: {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: durable }],
          },
        };
  writeFileSync(transcript, `${JSON.stringify(line)}\n`);
  const moduleUrl = pathToFileURL(path.join(pluginRoot, "hooks", "extraction.mjs")).href;
  const output = await checked(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      `
        const module = await import(${JSON.stringify(moduleUrl)});
        const result = await module.createExtractor({
          host: ${JSON.stringify(host)},
          timeoutMs: 180000,
        }).extract({
          transcriptPath: ${JSON.stringify(transcript)},
          cwd: ${JSON.stringify(projectRoot)},
        });
        process.stdout.write(JSON.stringify(result));
      `,
    ],
    { cwd: projectRoot, env, timeoutMs: 200_000 },
  );
  const result = parseJson(output, `${host} extractor probe`);
  if (!result.ok) fail(`${host} authenticated extractor failed: ${result.reason}: ${result.error}`);
  console.error(
    `  extractor: authenticated schema-valid response (${result.candidates.length} candidates)`,
  );
}

async function main() {
  assertConfiguration();
  const root = mkdtempSync(path.join(os.tmpdir(), "commonwealth-fresh-marketplace-"));
  const projectRoot = path.join(root, "project");
  const brainDir = path.join(root, "brain");
  mkdirSync(projectRoot, { recursive: true });
  mkdirSync(brainDir, { recursive: true });
  const env = {
    ...process.env,
    HOME: path.join(root, "home"),
    CLAUDE_CONFIG_DIR: path.join(root, "claude"),
    CODEX_HOME: path.join(root, "codex"),
    COMMONWEALTH_CONFIG: path.join(root, "home", ".commonwealth", "config.json"),
    CLAUDE_PROJECT_DIR: projectRoot,
    NODE_PATH: "",
  };
  // The acceptance state must never inherit routing/runtime overrides from the invoking shell.
  delete env.COMMONWEALTH_BRAIN_DIR;
  delete env.COMMONWEALTH_REGISTRY;
  delete env.COMMONWEALTH_RECEIPT;
  delete env.COMMONWEALTH_CURATE_BIN;
  mkdirSync(env.HOME, { recursive: true });
  mkdirSync(env.CLAUDE_CONFIG_DIR, { recursive: true });
  mkdirSync(env.CODEX_HOME, { recursive: true });

  try {
    const { marketplaceRoot, gitSource } = await prepareMarketplace(root, projectRoot, env);
    console.error(`fresh marketplace smoke: ${hosts.join("+")} from ${source}@${marketplaceSha}`);
    const installs = new Map();
    for (const host of hosts) {
      const pluginRoot = await install(host, marketplaceRoot, gitSource, projectRoot, env);
      assertInstalledPayload(pluginRoot);
      const resolvedPlugin = path.resolve(pluginRoot);
      const resolvedMarketplace = path.resolve(marketplaceRoot);
      assert(
        resolvedPlugin !== resolvedMarketplace &&
          !resolvedPlugin.startsWith(`${resolvedMarketplace}${path.sep}`),
        `${host} reported the marketplace source instead of an installed cache: ${pluginRoot}`,
      );
      installs.set(host, pluginRoot);
      console.error(`${host}: installed ${pluginRoot}`);
    }
    rmSync(marketplaceRoot, { recursive: true, force: true });
    for (const [host, pluginRoot] of installs) {
      assert(
        existsSync(pluginRoot),
        `${host} installed payload disappeared after removing the marketplace clone`,
      );
    }

    const versions = new Set([...installs.values()].map(installedVersion));
    assert(versions.size === 1, `installed host versions disagree: ${[...versions].join(", ")}`);
    const version = [...versions][0];
    await initializePublishedBrain(version, brainDir, projectRoot, env);

    for (const [host, pluginRoot] of installs) {
      console.error(`${host}:`);
      await probeCurate(pluginRoot, projectRoot, env);
      const marker = `releaseprobe${host}${Date.now().toString(36)}`;
      await exerciseMcp(pluginRoot, brainDir, projectRoot, env, marker);
      await assertProactiveContext(host, pluginRoot, projectRoot, env, marker);
      await probeExtractor(host, pluginRoot, projectRoot, env);
      const transcript = await exerciseCapture(
        host,
        pluginRoot,
        projectRoot,
        env,
        `${marker}capture`,
      );
      await exerciseFailureReceipt(host, pluginRoot, projectRoot, env, transcript);
    }
    await exercisePublishedSync(version, brainDir, projectRoot, env);
    console.error("fresh marketplace smoke passed");
  } finally {
    if (process.env.COMMONWEALTH_SMOKE_KEEP_HOME === "1") {
      console.error(`kept isolated smoke home: ${root}`);
    } else {
      rmSync(root, { recursive: true, force: true });
    }
  }
}

main().catch((error) => {
  console.error(
    `fresh marketplace smoke failed: ${error instanceof Error ? error.message : error}`,
  );
  process.exitCode = 1;
});
