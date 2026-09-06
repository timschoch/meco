import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ComposeError, cut, render } from "../index";
import { CUT_CASE, cutInputFor, inputFor, STORY_CASE } from "./cases";
import { GOLDEN_THRESHOLD, GOLDENS } from "./goldens";
import { centredWindow, decode, widenBy } from "./fixture";
import {
  MAGIC,
  meanAbsoluteDifference,
  raster,
  SMALLEST_PLAUSIBLE_OUTPUT,
  type Raster,
} from "./pixels";

describe("cut", () => {
  it("turns a fixture photograph into a 1080x1920 JPEG by default", async () => {
    const { bytes, mime } = await cut(await cutInputFor());

    expect(mime).toBe("image/jpeg");
    expect(MAGIC.jpeg?.(bytes)).toBe(true);
    expect(bytes.length).toBeGreaterThan(SMALLEST_PLAUSIBLE_OUTPUT);

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

  it("accepts a window one pixel wide of ideal, whatever the target's aspect", async () => {
    // The case the two above miss, and the one that says `cut` reads the
    // smaller of the two deviations. A 1126x2000 window is exactly 1 px wider
    // than the ideal 1125x2000, so it must pass — but read down the height axis
    // the same deviation is 1.78 px, and taking the larger of the two would
    // refuse a window frame could not improve on.
    const source = await decode(CUT_CASE.fixture);
    const tall = { ...source, width: 2252, height: 2000 };
    tall.data = Buffer.alloc(tall.width * tall.height * 3, 90);
    const window = { x: 0, y: 0, width: 1126 / tall.width, height: 1 };
    expect(Math.round(window.width * tall.width)).toBe(1126);

    await expect(
      cut(await cutInputFor({ source: tall, window, format: "png" }))
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

  /** A band of rows well inside the scrim, where the Template must show. */
  const COVERED = { top: 0.55, bottom: 0.6, left: 16 };

  /** Every byte of one band of a picture, row by row. */
  const band = (
    picture: Raster,
    rows: { top: number; bottom: number; left: number }
  ): Buffer => {
    const out: Uint8Array[] = [];
    for (
      let y = Math.round(picture.height * rows.top);
      y < Math.round(picture.height * rows.bottom);
      y++
    ) {
      const start = (y * picture.width + rows.left) * 3;
      out.push(picture.data.subarray(start, (y + 1) * picture.width * 3));
    }
    return Buffer.concat(out);
  };

  /** How many bytes of two equal-length buffers disagree. */
  const differences = (a: Buffer, b: Buffer): number => {
    let count = 0;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) count++;
    return count;
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

    // Counted rather than compared with `toEqual`: the band is 1.2 MB, and
    // vitest builds an element-by-element diff for a failing Buffer comparison
    // that takes longer than the render it is checking.
    const clear = band(bare, CLEAR).length;
    expect(
      `${differences(band(bare, CLEAR), band(drawn, CLEAR))} of ${clear} bytes differ`
    ).toBe(`0 of ${clear} bytes differ`);

    // The band above is only worth comparing while the Template really does
    // leave it alone, and that is a fact about `swisshutless-story`'s gradient
    // stops, not about `cut`. Lower down, where the scrim is at full strength,
    // the two must disagree — so a Template edit that drops the scrim turns
    // this red instead of quietly making the check above vacuous.
    expect(
      differences(band(bare, COVERED), band(drawn, COVERED))
    ).toBeGreaterThan(0);
  });
});
