import { describe, expect, it } from "vitest";
import { describeModule } from "../index";

describe("@meco/identify", () => {
  it("reports its identity through the entry point", () => {
    expect(describeModule()).toEqual({ name: "identify", ready: false });
  });
});
