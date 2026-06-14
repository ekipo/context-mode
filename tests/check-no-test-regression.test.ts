import { describe, it, expect } from "vitest";
// @ts-expect-error — plain-JS sibling script, no type declarations
import { parseVitestJson, diffFailures } from "../scripts/check-no-test-regression.mjs";

// Minimal vitest/Jest-compatible `--reporter=json` payload.
function report(assertions: Array<{ file: string; name: string; status: string }>) {
  const byFile = new Map<string, Array<{ title: string; fullName: string; status: string }>>();
  for (const a of assertions) {
    if (!byFile.has(a.file)) byFile.set(a.file, []);
    byFile.get(a.file)!.push({ title: a.name, fullName: a.name, status: a.status });
  }
  const failed = assertions.filter((a) => a.status === "failed").length;
  const passed = assertions.filter((a) => a.status === "passed").length;
  const skipped = assertions.filter((a) => a.status === "pending").length;
  return JSON.stringify({
    numFailedTests: failed,
    numPassedTests: passed,
    numPendingTests: skipped,
    numTotalTests: assertions.length,
    testResults: [...byFile].map(([name, assertionResults]) => ({ name, assertionResults })),
  });
}

describe("parseVitestJson", () => {
  it("extracts failing-test identities and counts from a JSON report", () => {
    const parsed = parseVitestJson(
      report([
        { file: "tests/a.test.ts", name: "does X", status: "passed" },
        { file: "tests/a.test.ts", name: "does Y", status: "failed" },
        { file: "tests/b.test.ts", name: "skipped one", status: "pending" },
      ]),
    );
    expect(parsed).not.toBeNull();
    expect(parsed.counts).toEqual({ failed: 1, passed: 1, skipped: 1, total: 3 });
    expect(parsed.failedIds).toEqual(["tests/a.test.ts > does Y"]);
  });

  it("returns null on non-JSON / malformed input (runner crash → exit 3)", () => {
    // The previous text-regex parser returned null on ANSI-coloured vitest
    // summaries; consuming the JSON report removes that whole failure class.
    expect(parseVitestJson("\x1b[31mTest Files 1 failed\x1b[0m garbage")).toBeNull();
    expect(parseVitestJson("{not json")).toBeNull();
  });
});

describe("diffFailures", () => {
  it("flags a newly-failing test even when the total failure count is unchanged", () => {
    // Aggregate counts are equal (1 == 1) but the failing test is different —
    // a count-only gate would miss this regression.
    const { newFailures, fixed } = diffFailures(
      ["tests/a.test.ts > old breakage"],
      ["tests/a.test.ts > brand new breakage"],
    );
    expect(newFailures).toEqual(["tests/a.test.ts > brand new breakage"]);
    expect(fixed).toEqual(["tests/a.test.ts > old breakage"]);
  });

  it("reports no new failures when the failing set is unchanged", () => {
    const ids = ["tests/a.test.ts > known flake"];
    expect(diffFailures(ids, ids).newFailures).toEqual([]);
  });
});
