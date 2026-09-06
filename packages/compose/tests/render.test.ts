import fs, { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ComposeError, render, type RenderInput } from "../index";
import { GOLDEN_CASES, inputFor, STORY_CASE } from "./cases";
import { GOLDENS } from "./goldens";
import { centredWindow, decode, widenBy } from "./fixture";
import { PLACEMENTS } from "../placements";
import { meanAbsoluteDifference, raster } from "./pixels";

/**
 * How far a fresh render may sit from its golden, in mean absolute 8-bit levels
 * per channel.
 *
 * Measured, not guessed. Every number below is this check's own output on the
 * committed golden, which was generated on darwin-arm64.
 *
 * - darwin-arm64 (Apple M4, Node 22.22, takumi 2.13.6, sharp 0.35.4): 0.0000.
 *   takumi is byte-deterministic within a process (ADR-0009) and, as the
 *   determinism check below shows, across calls too.
 * - linux-x64 (GitHub Actions ubuntu-latest, Node 22): 0.0000, run 33998908844.
 *
 * The threshold has to sit under what a wrong Look makes, and that difference
 * is small because a wordmark is 0.5 % of a story's area: swapping in the Hope
 * Family logo scores 0.3558, and `fit: "cover"` for `fit: "fill"` scores
 * 0.5592. At 0.02 the check clears both platforms by their full margin and
 * still catches the weaker of those two mutations by 18x. Should the two
 * platforms ever stop agreeing exactly, a whole-image mean can no longer tell
 * drift from a wrong Look and this has to become a per-tile comparison.
 */
const GOLDEN_THRESHOLD = 0.02;

/** JPEG q90 of a rendered story is ~200 KB; anything tiny is an empty frame. */
const SMALLEST_PLAUSIBLE_RENDER = 10_000;

const MAGIC: Record<string, (b: Uint8Array) => boolean> = {
  jpeg: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  png: (b) => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47,
  webp: (b) =>
    String.fromCharCode(...b.slice(0, 4)) === "RIFF" &&
    String.fromCharCode(...b.slice(8, 12)) === "WEBP",
};

/** The golden's own call, so the tests and the committed picture cannot drift. */
const story = (overrides: Partial<RenderInput> = {}) =>
  inputFor(STORY_CASE, overrides);

describe("render", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("turns a fixture photograph into a 1080x1920 JPEG by default", async () => {
    const { bytes, mime } = await render(await story());

    expect(mime).toBe("image/jpeg");
    expect(MAGIC.jpeg?.(bytes)).toBe(true);
    expect(bytes.length).toBeGreaterThan(SMALLEST_PLAUSIBLE_RENDER);

    const decoded = await raster(bytes);
    expect([decoded.width, decoded.height]).toEqual([1080, 1920]);
  });

  it.each(["png", "webp"] as const)(
    "encodes %s when the caller asks for it",
    async (format) => {
      const { bytes, mime } = await render(await story({ format }));

      expect(mime).toBe(`image/${format}`);
      expect(MAGIC[format]?.(bytes)).toBe(true);
      const decoded = await raster(bytes);
      expect([decoded.width, decoded.height]).toEqual([1080, 1920]);
    }
  );

  it("reaches neither the network nor the disk", async () => {
    // A Look reads its fonts and wordmark when its module loads, so by the time
    // `render` runs there is nothing left for it to open. Both spies watch the
    // JavaScript layer only — sharp and takumi do their own I/O in Rust — which
    // is why the fonts being committed, rather than fetched, is what actually
    // makes the claim true.
    const input = await story({ format: "png" });
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const readSpy = vi.spyOn(fs, "readFileSync");
    const openSpy = vi.spyOn(fs.promises, "readFile");

    await render(input);

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(readSpy).not.toHaveBeenCalled();
    expect(openSpy).not.toHaveBeenCalled();
  });

  it("is deterministic: two renders of the same call are byte-identical", async () => {
    const first = await render(await story({ format: "png" }));
    const second = await render(await story({ format: "png" }));

    expect(Buffer.from(second.bytes).equals(Buffer.from(first.bytes))).toBe(
      true
    );
  });
});

