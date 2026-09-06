import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DecodedImage, Plan, PlanInput, RenderInput } from "../index";

/**
 * What `readFileSync` pretends is not on disk, and every path it was asked for.
 *
 * Hoisted, because the `node:fs` factory below runs before the module body and
 * a plain `const` would not exist yet. Each test sets `missing` and reads
 * `reads`; `beforeEach` clears both.
 */
const disk = vi.hoisted(() => ({
  /** Path fragments to refuse. A path containing one throws ENOENT. */
  missing: [] as string[],
  reads: [] as string[],
}));

/**
 * A `node:fs` that can lose a file.
 *
 * A pass-through and not a stub: everything but the named fragments reads for
 * real, so the render that follows is the real render. Only the JavaScript
 * layer is covered — sharp and takumi open their own files from Rust — which is
 * all this file is about, because the import-time read the ticket is against is
 * compose's own.
 */
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const readFileSync: typeof actual.readFileSync = (path, ...rest) => {
    const asked = String(path);
    disk.reads.push(asked);
    if (disk.missing.some((fragment) => asked.includes(fragment))) {
      const error: NodeJS.ErrnoException = new Error(
        `ENOENT: no such file or directory, open '${asked}'`
      );
      error.code = "ENOENT";
      throw error;
    }
    return (actual.readFileSync as (...a: unknown[]) => never)(path, ...rest);
  };
  const patched = { ...actual, readFileSync };
  // Both shapes, because `node:fs` is reachable either way and a module doing
  // `import fs from "node:fs"` must see the same patched call as one doing
  // `import { readFileSync }`.
  return { ...patched, default: patched };
});

/** Everything a Look reads sits under this folder. */
const LOOK_ASSETS = "/lib/looks/";

/** The Swiss Hutless story, the case the render suite starts from. */
const STORY = {
  template: "swisshutless-story",
  placement: "instagram/story",
  brand: "swisshutless",
} as const;

/** A flat grey picture at exactly this size. Raw RGB, the shape the host hands over. */
function grey(width: number, height: number): DecodedImage {
  return {
    width,
    height,
    channels: 3,
    data: Buffer.alloc(width * height * 3, 90),
  };
}

/**
 * compose, imported into a module graph of its own.
 *
 * `resetModules` first, so each test gets its own memo and its own Renderer and
 * one test cannot warm the assets for the next.
 */
async function freshCompose() {
  vi.resetModules();
  return import("../index");
}

type Compose = Awaited<ReturnType<typeof freshCompose>>;

/**
 * The story with its real Fields, off the catalogue.
 *
 * Real and not `{}`: `resolve` parses the Fields before anything is laid out,
 * so a Plan with empty Fields is refused as `invalid_fields` and never reaches
 * the fonts these tests are about.
 */
function storyPlan(compose: Compose): PlanInput {
  const described = compose.templates().find((t) => t.id === STORY.template)!;
  return { ...STORY, fields: described.example };
}

/** The story's Plan call plus the picture and the window its Image Slot asks for. */
async function storyRender(compose: Compose): Promise<RenderInput> {
  const input = storyPlan(compose);
  const [{ imageSlot }] = (await compose.plan(input)) as [Plan];
  // A source the size of the Image Slot, cut whole: the window then has the
  // slot's aspect exactly, so nothing can be refused as `framing_mismatch`.
  return {
    ...input,
    source: grey(imageSlot.width, imageSlot.height),
    window: { x: 0, y: 0, width: 1, height: 1 },
    format: "png",
  };
}

beforeEach(() => {
  disk.missing = [];
  disk.reads = [];
});

describe("importing compose", () => {
  it("touches no file, so a bundle without the assets beside it still loads", async () => {
    disk.missing = [LOOK_ASSETS];

    await expect(freshCompose()).resolves.toHaveProperty("render");
    expect(disk.reads.filter((p) => p.includes(LOOK_ASSETS))).toEqual([]);
  });
});

describe("a Look whose assets are not on disk", () => {
  it("refuses `plan` with look_assets_missing, naming the font file", async () => {
    const compose = await freshCompose();
    const input = storyPlan(compose);
    // Hope Family's font, on a Swiss Hutless Plan: takumi resolves families
    // globally, so every Look's fonts are registered on the first call whatever
    // Brand asked for it.
    disk.missing = ["Eina02-Regular.otf"];

    const call = compose.plan(input);

    await expect(call).rejects.toBeInstanceOf(compose.ComposeError);
    await expect(call).rejects.toThrow(
      expect.objectContaining({ code: "look_assets_missing" })
    );
    await expect(call).rejects.toThrow(/Eina02-Regular\.otf/);
  });

  it("refuses `render` with look_assets_missing, naming the wordmark", async () => {
    // The wordmark is the second call site and the later one: the fonts are
    // registered while the Template is laid out, the wordmark only when the
    // picture is drawn. A test that loses a font never reaches it.
    const compose = await freshCompose();
    const input = await storyRender(compose);
    disk.missing = ["swisshutless/logo.png"];

    const call = compose.render(input);

    await expect(call).rejects.toBeInstanceOf(compose.ComposeError);
    await expect(call).rejects.toThrow(
      expect.objectContaining({ code: "look_assets_missing" })
    );
    await expect(call).rejects.toThrow(/logo\.png/);
  });
});

describe("a Look's assets", () => {
  it("are read once, however many renders follow", async () => {
    const compose = await freshCompose();
    const input = await storyRender(compose);
    await compose.render(input);
    const firstPass = disk.reads.filter((p) => p.includes(LOOK_ASSETS));

    disk.reads = [];
    await compose.render(input);
    await compose.render(input);

    // Named, not counted: a count that drops to zero for the wrong reason —
    // a Look that stopped registering its fonts at all — would still pass.
    expect(firstPass.length).toBeGreaterThan(0);
    expect(firstPass.some((p) => p.endsWith("swisshutless/logo.png"))).toBe(
      true
    );
    expect(disk.reads.filter((p) => p.includes(LOOK_ASSETS))).toEqual([]);
  });
});

describe("a Look's asset file that is there on the next call", () => {
  it("plans, rather than leaving the process refusing for good", async () => {
    // The Renderer is built once and held, so a build that threw must not be
    // the thing that is held: caching the rejected promise turns one missing
    // file into a container that refuses every Call until it is restarted,
    // which is far more than the one refusal the file is worth.
    const compose = await freshCompose();
    const input = storyPlan(compose);
    disk.missing = ["Barlow-Regular.ttf"];
    await expect(compose.plan(input)).rejects.toThrow(
      expect.objectContaining({ code: "look_assets_missing" })
    );

    disk.missing = [];

    await expect(compose.plan(input)).resolves.toBeDefined();
  });
});
