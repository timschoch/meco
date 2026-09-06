import { describe, expect, it } from "vitest";
import { PLACEMENTS as VIA_PACKAGE } from "@meco/compose/placements";
import { PLACEMENTS } from "../index";
import { PLACEMENTS as VIA_PATH } from "../placements";

describe("PLACEMENTS", () => {
  it("is the seven Channel sizes, and nothing else", () => {
    // Transcribed from `docs/specs/compose.md` rather than derived from the
    // catalogue, because a Channel's size is a fact about the Channel: this is
    // the copy that says the numbers are still right, so it has to be
    // independent of the one under test.
    expect(PLACEMENTS).toEqual([
      { id: "linkedin/post", width: 1200, height: 1200 },
      { id: "linkedin/wide", width: 1200, height: 627 },
      { id: "instagram/post", width: 1080, height: 1350 },
      { id: "instagram/story", width: 1080, height: 1920 },
      { id: "x/post", width: 1600, height: 900 },
      { id: "facebook/post", width: 1200, height: 630 },
      { id: "facebook/story", width: 1080, height: 1920 },
    ]);
  });

  it("is one catalogue, whichever entry point reaches it", () => {
    // `@meco/compose/placements` is the gateway's own import, resolved through
    // the package's `exports` map: it is what proves `placements.ts` is an
    // entry point and not merely a file, and that the gateway can have the
    // catalogue without pulling the renderer in behind it.
    expect(VIA_PACKAGE).toBe(PLACEMENTS);
    expect(VIA_PATH).toBe(PLACEMENTS);
  });
});
