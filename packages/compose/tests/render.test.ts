import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ComposeError, render } from "../index";
import { GOLDEN_CASES, inputFor } from "./cases";
import { GOLDENS } from "./goldens";
import { centredWindow, decode, KART_FIXTURE, widenBy } from "./fixture";
import { meanAbsoluteDifference, raster } from "./pixels";

/**
 * How far a fresh render may sit from its golden, in mean absolute 8-bit levels
 * per channel.
 *
 * Measured, not guessed. Every number below is this check's own output on the
 * committed golden, which was generated on darwin-arm64.
 *
 * - darwin-arm64 (Apple M4, Node 22.22, sharp 0.35.4, takumi 2.13.6): 0.0000.
 *   takumi is byte-deterministic within a process (ADR-0009) and, as the
 *   determinism test above shows, across calls too.
 * - linux-x64 (GitHub Actions ubuntu-latest, Node 22): 0.0000.
 *
 * The threshold has to sit under what a wrong Look makes, and that difference
 * is small because a wordmark is 0.5 % of a story's area: swapping in the Hope
 * Family logo scores 0.3558, and `fit: "cover"` for `fit: "fill"` scores
 * 0.5592. At 0.02 the check clears both platforms by its full margin and still
 * catches the weaker of those two mutations by 18x.
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

const STORY = {
  template: "swisshutless-story",
  placement: "instagram/story",
  brand: "swisshutless",
} as const;

const FIELDS = {
  headline: "Wohlen",
  kicker: "Nächstes Rennen",
  subline: "Wohlen, Schweiz",
  footnote: "12. – 14. Juni 2026",
};

async function storyInput(
  overrides: Partial<Parameters<typeof render>[0]> = {}
) {
  const source = await decode(KART_FIXTURE);
  return {
    ...STORY,
    fields: FIELDS,
    source,
    window: centredWindow(source, { width: 1080, height: 1920 }),
    ...overrides,
  };
}

describe("render", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("turns a fixture photograph into a 1080x1920 JPEG by default", async () => {
    const { bytes, mime, width, height } = await render(await storyInput());

    expect(mime).toBe("image/jpeg");
    expect(width).toBe(1080);
    expect(height).toBe(1920);
    expect(MAGIC.jpeg?.(bytes)).toBe(true);
    expect(bytes.length).toBeGreaterThan(SMALLEST_PLAUSIBLE_RENDER);

    const decoded = await raster(bytes);
    expect([decoded.width, decoded.height]).toEqual([1080, 1920]);
  });

  it.each(["png", "webp"] as const)(
    "encodes %s when the caller asks for it",
    async (format) => {
      const { bytes, mime } = await render(await storyInput({ format }));

      expect(mime).toBe(`image/${format}`);
      expect(MAGIC[format]?.(bytes)).toBe(true);
      const decoded = await raster(bytes);
      expect([decoded.width, decoded.height]).toEqual([1080, 1920]);
    }
  );

  it("makes no network call", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    await render(await storyInput({ format: "png" }));

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("is deterministic: two renders of the same call are byte-identical", async () => {
    const first = await render(await storyInput({ format: "png" }));
    const second = await render(await storyInput({ format: "png" }));

    expect(Buffer.from(second.bytes).equals(Buffer.from(first.bytes))).toBe(
      true
    );
  });
});

describe("golden images", () => {
  it.each(GOLDEN_CASES)(
    "$template at $placement matches its golden",
    async (test) => {
      const fresh = await raster(
        (await render(await inputFor(test, "png"))).bytes
      );
      const golden = await raster(
        readFileSync(fileURLToPath(new URL(test.golden, GOLDENS)))
      );

      const difference = meanAbsoluteDifference(fresh, golden);
      // Printed on every run so the platform's own number is on the record,
      // including CI's.
      console.log(
        `golden ${test.golden}: mean absolute difference ${difference.toFixed(4)} (threshold ${GOLDEN_THRESHOLD})`
      );
      expect(difference).toBeLessThanOrEqual(GOLDEN_THRESHOLD);
    }
  );
});

describe("refusals", () => {
  it("refuses a window whose aspect is two source pixels off the Image Slot", async () => {
    const source = await decode(KART_FIXTURE);
    const window = widenBy(
      centredWindow(source, { width: 1080, height: 1920 }),
      source,
      2
    );

    await expect(render(await storyInput({ source, window }))).rejects.toThrow(
      expect.objectContaining({ code: "framing_mismatch" })
    );
  });

  it("accepts a window one source pixel off, which is all a 1000 px source can do", async () => {
    const source = await decode(KART_FIXTURE);
    // 1600x1000 cannot express 9:16 exactly: the nearest window is 563x1000,
    // half a pixel wide of the ideal 562.5. Refusing it would refuse every
    // window frame can actually cut from this photograph.
    const window = centredWindow(source, { width: 1080, height: 1920 });
    expect(Math.round(window.width * source.width)).toBe(563);

    await expect(
      render(await storyInput({ source, window, format: "png" }))
    ).resolves.toBeDefined();
  });

  it.each([
    [{ template: "no-such-template" }, "unknown_template"],
    [{ brand: "no-such-brand" }, "unknown_brand"],
    [{ placement: "linkedin/wide" }, "placement_not_supported"],
    [{ placement: "no-such-placement" }, "placement_not_supported"],
    [{ fields: { kicker: "only a kicker" } }, "invalid_fields"],
  ])("refuses %o with %s", async (overrides, code) => {
    const call = render(await storyInput(overrides));

    await expect(call).rejects.toBeInstanceOf(ComposeError);
    await expect(call).rejects.toThrow(expect.objectContaining({ code }));
  });
});
