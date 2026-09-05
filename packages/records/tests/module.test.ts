import { describe, expect, it } from "vitest";
import { describeModule } from "../index";

describe("@meco/records", () => {
  it("reports its identity through the entry point", () => {
    expect(describeModule()).toEqual({ name: "records", ready: false });
  });
});