describe("every Template at every Placement it declares", () => {
  it.each(GOLDEN_CASES)(
    "$template renders $placement at the Placement's own size",
    async (test) => {
      const placement = PLACEMENTS.find((p) => p.id === test.placement)!;
      const { bytes, mime } = await render(await inputFor(test));

      expect(mime).toBe("image/jpeg");
      expect(bytes.length).toBeGreaterThan(SMALLEST_PLAUSIBLE_RENDER);
      const decoded = await raster(bytes);
      expect([decoded.width, decoded.height]).toEqual([
        placement.width,
        placement.height,
      ]);
    }
  );
});

describe("golden images", () => {
  it.each(GOLDEN_CASES)(
    "$template at $placement matches its golden",
    async (test) => {
      const fresh = await raster(
        (await render(await inputFor(test, { format: "png" }))).bytes
      );
      const golden = await raster(
        readFileSync(fileURLToPath(new URL(test.golden, GOLDENS)))
      );

      const difference = meanAbsoluteDifference(fresh, golden);
      // Printed on every run so each platform's own number is on the record,
      // CI's included.
      console.log(
        `golden ${test.golden}: mean absolute difference ${difference.toFixed(4)} (threshold ${GOLDEN_THRESHOLD})`
      );
      expect(difference).toBeLessThanOrEqual(GOLDEN_THRESHOLD);
    }
  );
});

describe("the framing_mismatch tolerance", () => {
  const STORY_ASPECT = { width: 1080, height: 1920 };

  it("refuses a window two source pixels off the Image Slot's aspect", async () => {
    const source = await decode(STORY_CASE.fixture);
    const window = widenBy(centredWindow(source, STORY_ASPECT), source, 2);

    await expect(render(await story({ source, window }))).rejects.toThrow(
      expect.objectContaining({ code: "framing_mismatch" })
    );
  });

  it("accepts the nearest window a 1600x1000 photograph can offer", async () => {
    const source = await decode(STORY_CASE.fixture);
    // 1600x1000 cannot express 9:16 exactly: the nearest window is 563x1000,
    // half a pixel wide of the ideal 562.5. Refusing it would refuse every
    // window frame can actually cut from this photograph.
    const window = centredWindow(source, STORY_ASPECT);
    expect(Math.round(window.width * source.width)).toBe(563);

    await expect(
      render(await story({ source, window, format: "png" }))
    ).resolves.toBeDefined();
  });

  it("accepts a window one pixel wide of ideal, whatever the slot's aspect", async () => {
    // The regression the first two cases miss. A 1126x2000 window is exactly
    // 1 px wider than the ideal 1125x2000, so it must pass — but read on the
    // height axis the same deviation is 1.78 px, and a check that takes the
    // larger of the two would refuse a window frame could not improve on.
    const source = await decode(STORY_CASE.fixture);
    const tall = { ...source, width: 2252, height: 2000 };
    tall.data = Buffer.alloc(tall.width * tall.height * 3, 90);
    const window = {
      x: 0,
      y: 0,
      width: 1126 / tall.width,
      height: 1,
    };
    expect(Math.round(window.width * tall.width)).toBe(1126);

    await expect(
      render(await story({ source: tall, window, format: "png" }))
    ).resolves.toBeDefined();
  });
});

describe("refusals", () => {
  it.each([
    [{ template: "no-such-template" }, "unknown_template"],
    [{ brand: "no-such-brand" }, "unknown_brand"],
    [{ placement: "linkedin/wide" }, "placement_not_supported"],
    [{ placement: "no-such-placement" }, "placement_not_supported"],
    [{ fields: { kicker: "only a kicker" } }, "invalid_fields"],
  ])("refuses %o with %s", async (overrides, code) => {
    const call = render(await story(overrides));

    await expect(call).rejects.toBeInstanceOf(ComposeError);
    await expect(call).rejects.toThrow(expect.objectContaining({ code }));
  });
});
