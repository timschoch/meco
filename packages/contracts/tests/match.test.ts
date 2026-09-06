import { z } from "zod";
import { describe, it, expect } from "vitest";
import { Match } from "../index";
import { schemaConformance } from "../conformance";
import { invalidMatches, match, numberMatch } from "./samples";

describe("schemaConformance over the Match", () => {
  const checks = schemaConformance(Match, {
    valid: [
      { name: "a named face on one brand", value: match },
      { name: "a kart named by its race number", value: numberMatch },
    ],
    invalid: invalidMatches,
  });

  for (const check of checks) it(check.name, check.run);
});

describe("Match", () => {
  it("converts to a JSON Schema the gateway can register", () => {
    expect(() => z.toJSONSchema(Match)).not.toThrow();
  });
});
