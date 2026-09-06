// The edges of the module: a face against the image boundary, a face too small
// to cover a pixel, and the clip guard that no valid Region can reach.
//
// These run on `checkerboard` rather than on the photograph. A boundary check
// needs detail *in the corner*, and `artemis-2-crew.jpg` has none there —
// `samples.ts` carries the measurement.
import { beforeAll, describe, expect, it } from "vitest";
import type { Box } from "@meco/contracts";
import { redact, type RedactRequest, type RedactResult } from "../index";
import { CHECKERBOARD_SIZE, checkerboard, faceOn, facesOn } from "./samples";
import {
  boundsOf,
  changedBounds,
  changedChannels,
  clipOf,
  countPixels,
  grownBy,
  insideCore,
  meanLaplacian,
  rectangleOf,
  type Rectangle,
} from "./pixels";

let image: RedactRequest["image"];

beforeAll(() => {
  image = checkerboard();
});

/** One face Region, nothing matched, the policy on. */
const hide = (box: Box): Promise<RedactResult> =>
  redact({
    image,
    regions: [faceOn(box)],
    matches: [],
    redaction: { blurUnknownFaces: true },
  });

/** Every pixel of the image that lies outside `rect`. */
const outside =
  (rect: Rectangle) =>
  (x: number, y: number): boolean =>
    x < rect.left ||
    y < rect.top ||
    x >= rect.left + rect.width ||
    y >= rect.top + rect.height;

describe("a face against the image edge", () => {
  /** The two corners, flush: `0 + 0.2` starts at 0 and `0.8 + 0.2` ends at 1. */
  const corners = [
    ["the top-left corner", { x: 0, y: 0, width: 0.2, height: 0.2 }],
    ["the bottom-right corner", { x: 0.8, y: 0.8, width: 0.2, height: 0.2 }],
  ] as const;

  // Mutation: skip the `.blur()`. The ratio returns to 1.00 in both corners.
  //
  // Both boxes are flush against the boundary and both are inside it, so they
  // do not reach the clip in `lib/pixel-rectangle.ts`. That guard, and the
  // ellipse it does not shrink, are exercised below.
  it.each(corners)("is hidden at %s", async (_where, box) => {
    const result = await hide(box);
    const rect = rectangleOf(box, image);
    const core = insideCore(rect);

    // Flush, not merely near: the rectangle touches the image's own boundary.
    expect(
      rect.left === 0 || rect.left + rect.width === CHECKERBOARD_SIZE.width
    ).toBe(true);
    expect(
      rect.top === 0 || rect.top + rect.height === CHECKERBOARD_SIZE.height
    ).toBe(true);

    expect(result.redactions).toEqual([
      { regionId: "face-1", reason: "unknown-face" },
    ]);

    // Nothing left the buffer, in either direction.
    expect(result.image.data.length).toBe(image.data.length);
    expect(result.image.data.length).toBe(image.width * image.height * 3);

    // The detail bound of `docs/specs/redact.md`, inside this ellipse.
    const was = meanLaplacian(image, rect, core);
    const now = meanLaplacian(result.image, rect, core);
    expect(was).toBeGreaterThan(100);
    expect(now / was).toBeLessThan(0.2);

    // And the mask stayed inside the Region, right up against the boundary.
    const changed = changedBounds(image, result.image, grownBy(rect, 2, image));
    expect(changed).toBeDefined();
    expect(changed!.left).toBeGreaterThanOrEqual(rect.left);
    expect(changed!.top).toBeGreaterThanOrEqual(rect.top);
    expect(changed!.left + changed!.width).toBeLessThanOrEqual(
      rect.left + rect.width
    );
    expect(changed!.top + changed!.height).toBeLessThanOrEqual(
      rect.top + rect.height
    );
  });
});

