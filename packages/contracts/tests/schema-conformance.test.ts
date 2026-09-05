import { describe, expect, it } from "vitest";
import { Annotation } from "../index";
import { schemaConformance } from "../conformance";
import { annotation, invalidAnnotations } from "./samples";

// The way every package consumes the checks: one `it` per returned Check.
describe("schemaConformance over the Annotation", () => {
  const checks = schemaConformance(Annotation, {
    valid: [{ name: "a face with a print and a vehicle", value: annotation }],
    invalid: invalidAnnotations,
  });

  for (const check of checks) it(check.name, check.run);
});

describe("schemaConformance itself", () => {
  it("fails a valid sample the schema refuses", async () => {
    const [check] = schemaConformance(Annotation, {
      valid: [
        {
          name: "not really valid",
          value: { ...annotation, schema: 2 } as never,
        },
      ],
      invalid: [],
    });
    await expect(check!.run()).rejects.toThrow(/not really valid/);
  });

  it("fails an invalid sample the schema accepts", async () => {
    const [check] = schemaConformance(Annotation, {
      valid: [],
      invalid: [{ name: "actually fine", value: annotation }],
    });
    await expect(check!.run()).rejects.toThrow(/actually fine/);
  });

  it("names one check per sample", () => {
    const checks = schemaConformance(Annotation, {
      valid: [{ name: "v", value: annotation }],
      invalid: invalidAnnotations,
    });
    expect(checks).toHaveLength(1 + invalidAnnotations.length);
    expect(new Set(checks.map((c) => c.name)).size).toBe(checks.length);
  });
});
