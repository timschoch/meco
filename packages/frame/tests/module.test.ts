import { describe, expect, it } from "vitest";
import { describeModule } from "../index";

describe("@meco/frame", () => {
  it("reports its identity through the entry point", () => {
    expect(describeModule()).toEqual({ name: "frame", ready: false });
  });
});
