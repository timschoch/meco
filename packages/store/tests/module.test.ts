import { describe, expect, it } from "vitest";
import { describeModule } from "../index";

describe("@meco/store", () => {
  it("reports its identity through the entry point", () => {
    expect(describeModule()).toEqual({ name: "store", ready: false });
  });
});