describe("a face too small to cover a pixel", () => {
  /** `width` is above zero, so contracts accepts it; 0.0001 x 640 is 0.064 px. */
  const roundsAway = [
    ["no width", { x: 0.5, y: 0.5, width: 0.0001, height: 0.2 }],
    ["no height", { x: 0.5, y: 0.5, width: 0.2, height: 0.0001 }],
  ] as const;

  it.each(roundsAway)(
    "yields no Record and no throw on its own with %s",
    async (_, box) => {
      const rect = rectangleOf(box, image);
      expect(rect.width === 0 || rect.height === 0).toBe(true);

      const result = await hide(box);

      expect(result.redactions).toEqual([]);
      // Nothing was painted, so the request's own buffer comes back out.
      expect(result.image).toBe(image);
    }
  );

  // Mutation: take the Records off the Unknown Faces rather than off the masks
  // actually painted. Then the Region that rounds away is reported as hidden
  // while nothing was drawn, which is a Record for a face nothing happened to.
  //
  // A face beside it is what makes this bite. Alone, the Region that rounds
  // away leaves nothing to paint at all, and the check above passes through the
  // early return without ever reaching the line that builds the Records.
  it.each(roundsAway)(
    "is left out of the Records beside a face that got a mask, with %s",
    async (_, box) => {
      const regions = facesOn(box, { x: 0.1, y: 0.1, width: 0.2, height: 0.2 });
      const painted = regions.find((region) => region.box.width > 0.01)!;

      const result = await redact({
        image,
        regions,
        matches: [],
        redaction: { blurUnknownFaces: true },
      });

      expect(regions).toHaveLength(2);
      expect(result.redactions).toEqual([
        { regionId: painted.id, reason: "unknown-face" },
      ]);
    }
  );
});

// These two checks reach under the `@meco/contracts` schema on purpose, and
// neither can be driven red without doing so. `Box` refuses `x + width` above
// 1, so no validated Region can put an ellipse past the image edge: the clip in
// `lib/pixel-rectangle.ts` is a guard against a schema regression, not a path
// any caller can take. `assignRegionIds` does not validate, so a Region built
// by hand rather than parsed carries the box straight through.
describe("the clip guard, reached under the schema", () => {
  /** Half of this box hangs off the right edge and half off the bottom. */
  const outOfRange: Box = { x: 0.6, y: 0.6, width: 0.5, height: 0.5 };

  let ellipse: Rectangle;
  let patch: Rectangle;

  beforeAll(() => {
    ellipse = rectangleOf(outOfRange, image);
    patch = clipOf(ellipse, image)!;
  });

  // Mutation: drop the clip and hand `extract` the ellipse's own rectangle.
  // sharp answers `extract_area: bad extract area` and the call rejects.
  //
  // Mutation: run the blend loop over the ellipse's width rather than the
  // patch's. Then the write wraps into the next row and past the end of the
  // buffer, which is why this sweeps the **whole image** and not the patch's
  // neighbourhood: the wrapped pixels land at the far side, where a sweep
  // bounded by the patch would never look.
  it("writes nothing outside the part of the ellipse on the image", async () => {
    // Off the edge, but the ellipse's centre is still on the image, so there
    // is something for the visible part of it to cover.
    expect(outOfRange.x + outOfRange.width).toBeGreaterThan(1);
    expect(outOfRange.y + outOfRange.height).toBeGreaterThan(1);
    expect(ellipse.left + ellipse.width).toBeGreaterThan(image.width);
    expect(ellipse.top + ellipse.height).toBeGreaterThan(image.height);
    expect(patch.width).toBeLessThan(ellipse.width);

    const result = await hide(outOfRange);

    expect(result.image.data.length).toBe(image.data.length);
    expect(
      changedChannels(image, result.image, boundsOf(image), outside(patch))
    ).toBe(0);
  });

  // Mutation: re-inscribe the ellipse in the patch — hand `paintMask` the
  // patch as the ellipse as well as the extract window.
  //
  // An ellipse inscribed in the patch is inside the patch by construction, so
  // it can cover at most pi/4 of it, and it measures 78.4 %. The visible part
  // of the face's own ellipse is larger than that, because that ellipse is
  // larger than the patch and runs off two of its sides: 88.6 %, measured on
  // `checkerboard` at 640x800.
  it("covers the visible part of the face's ellipse, not a smaller one", async () => {
    const result = await hide(outOfRange);

    // Every square of `checkerboard` is black or white, so a pixel the mask
    // touched at all is a pixel whose bytes moved.
    const differs = (x: number, y: number): boolean => {
      const at = (y * image.width + x) * 3;
      return (
        image.data[at] !== result.image.data[at] ||
        image.data[at + 1] !== result.image.data[at + 1] ||
        image.data[at + 2] !== result.image.data[at + 2]
      );
    };

    const covered = countPixels(patch, differs) / (patch.width * patch.height);

    expect(covered).toBeGreaterThan(0.85);
    expect(covered).toBeLessThan(1);
  });
});
