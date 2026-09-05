import { z } from "zod";
import { describe, expect, it } from "vitest";
import { ANNOTATION_SCHEMA, Annotation } from "../index";
import { annotation } from "./samples";

// Every field rule is asserted once, through `schemaConformance` in
// schema-conformance.test.ts. What is left here is what a sample cannot say.
describe("Annotation", () => {
  it("names schema 1", () => {
    expect(ANNOTATION_SCHEMA).toBe(1);
    expect(annotation.schema).toBe(ANNOTATION_SCHEMA);
  });

  it("survives a JSON round trip", () => {
    expect(Annotation.parse(JSON.parse(JSON.stringify(annotation)))).toEqual(
      annotation
    );
  });

  it("converts to a JSON Schema the gateway can register with the MCP server", () => {
    expect(() => z.toJSONSchema(Annotation)).not.toThrow();
  });
});
