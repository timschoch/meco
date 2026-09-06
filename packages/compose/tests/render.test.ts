import fs, { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ComposeError, render, type RenderInput } from "../index";
import { GOLDEN_CASES, inputFor, LAICA_CASES, STORY_CASE } from "./cases";
import { GOLDEN_THRESHOLD, GOLDENS } from "./goldens";
import { centredWindow, decode, widenBy } from "./fixture";
import { PLACEMENTS } from "../placements";
import {
  MAGIC,
  meanAbsoluteDifference,
  raster,
  SMALLEST_PLAUSIBLE_OUTPUT,
} from "./pixels";

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
    expect(bytes.length).toBeGreaterThan(SMALLEST_PLAUSIBLE_OUTPUT);

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

  it("reaches neither the network nor the disk once warm", async () => {
    // A Look reads its fonts and wordmark on first use and holds them, so by
    // the second `render` there is nothing left for it to open. The warm-up
    // call is what makes the claim true rather than accidentally true.
    //
    // What the spies actually cover is narrower than it looks. `fetch` is a
    // global, so that half is real. The disk half is not the memo's proof:
    // `spyOn` replaces a property of the `node:fs` namespace object, and a Look
    // reads through a named import that the replacement never reaches —
    // measured by dropping the memo, which leaves this test green and turns
    // `assets.test.ts > are read once, however many renders follow` red. That
    // file mocks the module and is where the memo is held to account. Neither
    // spy sees sharp or takumi, which do their own I/O in Rust; the fonts being
    // committed rather than fetched is what makes the network half true.
    const input = await story({ format: "png" });
    await render(input);

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
      expect(bytes.length).toBeGreaterThan(SMALLEST_PLAUSIBLE_OUTPUT);
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

describe("a window for a Template whose Image Slot is a column", () => {
  // Neither laica Placement has its slot's shape: `linkedin/wide` is 1200x627
  // over a 504x627 column, `linkedin/post` 1200x1200 over a 1024x504 plate.
  // Cutting the window to the Placement is the mistake the gateway would make
  // if it took frame's `target` from the catalogue instead of from the Plan.
  const PLACEMENT_ASPECT: Record<string, { width: number; height: number }> = {
    "linkedin/wide": { width: 1200, height: 627 },
    "linkedin/post": { width: 1200, height: 1200 },
  };

  it.each(LAICA_CASES)(
    "refuses a window cut to $placement's own aspect",
    async (test) => {
      const source = await decode(test.fixture);
      const window = centredWindow(source, PLACEMENT_ASPECT[test.placement]!);

      await expect(
        render(await inputFor(test, { source, window }))
      ).rejects.toThrow(expect.objectContaining({ code: "framing_mismatch" }));
    }
  );

  it.each(LAICA_CASES)(
    "accepts at $placement the window the Plan's own Image Slot asks for",
    async (test) => {
      // `inputFor` cuts exactly that window, so this is the golden's own call
      // minus the comparison. The size is asserted, not just the absence of a
      // throw: the canvas is the Placement's even though the window was the
      // slot's, and that pair is the whole point of the column.
      const { bytes } = await render(await inputFor(test, { format: "png" }));

      const decoded = await raster(bytes);
      expect([decoded.width, decoded.height]).toEqual([
        PLACEMENT_ASPECT[test.placement]!.width,
        PLACEMENT_ASPECT[test.placement]!.height,
      ]);
    }
  );
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
