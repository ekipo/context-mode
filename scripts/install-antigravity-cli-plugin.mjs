#!/usr/bin/env node
/**
 * Cross-platform installer: register the context-mode plugin into Antigravity CLI (agy).
 *
 * Replaces the former bash-only scripts/install-antigravity-cli-plugin.sh so
 * `npm run install:agy` runs natively on Windows (PowerShell/cmd) as well as
 * macOS/Linux. agy itself runs on Windows, so its installer must too — unlike
 * the openclaw installer, which is genuinely POSIX-only (signals, pgrep, /tmp).
 *
 * The bundle (configs/antigravity-cli/) registers the context-mode MCP server,
 * routing rule, routing skill, and bounded PreToolUse/PostToolUse/Stop hooks in
 * one step.
 *
 * Usage: npm run install:agy   (or: node scripts/install-antigravity-cli-plugin.mjs)
 */
import { spawnSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const isWin = process.platform === "win32";
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const bundle = resolve(repoRoot, "configs", "antigravity-cli");

// Double-quote a path so a clone dir with spaces survives the shell on both
// cmd.exe and /bin/sh (paths never contain literal quotes).
const q = (s) => `"${s}"`;

// Cross-platform "is <cmd> on PATH?" — `where` on Windows, `command -v` on POSIX.
// shell:true is required: `command -v` is a shell builtin and `where`/`agy` may
// resolve to a .cmd shim on Windows that only the shell can launch.
function onPath(cmd) {
  const probe = isWin ? `where ${cmd}` : `command -v ${cmd}`;
  return spawnSync(probe, { stdio: "ignore", shell: true }).status === 0;
}

// — preflight —
if (!onPath("agy")) {
  console.error("✗ 'agy' (Antigravity CLI) not found in PATH. Install agy first, then re-run.");
  process.exit(1);
}
if (!existsSync(bundle)) {
  console.error(`✗ plugin bundle not found at ${bundle}`);
  process.exit(1);
}

console.log("→ context-mode agy plugin installer");
console.log(`  bundle : ${bundle}`);

// The plugin's MCP server runs the global `context-mode` binary (it needs the
// native better-sqlite3 dependency, which a bare clone does not have). Warn — do
// not silently global-install on the user's behalf.
const hasContextMode = onPath("context-mode");
if (!hasContextMode) {
  console.error("⚠ 'context-mode' is not on PATH — the plugin's MCP server requires it.");
  console.error("  Install it with:  npm install -g context-mode");
}

// Run `agy plugin install <bundle>`. String command + shell:true so cmd.exe can
// resolve agy's .cmd shim on Windows; the quoted bundle path handles spaces.
const install = spawnSync(`agy plugin install ${q(bundle)}`, { stdio: "inherit", shell: true });
if (install.status !== 0) {
  console.error(`✗ 'agy plugin install' failed (exit ${install.status ?? "unknown"}).`);
  process.exit(install.status ?? 1);
}

// MCP is registered by `agy plugin install` above, straight from the bundle's
// native `mcp_config.json` (env-pinned CONTEXT_MODE_PLATFORM=antigravity-cli).
// Verified on agy 1.0.6: it logs "mcpServers : 1 processed" and writes the
// server into agy's plugin profile
// (~/.gemini/config/plugins/context-mode/mcp_config.json, env preserved).
// agy native validation/install does not read `.mcp.json`; keep the bundle on
// the single native `mcp_config.json` path to avoid manifest drift.

// agy CACHES each MCP server's tool schemas under
// ~/.gemini/antigravity-cli/mcp/<server>/ and does NOT refresh them on reconnect
// (verified on agy 1.0.6). A cache captured by an older context-mode holds the
// Gemini-incompatible schemas (`const` / `additionalProperties`) that make
// Antigravity CLI silently DROP the ctx_* tools from the model's function list —
// so even after upgrading, agy keeps hiding the tools and the agent works around
// them via shell scripts. Clear the cache so agy re-fetches the current
// (Gemini-safe) tools/list on its next launch.
const agyToolCache = join(homedir(), ".gemini", "antigravity-cli", "mcp", "context-mode");
let cacheCleared = false;
if (existsSync(agyToolCache)) {
  try {
    rmSync(agyToolCache, { recursive: true, force: true });
    cacheCleared = true;
  } catch (err) {
    console.error(`⚠ Could not clear agy's stale tool-schema cache at ${agyToolCache}: ${err.message}`);
    console.error("  If ctx_* tools don't appear in agy, delete that folder manually and restart agy.");
  }
}

// Probe whether the global `context-mode` understands the antigravity-cli hooks.
// The shipped hook commands resolve the GLOBAL binary at runtime. A context-mode
// older than the release that added Antigravity CLI support may have no
// `antigravity-cli` HOOK_MAP entry, and the dispatcher suppresses stderr, so the
// hooks would be a SILENT no-op. Detect that here and tell the user instead.
let hooksOk = false;
if (hasContextMode) {
  hooksOk = ["pretooluse", "posttooluse", "stop"].every((event) => {
    const probe = spawnSync(`context-mode hook antigravity-cli ${event}`, {
      input: "{}",
      stdio: ["pipe", "ignore", "ignore"],
      shell: true,
    });
    return probe.status === 0;
  });
}

console.log("");
// Confirm `agy plugin install` actually registered the MCP from the bundle's
// MCP config (it writes it into agy's plugin profile). If a future agy build
// skips it, fall back to a one-line manual instruction rather than silently
// leaving MCP unconfigured — never re-introduce a blind global-profile write.
const pluginMcp = join(homedir(), ".gemini", "config", "plugins", "context-mode", "mcp_config.json");
if (existsSync(pluginMcp)) {
  console.log("✓ Installed the context-mode agy plugin: MCP server + routing rule + routing skill + hooks.");
  console.log(`  MCP registered from the bundle's mcp_config.json → ${pluginMcp}`);
} else {
  console.log("✓ Installed the context-mode agy plugin: routing rule + routing skill + hooks.");
  console.error("⚠ MCP server not found in agy's plugin profile. If ctx_* tools don't appear, add");
  console.error('    { "mcpServers": { "context-mode": { "command": "context-mode" } } }');
  console.error("  to ~/.gemini/config/mcp_config.json and restart agy.");
}
if (cacheCleared) {
  console.log("✓ Cleared agy's stale tool-schema cache — agy re-fetches Gemini-safe schemas on next launch.");
}
if (hooksOk) {
  console.log("✓ Antigravity CLI hooks are ACTIVE (this context-mode supports antigravity-cli).");
} else {
  console.error("⚠ Antigravity CLI hooks may be INACTIVE: your global 'context-mode' is missing or too old");
  console.error("  to handle 'context-mode hook antigravity-cli'. MCP tools + the routing rule + routing skill still work.");
  console.error("  Enable hook enforcement/capture with:  npm install -g context-mode@latest");
}
console.log("");
console.log("  Restart agy, then verify:");
console.log('    agy -p "Use the context-mode ctx_execute MCP tool to compute 7 + 5. Answer only the number." --dangerously-skip-permissions');
console.log("  Expected output: 12");
