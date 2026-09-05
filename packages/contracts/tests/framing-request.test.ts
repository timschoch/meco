import { z } from "zod";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_ANCHOR,
  DEFAULT_PIN_TO,
  FramingRequest,
  PinTo,
} from "../index";
import { schemaConformance } from "../conformance";
import {
  framingRequest,
  invalidFramingRequests,
  minimalFramingRequest,
} from "./samples";

describe("schemaConformance over the FramingRequest", () => {
  const checks = schemaConformance(FramingRequest, {
    valid: [
      { name: "a full request", value: framingRequest },
      { name: "a minimal request", value: minimalFramingRequest },
    ],
    invalid: invalidFramingRequests,
  });

  for (const check of checks) it(check.name, check.run);
});

// Neither default lives in the schema. Both are constants frame applies, so
// the stored call record shows what the caller sent and not what frame assumed.
describe("FramingRequest defaults", () => {
  it("leaves anchor unset rather than filling it in", () => {
    expect(minimalFramingRequest.anchor).toBeUndefined();
    expect(FramingRequest.parse(minimalFramingRequest).anchor).toBeUndefined();
    expect(DEFAULT_ANCHOR).toBe("center");
  });

  it("refuses a request with no pinTo rather than filling one in", () => {
    const { pinTo: _omitted, ...withoutPinTo } = minimalFramingRequest;
    expect(FramingRequest.safeParse(withoutPinTo).success).toBe(false);
  });

  it("offers the caller's ladder as a constant the gateway applies", () => {
    expect(DEFAULT_PIN_TO).toEqual(["match", "face", "kart"]);
    expect(PinTo.options).toEqual(["match", "face", "kart"]);
  });
});

// No mutation of ours turns this red: zod 4 emits `additionalProperties: false`
// for a loose object too. It pins zod's behaviour, so a version that stopped
// closing the object — and let a caller smuggle a template id past the MCP
// server — fails here instead of at the gateway.
describe("FramingRequest as an MCP tool input schema", () => {
  it("converts to a closed JSON Schema the gateway registers unaltered", () => {
    const json = z.toJSONSchema(FramingRequest) as {
      additionalProperties?: boolean;
      required?: string[];
    };
    expect(json.additionalProperties).toBe(false);
    expect(json.required).toEqual(
      expect.arrayContaining([
        "brand",
        "source",
        "target",
        "pinTo",
        "occlusion",
        "redaction",
      ])
    );
  });
});
