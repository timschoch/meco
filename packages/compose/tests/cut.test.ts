import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ComposeError, cut, render } from "../index";
import { CUT_CASE, cutInputFor, inputFor, STORY_CASE } from "./cases";
import { GOLDENS } from "./goldens";
import { centredWindow, decode, widenBy } from "./fixture";
import { meanAbsoluteDifference, raster, type Raster } from "./pixels";

/** The same number `render.test.ts` measured, on the same fixture and size. */
const GOLDEN_THRESHOLD = 0.02;

/** JPEG q90 of a 1080x1920 photograph is ~200 KB; anything tiny is an empty frame. */
const SMALLEST_PLAUSIBLE_CUT = 10_000;

const MAGIC: Record<string, (b: Uint8Array) => boolean> = {
  jpeg: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  png: (b) => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47,
  webp: (b) =>
    String.fromCharCode(...b.slice(0, 4)) === "RIFF" &&
    String.fromCharCode(...b.slice(8, 12)) === "WEBP",
};

describe("cut", () => {
  it("turns a fixture photograph into a 1080x1920 JPEG by default", async () => {
    const { bytes, mime } = await cut(await cutInputFor());

    expect(mime).toBe("image/jpeg");
    expect(MAGIC.jpeg?.(bytes)).toBe(true);
    expect(bytes.length).toBeGreaterThan(SMALLEST_PLAUSIBLE_CUT);

    const decoded = await raster(bytes);
    expect([decoded.width, decoded.height]).toEqual([1080, 1920]);
  });

  it.each(["png", "webp"] as const)(
    "encodes %s when the caller asks for it",
    async (format) => {
      const { bytes, mime } = await cut(await cutInputFor({ format }));

      expect(mime).toBe(`image/${format}`);
      expect(MAGIC[format]?.(bytes)).toBe(true);
      const decoded = await raster(bytes);
      expect([decoded.width, decoded.height]).toEqual([1080, 1920]);
    }
  );

  it("matches its golden", async () => {
    const fresh = await raster(
      (await cut(await cutInputFor({ format: "png" }))).bytes
    );
    const golden = await raster(
      readFileSync(fileURLToPath(new URL(CUT_CASE.golden, GOLDENS)))
    );

    const difference = meanAbsoluteDifference(fresh, golden);
    console.log(
      `golden ${CUT_CASE.golden}: mean absolute difference ${difference.toFixed(4)} (threshold ${GOLDEN_THRESHOLD})`
    );
    expect(difference).toBeLessThanOrEqual(GOLDEN_THRESHOLD);
  });
});

describe("the framing_mismatch tolerance", () => {
  it("refuses a window two source pixels off the target's aspect", async () => {
    const source = await decode(CUT_CASE.fixture);
    const window = widenBy(centredWindow(source, CUT_CASE.target), source, 2);

    await expect(cut(await cutInputFor({ source, window }))).rejects.toThrow(
      expect.objectContaining({ code: "framing_mismatch" })
    );
    await expect(
      cut(await cutInputFor({ source, window }))
    ).rejects.toBeInstanceOf(ComposeError);
  });

  it("accepts the nearest window a 1600x1000 photograph can offer", async () => {
    // 1600x1000 cannot express 9:16 exactly: the nearest window is 563x1000,
    // half a pixel wide of the ideal 562.5. The same smaller-deviation rule
    // `render` applies, reached through the same function.
    const source = await decode(CUT_CASE.fixture);
    const window = centredWindow(source, CUT_CASE.target);
    expect(Math.round(window.width * source.width)).toBe(563);

    await expect(
      cut(await cutInputFor({ source, window, format: "png" }))
    ).resolves.toBeDefined();
  });
});

describe("cut and render", () => {
  /**
   * The part of `swisshutless-story` where nothing covers the picture: rows
   * inside the band its scrim holds at alpha 0 (14 % to 46 % of the canvas),
   * minus the 16 px brand stripe down the left edge. The Template's one
   * `Occludes` is the block of type at the bottom, well below this.
   *
   * A shipped Template rather than a blank one, because compose ships no empty
   * Template and registering one for a test would put it in the catalogue every
   * caller reads. What the check needs is a region a Template leaves alone, and
   * this is one, measured: outside it every column differs by the scrim, inside
   * it only the stripe does.
   */
  const CLEAR = { top: 0.2, bottom: 0.44, left: 16 };

  /** Every byte of one region of a picture, row by row. */
  const region = (picture: Raster): Buffer => {
    const rows: Uint8Array[] = [];
    for (
      let y = Math.round(picture.height * CLEAR.top);
      y < Math.round(picture.height * CLEAR.bottom);
      y++
    ) {
      const start = (y * picture.width + CLEAR.left) * 3;
      rows.push(picture.data.subarray(start, (y + 1) * picture.width * 3));
    }
    return Buffer.concat(rows);
  };

  it("put the same pixels in the Image Slot", async () => {
    const input = await inputFor(STORY_CASE, { format: "png" });
    const drawn = await raster((await render(input)).bytes);
    const bare = await raster(
      (
        await cut({
          source: input.source,
          window: input.window,
          target: { width: drawn.width, height: drawn.height },
          format: "png",
        })
      ).bytes
    );

    expect([bare.width, bare.height]).toEqual([drawn.width, drawn.height]);
    expect(region(bare)).toEqual(region(drawn));
  });
});
