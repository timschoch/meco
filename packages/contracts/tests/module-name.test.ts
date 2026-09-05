import { describe, expect, it } from "vitest";
import { MODULE_NAMES } from "../index";

describe("@meco/contracts", () => {
  it("names every module exactly once", () => {
    expect(new Set(MODULE_NAMES).size).toBe(MODULE_NAMES.length);
  });
});
