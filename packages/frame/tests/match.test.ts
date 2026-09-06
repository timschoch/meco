import { describe, expect, it } from "vitest";
import { Annotation } from "@meco/contracts";
import { frameCrop } from "../index";
import { FACE_FIXTURES, emptyAnnotation, matchOf, requestFor } from "./samples";

const SQUARE_TARGET = { width: 1080, height: 1080 };
const MATCH_THEN_FACE = { pinTo: ["match", "face"] };
const MATCH_ONLY = { pinTo: ["match"] };

/**
 * `artemis-2-crew.jpg`: four faces, and the largest is the last of them. Every
 * check below leads on one of the other three, so a rung that quietly fell back
 * to the largest box cannot pass by coincidence.
 *
 * The areas, in the square of the source fraction: `face-1` 0.00674, `face-2`
 * 0.00722, `face-3` 0.00756, `face-4` 0.00807.
 */
const crowd = () =>
  Annotation.parse(
    FACE_FIXTURES.find((f) => f.name === "artemis-2-crew.jpg")!.raw
  );

/** The largest face of that crowd, which is what the `face` rung leads on. */
const LARGEST_FACE = "face-4";

const boxOf = (regionId: string) =>
  crowd().regions.find((region) => region.id === regionId)!.box;

describe("the match rung", () => {
  it("leads on the matched face however small it is", () => {
    const framing = frameCrop({
      annotation: crowd(),
      matches: [matchOf("face-1", "person-a", 0.62)],
      request: requestFor(SQUARE_TARGET, MATCH_THEN_FACE),
    });

    expect(framing.resolvedBy).toBe("match");
    expect(framing.leadRegionId).toBe("face-1");
    expect(framing.subject).toEqual(boxOf("face-1"));
  });

  // The point of the rung. `face-1` is the smallest face and `face-4` the
  // largest, so a leader chosen by area rather than by similarity picks the
  // wrong Region here and says so.
  it("takes the highest similarity, not the largest face", () => {
    const framing = frameCrop({
      annotation: crowd(),
      matches: [
        matchOf(LARGEST_FACE, "person-b", 0.41),
        matchOf("face-1", "person-a", 0.88),
      ],
      request: requestFor(SQUARE_TARGET, MATCH_THEN_FACE),
    });

    expect(framing.leadRegionId).toBe("face-1");
  });

  // contracts numbers Regions from sorted position, so "lowest" is the order it
  // hands them over in. Both orders of the same two Matches, because a tie
  // settled by the input order would pass one of them and fail the other.
  it("breaks a tie on the lowest Region id, whichever order the Matches arrive in", () => {
    const tied = [
      matchOf("face-3", "person-c", 0.75),
      matchOf("face-2", "person-b", 0.75),
    ];

    for (const matches of [tied, [...tied].reverse()]) {
      const framing = frameCrop({
        annotation: crowd(),
        matches,
        request: requestFor(SQUARE_TARGET, MATCH_THEN_FACE),
      });

      expect(framing.leadRegionId).toBe("face-2");
    }
  });

  it("keeps every face, the leader first and the other matched faces next", () => {
    const framing = frameCrop({
      annotation: crowd(),
      matches: [
        matchOf("face-1", "person-a", 0.88),
        matchOf("face-3", "person-c", 0.55),
      ],
      request: requestFor(SQUARE_TARGET, MATCH_THEN_FACE),
    });

    // The three tiers, in order: the Leading Subject, a matched non-leading
    // face, every other face. Only #108's drop rung reads them, and it
    // sacrifices from the end.
    expect(framing.keptRegionIds).toEqual([
      "face-1",
      "face-3",
      "face-2",
      LARGEST_FACE,
    ]);
    expect(framing.droppedRegionIds).toEqual([]);
  });

  // "Lowest Region id" is read off the id, never off the position in
  // `annotation.regions`: `assignRegionIds` hands the Regions over in id order,
  // but `Annotation.parse` promises nothing about the order they arrive in.
  // Both answers this rung gives are checked, the leader and the tiers.
  it("reads the id and not the array, so a shuffled Annotation answers the same", () => {
    const shuffled = Annotation.parse({
      ...crowd(),
      regions: [...crowd().regions].reverse(),
    });
    const matches = [
      matchOf("face-3", "person-c", 0.75),
      matchOf("face-2", "person-b", 0.75),
      matchOf("face-1", "person-a", 0.4),
    ];
    const request = requestFor(SQUARE_TARGET, MATCH_THEN_FACE);

    const asRecorded = frameCrop({ annotation: crowd(), matches, request });
    const reversed = frameCrop({ annotation: shuffled, matches, request });

    expect(asRecorded.leadRegionId).toBe("face-2");
    expect(reversed.leadRegionId).toBe(asRecorded.leadRegionId);
    expect(reversed.keptRegionIds).toEqual(asRecorded.keptRegionIds);
  });

  it("ignores a Match naming a Region this picture does not hold", () => {
    const framing = frameCrop({
      annotation: crowd(),
      matches: [matchOf("face-9", "person-a", 0.99)],
      request: requestFor(SQUARE_TARGET, MATCH_THEN_FACE),
    });

    expect(framing.resolvedBy).toBe("face");
    expect(framing.leadRegionId).toBe(LARGEST_FACE);
  });
});

