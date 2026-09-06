// What redact must never do: read a file, open a socket, or encode an image.
//
// Asserted by stubbing rather than by reading the source. Reading the source
// proves what is written today; stubbing fails the moment somebody writes the
// call, which is the point of a check.
//
// This file builds its own fixture and imports neither `./samples` nor
// `./pixels`. `samples.ts` reads `detected.json` at import time, and the
// filesystem is stubbed for everything in this file's module graph.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import sharp from "sharp";
import {
  assignRegionIds,
  type DecodedImage,
  type Region,
} from "@meco/contracts";
import { redact } from "../index";

const { forbidden, reached } = vi.hoisted(() => {
  const reached: string[] = [];

  /**
   * A module namespace whose every export refuses to be called and says what
   * asked for it. `then` and `__esModule` answer `undefined` so the namespace
   * is neither mistaken for a promise nor for an interop wrapper.
   */
  const forbidden = (moduleName: string): Record<string, unknown> =>
    new Proxy(
      {},
      {
        get: (_target, key) => {
          if (
            typeof key !== "string" ||
            key === "then" ||
            key === "__esModule"
          ) {
            return undefined;
          }
          return (...__args: unknown[]) => {
            reached.push(`${moduleName}.${key}`);
            throw new Error(`redact reached ${moduleName}.${key}`);
          };
        },
      }
    );

  return { forbidden, reached };
});

// The filesystem and the network, for every module vitest loads for this file.
// sharp is loaded as an external dependency and keeps the real ones, so the
// blur still runs — what is stubbed is what redact's own code could reach for.
//
// One literal call per module: `vi.mock` is hoisted by a source transform, so
// it cannot be written as a loop.
vi.mock("node:fs", () => forbidden("node:fs"));
vi.mock("node:fs/promises", () => forbidden("node:fs/promises"));
vi.mock("node:http", () => forbidden("node:http"));
vi.mock("node:https", () => forbidden("node:https"));
vi.mock("node:net", () => forbidden("node:net"));
vi.mock("node:tls", () => forbidden("node:tls"));
vi.mock("node:dns", () => forbidden("node:dns"));
vi.mock("node:child_process", () => forbidden("node:child_process"));

/** Every way sharp can be asked for encoded bytes. `raw` and `toBuffer` are not one. */
const ENCODERS = [
  "toFile",
  "toFormat",
  "jpeg",
  "png",
  "webp",
  "avif",
  "tiff",
  "gif",
  "heif",
  "jp2",
  "jxl",
] as const;

type SharpPrototype = Record<string, (...args: unknown[]) => unknown>;
const prototype = (sharp as unknown as { prototype: SharpPrototype }).prototype;
const originals = new Map<string, (...args: unknown[]) => unknown>();

/** A grey image with a stripe, so the blur has something to do. */
const image: DecodedImage = {
  width: 128,
  height: 128,
  channels: 3,
  data: Uint8Array.from({ length: 128 * 128 * 3 }, (_byte, index) =>
    Math.floor(index / 3) % 128 < 64 ? 20 : 235
  ),
};

const face: Region = assignRegionIds([
  {
    kind: "face",
    label: "face",
    box: { x: 0.25, y: 0.25, width: 0.5, height: 0.5 },
    score: 0.9,
    model: { name: "scrfd", version: "10g-bnkps-1" },
  },
])[0]!;

beforeAll(() => {
  for (const name of ENCODERS) {
    originals.set(name, prototype[name]!);
    prototype[name] = () => {
      reached.push(`sharp.${name}`);
      throw new Error(`redact reached sharp.${name}`);
    };
  }
  vi.stubGlobal("fetch", () => {
    reached.push("fetch");
    throw new Error("redact reached fetch");
  });
});

afterAll(() => {
  for (const [name, original] of originals) prototype[name] = original;
  vi.unstubAllGlobals();
});

describe("what redact never touches", () => {
  // Mutation: write any of them into `lib/` — `readFileSync` of the fixture,
  // `fetch` of anything, a `.jpeg()` before the `.toBuffer()`. The call rejects
  // with the name of what it reached for.
  it("hides a face with no filesystem, network or encode call", async () => {
    const result = await redact({
      image,
      regions: [face],
      matches: [],
      redaction: { blurUnknownFaces: true },
    });

    expect(reached).toEqual([]);
    expect(result.redactions).toEqual([
      { regionId: "face-1", reason: "unknown-face" },
    ]);
    // And it did the work: the stubs did not simply make the mask a no-op.
    expect(result.image.data).not.toStrictEqual(image.data);
    expect(result.image.data.length).toBe(image.data.length);
  });
});
