#!/usr/bin/env node

/**
 * check-no-test-regression.mjs
 *
 * Test-regression check (manual / CI — wire into a pre-push hook if you want
 * one). Runs the project's `npm test` and fails if the change introduces a NEW
 * test failure compared to a saved baseline.
 *
 * It compares the *identity* of the failing tests (file + test name), not just
 * the aggregate count: a freshly-broken test is caught even when an unrelated
 * failure disappears in the same run and the total stays flat.
 *
 * Usage:
 *   node scripts/check-no-test-regression.mjs --capture   # save current state as baseline
 *   node scripts/check-no-test-regression.mjs              # run tests, compare against baseline
 *
 *   # as an npm script:
 *   npm run test:no-regression:capture
 *   npm run test:no-regression
 *
 * Exit codes:
 *   0 — no regression (no new failing test)
 *   1 — new failure(s) detected (BLOCK)
 *   2 — no baseline exists (run --capture first)
 *   3 — test runner itself crashed (could not parse output)
 */

import { execSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
// Test identities must be byte-identical across OSes so a baseline captured on
// one platform compares cleanly on another (and on CI). `path.relative` emits
// the native separator — `\` on Windows — so normalise to POSIX `/` always.
const POSIX_SEP = "/";
const WINDOWS_SEP = "\\";
const BASELINE_FILE = join(ROOT, ".test-baseline.json");
const RESULT_FILE = join(ROOT, ".vitest-result.json");

// Run through `npm test` (not `npx vitest run` directly) so the `pretest`
// build step runs and we measure exactly what CI measures. The JSON reporter
// writes a machine-readable file — no ANSI colour codes to parse, works the
// same on Linux/macOS/Windows.
const TEST_COMMAND = `npm test -- --reporter=json --outputFile=${JSON.stringify(RESULT_FILE)}`;
const TEST_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

const EXIT_OK = 0;
const EXIT_REGRESSION = 1;
const EXIT_NO_BASELINE = 2;
const EXIT_RUNNER_CRASH = 3;

// ---------------------------------------------------------------------------
// Parse vitest JSON report (Jest-compatible schema)
// ---------------------------------------------------------------------------

/**
 * @param {string} jsonText Raw contents of the vitest `--reporter=json` output file.
 * @returns {{ counts: {failed:number,passed:number,skipped:number,total:number}, failedIds: string[] } | null}
 */
export function parseVitestJson(jsonText) {
  let report;
  try {
    report = JSON.parse(jsonText);
  } catch {
    return null;
  }

  if (!report || !Array.isArray(report.testResults)) {
    return null;
  }

  const failedIds = [];
  for (const file of report.testResults) {
    // `file.name` is an absolute path; relativise so baselines stay comparable
    // across machines and checkouts, then force POSIX separators so the
    // identity is identical on Windows and *nix.
    const fileId = relative(ROOT, file.name ?? "").split(WINDOWS_SEP).join(POSIX_SEP);
    for (const assertion of file.assertionResults ?? []) {
      if (assertion.status === "failed") {
        failedIds.push(`${fileId} > ${assertion.fullName ?? assertion.title}`);
      }
    }
  }

  return {
    counts: {
      failed: report.numFailedTests ?? failedIds.length,
      passed: report.numPassedTests ?? 0,
      skipped: report.numPendingTests ?? 0,
      total: report.numTotalTests ?? 0,
    },
    failedIds: failedIds.sort(),
  };
}

/**
 * Compare two sets of failing-test identities.
 *
 * @param {string[]} baselineIds
 * @param {string[]} currentIds
 * @returns {{ newFailures: string[], fixed: string[] }}
 */
export function diffFailures(baselineIds, currentIds) {
  const baseline = new Set(baselineIds);
  const current = new Set(currentIds);
  return {
    newFailures: currentIds.filter((id) => !baseline.has(id)),
    fixed: baselineIds.filter((id) => !current.has(id)),
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
    const branch = execSync("git branch --show-current", { encoding: "utf-8", stdio: "pipe" }).trim();
    const commit = execSync("git rev-parse HEAD", { encoding: "utf-8", stdio: "pipe" }).trim();
    return { branch, commit };
  } catch {
    return { branch: "unknown", commit: "unknown" };
  }
}

/**
 * Run the test suite and return the parsed result, or null if the runner
 * produced no parseable report.
 * @returns {{ counts: {failed:number,passed:number,skipped:number,total:number}, failedIds: string[] } | null}
 */
function runTests() {
  try {
    execSync(TEST_COMMAND, { encoding: "utf-8", timeout: TEST_TIMEOUT_MS, stdio: "pipe" });
  } catch {
    // vitest exits non-zero when tests fail — that's expected; the report is
    // still written to RESULT_FILE. A genuine runner crash leaves no file and
    // is handled below.
  }

  if (!existsSync(RESULT_FILE)) {
    return null;
  }
  try {
    return parseVitestJson(readFileSync(RESULT_FILE, "utf-8"));
  } finally {
    rmSync(RESULT_FILE, { force: true });
  }
}

// ---------------------------------------------------------------------------
// Capture
// ---------------------------------------------------------------------------

function capture() {
  console.log(yellow("⏳ Running full test suite to capture baseline…"));
  console.log(`   Command: ${TEST_COMMAND}`);
  console.log("");

  const result = runTests();
  if (!result) {
    console.error(red("❌ Could not produce a test report. Is vitest installed and is the build passing?"));
    process.exit(EXIT_RUNNER_CRASH);
  }

  const baseline = { ...result, timestamp: new Date().toISOString(), ...getGitInfo() };
  writeFileSync(BASELINE_FILE, JSON.stringify(baseline, null, 2) + "\n");

  console.log(green("✅ Baseline saved to .test-baseline.json"));
  console.log(
    `   Tests: ${result.counts.failed} failed / ${result.counts.passed} passed / ${result.counts.skipped} skipped (${result.counts.total} total)`,
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
    console.error("   Run: node scripts/check-no-test-regression.mjs --capture");
    process.exit(EXIT_NO_BASELINE);
  }

  let baseline;
  try {
    baseline = JSON.parse(readFileSync(BASELINE_FILE, "utf-8"));
  } catch {
    console.error(red("❌ Baseline file is corrupted. Re-run --capture."));
    process.exit(EXIT_NO_BASELINE);
  }

  console.log(yellow("⏳ Running full test suite…"));
  console.log(`   Baseline captured at: ${baseline.timestamp}`);
  console.log(`   Baseline branch:      ${baseline.branch} (${baseline.commit?.slice(0, 8)})`);
  console.log(`   Baseline: ${baseline.counts.failed} failing test(s)`);
  console.log("");

  const current = runTests();
  if (!current) {
    console.error(red("❌ Could not produce a test report (runner crashed?)."));
    process.exit(EXIT_RUNNER_CRASH);
  }

  const baselineIds = baseline.failedIds ?? [];
  const { newFailures, fixed } = diffFailures(baselineIds, current.failedIds);
  const skipDelta = current.counts.skipped - baseline.counts.skipped;

  console.log(`   Baseline: ${baselineIds.length} failing | ${baseline.counts.skipped} skipped`);
  console.log(`   Current:  ${current.failedIds.length} failing | ${current.counts.skipped} skipped`);
  console.log("");

  if (newFailures.length > 0) {
    console.error(red("❌ REGRESSION DETECTED — BLOCKING"));
    console.error(`   ${newFailures.length} test(s) newly failing:`);
    for (const id of newFailures) {
      console.error(`     • ${id}`);
    }
    if (skipDelta > 0) {
      console.error(`   Skip count also rose by ${skipDelta} (possible masked failures).`);
    }
    console.error("");
    console.error("   Fix the failures before pushing. If a test was intentionally");
    console.error("   removed or renamed, refresh the baseline with --capture first.");
    process.exit(EXIT_REGRESSION);
  }

  if (fixed.length > 0) {
    console.log(green(`✅ Improvement! ${fixed.length} previously-failing test(s) now pass.`));
  } else {
    console.log(green(`✅ No regression — no new failing test (${current.failedIds.length} failing, unchanged set).`));
  }

  if (skipDelta !== 0) {
    console.log(yellow(`⚠️  Skip count changed: ${skipDelta > 0 ? "+" : ""}${skipDelta}`));
    console.log("   Verify no tests were silently skipped to mask failures.");
  }

  console.log(green("✅ Safe to push."));
  process.exit(EXIT_OK);
}

// ---------------------------------------------------------------------------
// CLI entry — guarded so the module can be imported in tests without running.
// ---------------------------------------------------------------------------

function main() {
  const arg = process.argv[2];
  if (arg === "--capture" || arg === "-c") {
    capture();
  } else if (arg === "--help" || arg === "-h") {
    console.log(`check-no-test-regression.mjs — test-regression check

Usage:
  node scripts/check-no-test-regression.mjs --capture   Save current test state as baseline
  node scripts/check-no-test-regression.mjs              Run tests and compare against baseline

Exit codes:
  0 — no regression
  1 — new failure(s) detected (BLOCK)
  2 — no baseline exists
  3 — could not produce a test report`);
  } else {
    check();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
