import { z } from "zod";
import { describe, expect, it } from "vitest";
import { ANNOTATION_SCHEMA, Annotation } from "../index";
import { annotation } from "./samples";

describe("Annotation", () => {
  it("parses an annotation with a face and a vehicle region", () => {
    expect(Annotation.parse(annotation)).toEqual(annotation);
  });

  it("names schema 1", () => {
    expect(ANNOTATION_SCHEMA).toBe(1);
    expect(Annotation.safeParse({ ...annotation, schema: 2 }).success).toBe(
      false
    );
  });

  it("refuses a hash that is not 64 hex chars", () => {
    expect(
      Annotation.safeParse({ ...annotation, hash: "a".repeat(63) }).success
    ).toBe(false);
  });

  it("refuses a duplicate in producedBy", () => {
    const twice = [...annotation.producedBy, annotation.producedBy[0]!];
    expect(
      Annotation.safeParse({ ...annotation, producedBy: twice }).success
    ).toBe(false);
  });

  it("refuses a mime outside the closed set", () => {
    expect(
      Annotation.safeParse({ ...annotation, mime: "image/gif" }).success
    ).toBe(false);
  });

  it("survives a JSON round trip", () => {
    expect(Annotation.parse(JSON.parse(JSON.stringify(annotation)))).toEqual(
      annotation
    );
  });

  it("converts to a JSON Schema the gateway can register", () => {
    expect(() => z.toJSONSchema(Annotation)).not.toThrow();
  });
});
