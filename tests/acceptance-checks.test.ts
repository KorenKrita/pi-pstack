import { describe, expect, test } from "bun:test";
import { drivesMean24, evidenceProves, execsCli } from "../docs/acceptance/drivers/verify-checks";

describe("acceptance run4 predicates (review 5.7)", () => {
  test("execsCli counts execution, not mentions", () => {
    expect(execsCli("bun src/cli.ts mean 2 4")).toBe(true);
    expect(execsCli("bun --version && test -f src/cli.ts && .pi/skills/verify-calc/helpers/capture.sh mean-2-4 -- mean 2 4")).toBe(true);
    expect(execsCli("mkdir -p .pi/evidence/x && .pi/skills/x/helpers/drive.sh mean 2 4 > out.txt 2>&1")).toBe(true);
    expect(execsCli("cat src/cli.ts")).toBe(false);
    expect(execsCli("cat .pi/skills/x/helpers/capture.sh")).toBe(false);
    expect(execsCli("test -f src/cli.ts && echo ok")).toBe(false);
  });

  test("drivesMean24 needs the CLI run with mean 2 4", () => {
    expect(drivesMean24("bun src/cli.ts mean 2 4")).toBe(true);
    expect(drivesMean24("bun src/cli.ts mean 1 2 3")).toBe(false);
    expect(drivesMean24("cat src/cli.ts # mean 2 4")).toBe(false);
  });

  test("evidenceProves accepts both formats and rejects unrelated output", () => {
    expect(evidenceProves({ "e/run.txt": "--- cmd: bun src/cli.ts mean 2 4\n--- exit: 0\n--- stdout:\n3\n" })).toBe(true);
    expect(evidenceProves({ "e/mean-2-4.stdout": "3\n", "e/mean-2-4.exit": "0\n" })).toBe(true);
    expect(evidenceProves({ "e/mean-2-4.stdout": "3\n", "e/mean-2-4.exit": "1\n" })).toBe(false);
    expect(evidenceProves({ "e/t.txt": " 3 pass\n 0 fail\n" })).toBe(false);
    expect(evidenceProves({})).toBe(false);
  });
});
