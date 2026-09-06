import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020";
import { describe, expect, it } from "vitest";
import { COMPOSE_ERROR_CODES, plan, PLACEMENTS, templates } from "../index";
import { PLACEMENTS as FROM_OWN_ENTRY } from "../placements";

/**
 * The one Template that ships. Read once, so a missing row fails here with the
 * whole catalogue in the message rather than as an undefined further down.
 */
const listed = templates();
const story = listed.find((t) => t.id === "swisshutless-story");

/** Draft 2020-12, the target `z.toJSONSchema` emits. */
const ajv = new Ajv2020({ strict: false });

describe("templates", () => {
  it("lists swisshutless-story with what a caller needs to fill it", () => {
    expect(listed.map((t) => t.id)).toEqual(["swisshutless-story"]);
    expect(story).toMatchObject({
      id: "swisshutless-story",
      brand: "swisshutless",
      placements: ["instagram/story", "facebook/story"],
    });
    expect(story?.description).toContain("Swiss Hutless");
  });

  it("gives the Fields as a JSON Schema the example validates against", () => {
    const validate = ajv.compile(story!.fields);

    // Printed, because a schema that does not describe its own example is the
    // one failure a caller cannot work around.
    if (!validate(story!.example)) console.log(validate.errors);
    expect(validate(story!.example)).toBe(true);

    // The schema is not vacuous: the headline is required, so Fields that
    // `plan` refuses are refused here too.
    expect(validate({ kicker: "only a kicker" })).toBe(false);
  });

  it("lists nothing for a Brand with no Template yet", () => {
    expect(templates("laica")).toEqual([]);
  });

  it("lists a Brand's own Templates when asked for one", () => {
    expect(templates("swisshutless")).toEqual(listed);
  });

  it("registers no Template for a Brand that has no Look", async () => {
    // The registry refuses such a Template at module load, which no test can
    // observe from out here. What it can observe is the consequence: every
    // listed Template plans for its own Brand instead of `unknown_brand`.
    for (const template of listed) {
      await expect(
        plan({
          template: template.id,
          placement: template.placements[0]!,
          brand: template.brand,
          fields: template.example,
        })
      ).resolves.toBeDefined();
    }
  });
});

describe("COMPOSE_ERROR_CODES", () => {
  it("is the five ways compose refuses, and nothing else", () => {
    // Closed, so a caller can branch on the code exhaustively. Each of the five
    // has its own refusal test: `tests/plan.test.ts` for the four a Plan can
    // hit, `tests/render.test.ts` for those four again plus `framing_mismatch`,
    // which needs a window and so cannot arise in a Plan.
    expect(COMPOSE_ERROR_CODES).toEqual([
      "unknown_template",
      "unknown_brand",
      "placement_not_supported",
      "invalid_fields",
      "framing_mismatch",
    ]);
  });
});

describe("PLACEMENTS", () => {
  it("is the seven Channel sizes, and nothing else", () => {
    expect(PLACEMENTS).toEqual([
      { id: "linkedin/post", width: 1200, height: 1200 },
      { id: "linkedin/wide", width: 1200, height: 627 },
      { id: "instagram/post", width: 1080, height: 1350 },
      { id: "instagram/story", width: 1080, height: 1920 },
      { id: "x/post", width: 1600, height: 900 },
      { id: "facebook/post", width: 1200, height: 630 },
      { id: "facebook/story", width: 1080, height: 1920 },
    ]);
  });

  it("is the same catalogue from `index.ts` and from `placements.ts`", () => {
    expect(FROM_OWN_ENTRY).toBe(PLACEMENTS);
  });

  it("is reachable as its own entry point, so the gateway skips the renderer", () => {
    const manifest = JSON.parse(
      readFileSync(
        fileURLToPath(new URL("../package.json", import.meta.url)),
        "utf8"
      )
    ) as { exports: Record<string, string> };

    expect(manifest.exports["./placements"]).toBe("./placements.ts");
  });
});
