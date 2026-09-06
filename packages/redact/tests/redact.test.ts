import { beforeAll, describe, expect, it } from "vitest";
import { redact, type RedactRequest } from "../index";
import {
  crewRegions,
  crewSize,
  crewWithOtherKinds,
  decodeCrew,
  matchOf,
  smallestFace,
} from "./samples";

let image: RedactRequest["image"];

beforeAll(async () => {
  image = await decodeCrew();
});

/** One call, with the parts a check cares about named and the rest left alone. */
const call = (over: Partial<Omit<RedactRequest, "image">>): RedactRequest => ({
  image,
  regions: crewRegions,
  matches: [],
  redaction: { blurUnknownFaces: true },
  ...over,
});

describe("the fixture the checks stand on", () => {
  it("decodes to the size detected.json recorded its fractions against", () => {
    expect({ width: image.width, height: image.height }).toEqual(crewSize);
    expect(image.data.length).toBe(image.width * image.height * 3);
  });

  it("carries four face Regions, the smallest of them face-1", () => {
    expect(crewRegions.map((r) => r.id)).toEqual([
      "face-1",
      "face-2",
      "face-3",
      "face-4",
    ]);
    expect(smallestFace.id).toBe("face-1");
  });
});

describe("redact, the Unknown Face rule", () => {
  // The four unmatched faces and the empty `matches` are one input, so they are
  // one check. Two mutations must turn it red: treat a missing Match as known,
  // and default an empty `matches` to hiding none.
  it("reports every face Region with no Match, sorted by regionId", async () => {
    const result = await redact(call({ matches: [] }));

    expect(result.redactions).toEqual([
      { regionId: "face-1", reason: "unknown-face" },
      { regionId: "face-2", reason: "unknown-face" },
      { regionId: "face-3", reason: "unknown-face" },
      { regionId: "face-4", reason: "unknown-face" },
    ]);
  });

  // Mutation: treat a missing Match as known. Then the three unmatched faces
  // fall out of the list too. Two similarities, one either side of any
  // threshold identify could hold, because redact must not read the number.
  it.each([0.42, 0.91])(
    "leaves a matched face out at similarity %s, whatever its size",
    async (similarity) => {
      const result = await redact(
        call({ matches: [matchOf(smallestFace.id, similarity)] })
      );

      expect(result.redactions.map((r) => r.regionId)).toEqual(
        crewRegions.filter((r) => r.id !== smallestFace.id).map((r) => r.id)
      );
    }
  );

  // Mutation: widen the kind filter past `face`. Then the person and the
  // vehicle arrive in the list.
  it("never reports a Region that is not a face", async () => {
    const result = await redact(call({ regions: crewWithOtherKinds }));

    expect(crewWithOtherKinds.map((r) => r.kind)).toContain("person");
    expect(crewWithOtherKinds.map((r) => r.kind)).toContain("vehicle");
    expect(result.redactions.map((r) => r.regionId)).toEqual([
      "face-1",
      "face-2",
      "face-3",
      "face-4",
    ]);
  });

  // Mutation: hide the Unknown Faces regardless of the policy. The identity
  // check, not a deep compare: a copy that happens to match is still a copy.
  it("returns the input image and no Record when blurUnknownFaces is false", async () => {
    const result = await redact(
      call({ redaction: { blurUnknownFaces: false } })
    );

    expect(result.redactions).toEqual([]);
    expect(result.image).toBe(image);
  });

  // The mask is drawn into a copy, so the returned image is a different buffer
  // of the same shape. What it holds is `mask.test.ts`'s business.
  it("returns an image of the source's size and channels", async () => {
    const result = await redact(call({}));

    expect({
      width: result.image.width,
      height: result.image.height,
      channels: result.image.channels,
    }).toEqual({ width: image.width, height: image.height, channels: 3 });
    expect(result.image.data.length).toBe(image.width * image.height * 3);
    expect(result.image.data).not.toBe(image.data);
  });
});
