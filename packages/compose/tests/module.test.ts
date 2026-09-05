import { describe, expect, it } from "vitest";
import { describeModule } from "../index";

describe("@meco/compose", () => {
  it("reports its identity through the entry point", () => {
    expect(describeModule()).toEqual({ name: "compose", ready: false });
  });
});
