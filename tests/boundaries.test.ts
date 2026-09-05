import { execFile } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, describe, expect, it } from "vitest";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const run = promisify(execFile);

/** `depcruise` exits non-zero on a violation, so a rejection is the failure signal. */
async function cruise(): Promise<{ ok: boolean; output: string }> {
  try {
    const { stdout } = await run("pnpm", ["exec", "depcruise", "."], {
      cwd: repoRoot,
    });
    return { ok: true, output: stdout };
  } catch (error) {
    const failure = error as { stdout?: string; stderr?: string };
    return {
      ok: false,
      output: `${failure.stdout ?? ""}${failure.stderr ?? ""}`,
    };
  }
}

// A package internal that no package outside `contracts` may import.
const probe = join(repoRoot, "packages/frame/lib/boundary-probe.ts");

afterAll(async () => {
  await rm(probe, { force: true });
});

describe("package boundaries", () => {
  it("holds across the repo as committed", async () => {
    const { ok, output } = await cruise();
    expect(output).toContain("no dependency violations found");
    expect(ok).toBe(true);
  }, 60_000);

  it("fails when a package reaches past another package's entry point", async () => {
    await mkdir(dirname(probe), { recursive: true });
    await writeFile(
      probe,
      'export { MODULE_NAMES } from "../../contracts/lib/module-name";\n'
    );

    const { ok, output } = await cruise();

    expect(ok).toBe(false);
    expect(output).toContain("entrypoint-boundary-across-packages");
  }, 60_000);
});
