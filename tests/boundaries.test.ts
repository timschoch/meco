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
// A file the gateway deploys, and a second client entry point of `models`:
// the two sides of the one seam between the containers.
const gatewayProbe = join(repoRoot, "packages/gateway/boundary-probe.ts");
const clientProbe = join(repoRoot, "packages/models/client-probe.ts");

/** Write a probe, cruise, and take it away again whatever the cruise said. */
async function withProbe(
  path: string,
  source: string
): Promise<{ ok: boolean; output: string }> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, source);
  try {
    return await cruise();
  } finally {
    await rm(path, { force: true });
  }
}

afterAll(async () => {
  await rm(probe, { force: true });
  await rm(gatewayProbe, { force: true });
  await rm(clientProbe, { force: true });
});

describe("package boundaries", () => {
  it("holds across the repo as committed", async () => {
    const { ok, output } = await cruise();
    expect(output).toContain("no dependency violations found");
    expect(ok).toBe(true);
  }, 60_000);

  it("fails when a package reaches past another package's entry point", async () => {
    const { ok, output } = await withProbe(
      probe,
      'export { MODULE_NAMES } from "../../contracts/lib/module-name";\n'
    );

    expect(ok).toBe(false);
    expect(output).toContain("entrypoint-boundary-across-packages");
  }, 60_000);
});

// `gateway` and `models` are two containers. The client is the one file that
// crosses between them, so these three say what the seam is: the client is
// allowed, anything else in `models` is not, and the client carries no server.
describe("the seam between the gateway and models", () => {
  it("lets the gateway import the models client", async () => {
    const { ok, output } = await withProbe(
      gatewayProbe,
      'export { createModelsClient } from "../models/index";\n'
    );

    expect(output).toContain("no dependency violations found");
    expect(ok).toBe(true);
  }, 60_000);

  it("fails when the gateway reaches any other file in models", async () => {
    const { ok, output } = await withProbe(
      gatewayProbe,
      'export { createApp } from "../models/app";\n'
    );

    expect(ok).toBe(false);
    expect(output).toContain("services-do-not-import-each-other");
  }, 60_000);

  it("fails when a client entry point of models imports sharp", async () => {
    const { ok, output } = await withProbe(
      clientProbe,
      'import sharp from "sharp";\nexport const decoder = sharp;\n'
    );

    expect(ok).toBe(false);
    expect(output).toContain("models-client-stays-thin");
  }, 60_000);

  it("fails when a client entry point reaches sharp through the host", async () => {
    // The rule reads the whole graph, not one edge: a client that imports the
    // decode would put sharp and the ONNX Runtime in the gateway's image just
    // as surely as importing them by name.
    const { ok, output } = await withProbe(
      clientProbe,
      'export { decode } from "./lib/decode";\n'
    );

    expect(ok).toBe(false);
    expect(output).toContain("models-client-stays-thin");
  }, 60_000);
});
