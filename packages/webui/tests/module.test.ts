import { describe, expect, it } from "vitest";
import { describeModule } from "../index";

describe("@meco/webui", () => {
  it("reports its identity through the entry point", () => {
    expect(describeModule()).toEqual({ name: "webui", ready: false });
  });
});
