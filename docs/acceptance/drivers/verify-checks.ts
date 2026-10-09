// Pure predicates for run4-verify.ts, unit-tested in tests/acceptance-checks.test.ts.

/** True when a bash command executes the CLI or a shipped helper (command position), not merely names it
 * (`cat src/cli.ts`, `ls helpers/x.sh` do not count). */
export function execsCli(command: string): boolean {
  return command.split(/&&|\|\||;|\||\n/).some((seg) => {
    const s = seg.trim().replace(/^(?:cd\s+\S+\s*|env\s+|[A-Z_]+=\S+\s+)*/, "");
    return /^(?:bun\s+(?:run\s+)?\S*src\/cli\.ts\b|(?:bash\s+|sh\s+)?\S*helpers\/\S+\.sh\b)/.test(s);
  });
}

/** The call drives `mean 2 4`. */
export const drivesMean24 = (command: string): boolean => execsCli(command) && /\bmean\s+2\s+4\b/.test(command);

/** Evidence produced by this run proves `mean 2 4` printed 3 with exit 0. `files` maps path → content for
 * files created during the run. Accepts one transcript file (`exit: 0` + a line `3`) or split
 * `<name>.stdout` / `<name>.exit` files. */
export function evidenceProves(files: Record<string, string>): boolean {
  for (const [path, text] of Object.entries(files)) {
    if (/mean 2 4/.test(text) && /exit:\s*0\b/.test(text) && /(^|\n)3\s*(\n|$)/.test(text)) return true;
    const m = /^(.*)\.stdout$/.exec(path);
    if (m && /^3\s*$/.test(text) && /^0\s*$/.test(files[`${m[1]}.exit`] ?? "")) return true;
  }
  return false;
}