// `identify` scopes Matches to one Brand already. frame checks anyway, because
// a Match crossing the Brand wall would show as a stranger leading somebody
// else's Crop.
describe("a Match made for another Brand", () => {
  const matches = [matchOf("face-1", "person-a", 0.93, "laica")];

  it("never leads", () => {
    const framing = frameCrop({
      annotation: crowd(),
      matches,
      request: requestFor(SQUARE_TARGET, MATCH_THEN_FACE),
    });

    expect(framing.resolvedBy).toBe("face");
    expect(framing.leadRegionId).toBe(LARGEST_FACE);
  });

  it("is not a matched face for the tiers either", () => {
    const framing = frameCrop({
      annotation: crowd(),
      matches: [...matches, matchOf("face-3", "person-c", 0.5)],
      request: requestFor(SQUARE_TARGET, MATCH_THEN_FACE),
    });

    // `face-1` sorts back among the unmatched faces, where its id puts it
    // first; the leader and the one matched face come before it.
    expect(framing.leadRegionId).toBe("face-3");
    expect(framing.keptRegionIds).toEqual([
      "face-3",
      "face-1",
      "face-2",
      LARGEST_FACE,
    ]);
  });
});

describe("persons narrows who may lead", () => {
  const matches = [
    matchOf("face-1", "person-a", 0.88),
    matchOf("face-3", "person-c", 0.55),
  ];

  // `person-c` is the lower similarity of the two, so the list and not the
  // score is what puts `face-3` in front.
  const narrowed = () =>
    frameCrop({
      annotation: crowd(),
      matches,
      request: requestFor(SQUARE_TARGET, {
        ...MATCH_THEN_FACE,
        persons: ["person-c"],
      }),
    });

  it("leads on the listed Person, not on the higher similarity", () => {
    const framing = narrowed();

    expect(framing.resolvedBy).toBe("match");
    expect(framing.leadRegionId).toBe("face-3");
  });

  // The unlisted Match is still a matched face at its tier: `persons` narrows
  // who may lead and nothing else.
  it("keeps the unlisted Match at its tier all the same", () => {
    expect(narrowed().keptRegionIds).toEqual([
      "face-3",
      "face-1",
      "face-2",
      LARGEST_FACE,
    ]);
  });

  // The privacy rule. Framing on a different named person would tell the caller
  // who else is in the picture, which is not what they asked for.
  it("falls through when the photograph matched nobody on the list", () => {
    const framing = frameCrop({
      annotation: crowd(),
      matches,
      request: requestFor(SQUARE_TARGET, {
        ...MATCH_THEN_FACE,
        persons: ["person-z"],
      }),
    });

    expect(framing.resolvedBy).toBe("face");
    expect(framing.leadRegionId).toBe(LARGEST_FACE);
  });

  // An empty list is legal and means no Match may lead. Treating it as an
  // absent list would let `face-1` lead on its 0.88.
  it("lets no Match lead when the list is empty", () => {
    const framing = frameCrop({
      annotation: crowd(),
      matches,
      request: requestFor(SQUARE_TARGET, { ...MATCH_THEN_FACE, persons: [] }),
    });

    expect(framing.resolvedBy).toBe("face");
    expect(framing.leadRegionId).toBe(LARGEST_FACE);
  });
});

// `pinTo: ["match"]` alone, so nothing else can answer and hide the fall
// through to frame's own last resorts.
describe("the match rung with nothing to lead on", () => {
  const source = { width: 1200, height: 800 };

  it("falls through to the centre when no anchor is named", () => {
    const framing = frameCrop({
      annotation: crowd(),
      request: requestFor(SQUARE_TARGET, MATCH_ONLY),
    });

    expect(framing.resolvedBy).toBe("center");
    expect(framing.leadRegionId).toBeUndefined();
    expect(framing.subject).toBeUndefined();
    expect(framing.keptRegionIds).toEqual([]);
  });

  it("falls through to the anchor when one is named", () => {
    const framing = frameCrop({
      annotation: crowd(),
      matches: [],
      request: requestFor(SQUARE_TARGET, {
        ...MATCH_ONLY,
        anchor: "top-left",
      }),
    });

    expect(framing.resolvedBy).toBe("anchor");
    expect(framing.leadRegionId).toBeUndefined();
  });

  // A Match cannot name a face in a picture that holds none, so the rung has
  // nothing to compose from either end.
  it("composes nothing from a picture with no Regions at all", () => {
    const framing = frameCrop({
      annotation: emptyAnnotation(source),
      matches: [matchOf("face-1", "person-a", 0.9)],
      request: requestFor(SQUARE_TARGET, MATCH_ONLY),
    });

    expect(framing.resolvedBy).toBe("center");
  });
});
