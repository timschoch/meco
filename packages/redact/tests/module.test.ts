import { describe, expect, it } from "vitest";
import { describeModule } from "../index";

describe("@meco/redact", () => {
  it("reports its identity through the entry point", () => {
    expect(describeModule()).toEqual({ name: "redact", ready: false });
  });
});
