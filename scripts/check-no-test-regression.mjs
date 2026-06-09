#!/usr/bin/env node

/**
 * check-no-test-regression.mjs
 *
 * Pre-push gate: blocks `git push` if the current change introduces NEW test
 * failures.  Compares the current `npm test` output against a saved baseline.
 *
 * Usage:
 *   node scripts/check-no-test-regression.mjs --capture   # save current state as baseline
 *   node scripts/check-no-test-regression.mjs              # run tests, compare against baseline
 *
 * Exit codes:
 *   0 — no regression (same or fewer failures)
 *   1 — new failures detected (BLOCK push)
 *   2 — no baseline exists (run --capture first)
 *   3 — test runner itself crashed (could not parse output)
 */

import { execSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const BASELINE_FILE = join(ROOT, ".test-baseline.json");

const TEST_COMMAND = "npx vitest run";
const TEST_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

// ---------------------------------------------------------------------------
// Parse vitest output
// ---------------------------------------------------------------------------

const RE_TEST_FILES = /Test\s+Files\s+(\d+)\s+failed\s*\|\s*(\d+)\s+passed\s*(?:|\s*\|\s*\d+\s+skipped)\s*\((\d+)\)/;
const RE_TESTS = /Tests\s+(\d+)\s+failed\s*\|\s*(\d+)\s+passed\s*(?:\|\s*(\d+)\s+skipped\s*)?\((\d+)\)/;

/**
 * @param {string} stdout
 * @returns {{ testFiles: {failed:number,passed:number,total:number}, tests: {failed:number,passed:number,skipped:number,total:number} } | null}
 */
function parseVitestOutput(stdout) {
  const tfMatch = stdout.match(RE_TEST_FILES);
  const tMatch = stdout.match(RE_TESTS);

  if (!tfMatch || !tMatch) return null;

  return {
    testFiles: {
      failed: parseInt(tfMatch[1], 10),
      passed: parseInt(tfMatch[2], 10),
      total: parseInt(tfMatch[3], 10),
    },
    tests: {
      failed: parseInt(tMatch[1], 10),
      passed: parseInt(tMatch[2], 10),
      skipped: parseInt(tMatch[3] || "0", 10),
      total: parseInt(tMatch[4], 10),
    },
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function red(s) {
  return `\x1b[31m${s}\x1b[0m`;
}
function green(s) {
  return `\x1b[32m${s}\x1b[0m`;
}
function yellow(s) {
  return `\x1b[33m${s}\x1b[0m`;
}

function getGitInfo() {
  try {
    const branch = execSync("git branch --show-current", {
      encoding: "utf-8",
      stdio: "pipe",
    }).trim();
    const commit = execSync("git rev-parse HEAD", {
      encoding: "utf-8",
      stdio: "pipe",
    }).trim();
    return { branch, commit };
  } catch {
    return { branch: "unknown", commit: "unknown" };
  }
}

// ---------------------------------------------------------------------------
// Capture
// ---------------------------------------------------------------------------

function capture() {
  console.log(yellow("⏳ Running full test suite to capture baseline…"));
  console.log(`   Command: ${TEST_COMMAND}`);
  console.log("");

  let stdout;
  try {
    stdout = execSync(TEST_COMMAND, {
      encoding: "utf-8",
      timeout: TEST_TIMEOUT_MS,
      stdio: "pipe",
    });
    // vitest exits non-zero on test failure — that's fine for capture
  } catch (e) {
    stdout = e.stdout || "";
    // stderr may contain the output too when piped
    if (!stdout && e.stderr) stdout = e.stderr;
  }

  const parsed = parseVitestOutput(stdout);
  if (!parsed) {
    console.error(red("❌ Could not parse vitest output. Is vitest installed?"));
    console.error("   Last 500 chars of output:");
    console.error(stdout.slice(-500));
    process.exit(3);
  }

  const baseline = {
    ...parsed,
    timestamp: new Date().toISOString(),
    ...getGitInfo(),
  };

  writeFileSync(BASELINE_FILE, JSON.stringify(baseline, null, 2) + "\n");
  console.log(green("✅ Baseline saved to .test-baseline.json"));
  console.log(
    `   Test Files: ${parsed.testFiles.failed} failed / ${parsed.testFiles.passed} passed (${parsed.testFiles.total} total)`,
  );
  console.log(
    `   Tests:      ${parsed.tests.failed} failed / ${parsed.tests.passed} passed / ${parsed.tests.skipped} skipped (${parsed.tests.total} total)`,
  );
  console.log("");
  console.log("   Run without --capture before pushing to check for regressions.");
}

// ---------------------------------------------------------------------------
// Check
// ---------------------------------------------------------------------------

function check() {
  if (!existsSync(BASELINE_FILE)) {
    console.error(red("❌ No baseline found."));
    console.error(`   Run: node scripts/check-no-test-regression.mjs --capture`);
    console.error("   This saves the current test state as the expected baseline.");
    process.exit(2);
  }

  let baseline;
  try {
    baseline = JSON.parse(readFileSync(BASELINE_FILE, "utf-8"));
  } catch {
    console.error(red("❌ Baseline file is corrupted. Re-run --capture."));
    process.exit(2);
  }

  console.log(yellow("⏳ Running full test suite…"));
  console.log(`   Baseline captured at: ${baseline.timestamp}`);
  console.log(`   Baseline branch:      ${baseline.branch} (${baseline.commit?.slice(0, 8)})`);
  console.log(
    `   Baseline: ${baseline.tests.failed} test failures, ${baseline.testFiles.failed} file failures`,
  );
  console.log("");

  let stdout;
  try {
    stdout = execSync(TEST_COMMAND, {
      encoding: "utf-8",
      timeout: TEST_TIMEOUT_MS,
      stdio: "pipe",
    });
  } catch (e) {
    stdout = e.stdout || "";
    if (!stdout && e.stderr) stdout = e.stderr;
  }

  const current = parseVitestOutput(stdout);
  if (!current) {
    console.error(red("❌ Could not parse vitest output."));
    console.error("   Last 500 chars:");
    console.error(stdout.slice(-500));
    process.exit(3);
  }

  // Compare
  const tfDelta = current.testFiles.failed - baseline.testFiles.failed;
  const tDelta = current.tests.failed - baseline.tests.failed;
  const tSkipDelta = current.tests.skipped - baseline.tests.skipped;

  console.log(`   Baseline: ${baseline.tests.failed} test failures | ${baseline.tests.skipped} skipped`);
  console.log(`   Current:  ${current.tests.failed} test failures | ${current.tests.skipped} skipped`);
  console.log("");

  if (tDelta > 0 || tfDelta > 0) {
    console.error(red(`❌ REGRESSION DETECTED — BLOCKING PUSH`));
    console.error(`   New test failures:  +${tDelta} tests, +${tfDelta} files`);
    if (tSkipDelta !== 0) {
      console.error(`   Skip count changed: ${tSkipDelta > 0 ? "+" : ""}${tSkipDelta} (possible masked failures)`);
    }
    console.error("");
    console.error("   Fix the failures before pushing. If a test is intentionally");
    console.error("   removed, update the baseline with --capture first.");
    process.exit(1);
  }

  if (tDelta < 0) {
    console.log(green(`✅ Improvement! ${Math.abs(tDelta)} fewer test failures.`));
  } else {
    console.log(green(`✅ No regression — test failures unchanged (${current.tests.failed}).`));
  }

  if (tSkipDelta !== 0) {
    console.log(yellow(`⚠️  Skip count changed: ${tSkipDelta > 0 ? "+" : ""}${tSkipDelta}`));
    console.log("   Verify no tests were silently skipped to mask failures.");
  }

  console.log(green("✅ Safe to push."));
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const arg = process.argv[2];

if (arg === "--capture" || arg === "-c") {
  capture();
} else if (arg === "--help" || arg === "-h") {
  console.log(`check-no-test-regression.mjs — pre-push test regression gate

Usage:
  node scripts/check-no-test-regression.mjs --capture   Save current test state as baseline
  node scripts/check-no-test-regression.mjs              Run tests and compare against baseline

Exit codes:
  0 — no regression
  1 — new failures detected (BLOCK push)
  2 — no baseline exists
  3 — could not parse test output`);
} else {
  check();
}
