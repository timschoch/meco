import Ajv2020 from "ajv/dist/2020";
import { describe, expect, it } from "vitest";
import { templates } from "../index";
import { registerTemplates } from "../template";

const listed = templates();

/**
 * The one Template that ships. Thrown for by name rather than indexed, so a
 * catalogue that lost it fails here with what it does hold in the message.
 */
const story = listed.find((t) => t.id === "swisshutless-story");
if (!story) {
  throw new Error(
    `swisshutless-story is not in the catalogue; it holds: ${listed
      .map((t) => t.id)
      .join(", ")}`
  );
}

/** Draft 2020-12, the target `z.toJSONSchema` emits. */
const ajv = new Ajv2020({ strict: false });

describe("templates", () => {
  it("lists swisshutless-story with what a caller needs to fill it", () => {
    expect(listed.map((t) => t.id)).toEqual(["swisshutless-story"]);
    expect(story).toMatchObject({
      brand: "swisshutless",
      placements: ["instagram/story", "facebook/story"],
    });
    expect(story.description).toContain("Swiss Hutless");
  });

  it("gives the Fields as a JSON Schema the example validates against", () => {
    const validate = ajv.compile(story.fields);

    expect(validate(story.example), ajv.errorsText(validate.errors)).toBe(true);

    // The schema is not vacuous: `headline` is required, so the Fields `plan`
    // refuses with `invalid_fields` are refused here too.
    expect(validate({ kicker: "only a kicker" })).toBe(false);
  });

  it("lists nothing for a Brand with no Template yet", () => {
    expect(templates("laica")).toEqual([]);
  });

  it("lists a Brand's own Templates when asked for one", () => {
    expect(templates("swisshutless")).toEqual(listed);
  });
});

describe("registerTemplates", () => {
  const templateFor = (brand: string) => ({ id: `${brand}-story`, brand });

  it("refuses a Template whose Brand has no Look, naming the Template", () => {
    const looks = new Map([["swisshutless", {}]]);

    expect(() => registerTemplates([templateFor("laica")], looks)).toThrowError(
      /laica-story/
    );
  });

  it("registers a Template whose Brand has a Look", () => {
    const looks = new Map([["swisshutless", {}]]);
    const template = templateFor("swisshutless");

    expect(registerTemplates([template], looks).get(template.id)).toBe(
      template
    );
  });
});
