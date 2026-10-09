// Pure predicates for run4-verify.ts, unit-tested in tests/acceptance-checks.test.ts.

/** True when a bash command executes the CLI or a shipped helper (command position), not merely names it
 * (`cat src/cli.ts`, `ls helpers/x.sh` do not count). */
const execSegments = (command: string): string[] =>
  command
    .split(/&&|\|\||;|\||\n/)
    .map((seg) => seg.trim().replace(/^(?:cd\s+\S+\s*|env\s+|[A-Z_]+=\S+\s+)*/, ""))
    .filter((s) => /^(?:bun\s+(?:run\s+)?\S*src\/cli\.ts\b|(?:bash\s+|sh\s+)?\S*helpers\/\S+\.sh\b)/.test(s));

export const execsCli = (command: string): boolean => execSegments(command).length > 0;

/** An executed CLI/helper segment itself carries `mean 2 4` (not a neighbouring `echo`). */
export const drivesMean24 = (command: string): boolean => execSegments(command).some((s) => /\bmean\s+2\s+4\b/.test(s));

/** Evidence produced by this run proves `mean 2 4` printed 3 with exit 0. `files` maps path → content for
 * files created during the run. Accepts one transcript file (`mean 2 4`, `exit: 0` and a line `3`) or split
 * `<p>.stdout` / `<p>.exit` files tied to `mean 2 4` by a sibling `<p>.cmd` or by a name like `mean-2-4`. */
export function evidenceProves(files: Record<string, string>): boolean {
  for (const [path, text] of Object.entries(files)) {
    if (/mean 2 4/.test(text) && /exit:\s*0\b/.test(text) && /(^|\n)3\s*(\n|$)/.test(text)) return true;
    const m = /^(.*)\.stdout$/.exec(path);
    if (!m) continue;
    const p = m[1]!;
    const tied = /\bmean\s+2\s+4\b/.test(files[`${p}.cmd`] ?? "") || /(^|[/_-])mean[-_]2[-_]4$/.test(p);
    if (tied && /^3\s*$/.test(text) && /^0\s*$/.test(files[`${p}.exit`] ?? "")) return true;
  }
  return false;
}
