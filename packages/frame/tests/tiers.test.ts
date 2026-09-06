import { describe, expect, it } from "vitest";
import { Annotation } from "@meco/contracts";
import { frameCrop } from "../index";
import { FACE_FIXTURES, KART_FIXTURES, matchOf, requestFor } from "./samples";

const SQUARE_TARGET = { width: 1080, height: 1080 };

/** `artemis-2-crew.jpg`: four faces, and the largest — what `face` leads on — is `face-4`. */
const crowd = () =>
  Annotation.parse(
    FACE_FIXTURES.find((f) => f.name === "artemis-2-crew.jpg")!.raw
  );

/**
 * The tier order is the ladder's promise and not one rung's, so it is checked
 * on every rung that can answer. The drop rung (#108) reads one rule: the
 * cheapest Subject to sacrifice is the last one.
 */
describe("kept Regions come back in tier order on every rung", () => {
  // The case the universal rule exists for. `persons` excludes both Matches, so
  // the `match` rung composes nothing and `face` answers — and the faces those
  // Matches named still outrank the unmatched ones.
  it("keeps a matched face in the middle tier when the face rung answered", () => {
    const framing = frameCrop({
      annotation: crowd(),
      matches: [
        matchOf("face-3", "person-c", 0.81),
        matchOf("face-1", "person-a", 0.44),
      ],
      request: requestFor(SQUARE_TARGET, {
        pinTo: ["match", "face"],
        persons: ["person-z"],
      }),
    });

    expect(framing.resolvedBy).toBe("face");
    expect(framing.keptRegionIds).toEqual([
      "face-4", // the leader, which is the largest face
      "face-1", // matched, and by Region id ahead of face-3
      "face-3",
      "face-2", // matched by nobody
    ]);
  });

  // No Match at all, so the middle tier is empty and the rule is the leader
  // followed by Region id order.
  it("puts the leader first on the face rung with no Match in play", () => {
    const framing = frameCrop({
      annotation: crowd(),
      request: requestFor(SQUARE_TARGET, { pinTo: ["face"] }),
    });

    expect(framing.keptRegionIds).toEqual([
      "face-4",
      "face-1",
      "face-2",
      "face-3",
    ]);
  });

  // The kart rung keeps `person` and `vehicle` Regions, which no Match names,
  // so its middle tier is empty on every fixture. `vehicle-1` leading a list
  // that starts with `person-1` in Region id order is the rule showing.
  for (const { name, raw, leadRegionId, keptRegionIds } of KART_FIXTURES) {
    it(`puts the seed first on the kart rung: ${name}`, () => {
      const framing = frameCrop({
        annotation: Annotation.parse(raw),
        request: requestFor(SQUARE_TARGET, { pinTo: ["kart"] }),
      });

      expect(framing.keptRegionIds[0]).toBe(leadRegionId);
      expect(framing.keptRegionIds).toEqual(keptRegionIds);
    });
  }

  // Region ids are `<kind>-<n>`, and `n` is a number: `person-18` sorts after
  // `person-6`, which a text comparison gets backwards. `paddock-mixed.jpg` is
  // the only fixture holding a two-digit Region.
  it("orders a tier by the id's number, not by its text", () => {
    const { raw } = KART_FIXTURES.find((f) => f.name === "paddock-mixed.jpg")!;
    const framing = frameCrop({
      annotation: Annotation.parse(raw),
      request: requestFor(SQUARE_TARGET, { pinTo: ["kart"] }),
    });

    const people = framing.keptRegionIds.filter((id) =>
      id.startsWith("person-")
    );

    expect(people).toEqual([
      "person-1",
      "person-6",
      "person-18",
      "person-19",
      "person-22",
      "person-23",
      "person-24",
      "person-25",
    ]);
  });
});
