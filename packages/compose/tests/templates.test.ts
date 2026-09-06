import Ajv2020 from "ajv/dist/2020";
import { describe, expect, it } from "vitest";
import { templates } from "../index";
import { registerTemplates } from "../template";
import { SHIPPED } from "./cases";

const listed = templates();

const TEMPLATE_IDS = SHIPPED.map((t) => t.id);

/**
 * A Template by id. Thrown for by name rather than indexed, so a catalogue that
 * lost one fails here with what it does hold in the message.
 */
function shipped(id: string) {
  const found = listed.find((t) => t.id === id);
  if (!found) {
    throw new Error(
      `${id} is not in the catalogue; it holds: ${listed
        .map((t) => t.id)
        .join(", ")}`
    );
  }
  return found;
}

const story = shipped("swisshutless-story");
const post = shipped("laica-post");

/** Draft 2020-12, the target `z.toJSONSchema` emits. */
const ajv = new Ajv2020({ strict: false });

describe("templates", () => {
  it("lists every Template that ships, with what a caller needs to fill it", () => {
    // Sorted by id, which is the catalogue's own promise and not the order the
    // registry's static imports happen to sit in.
    expect(listed.map((t) => t.id)).toEqual([
      "hopefamily-post",
      "hopefamily-story",
      "laica-post",
      "swisshutless-story",
    ]);
    expect(story).toMatchObject({
      brand: "swisshutless",
      placements: ["instagram/story", "facebook/story"],
    });
    expect(story.description).toContain("Swiss Hutless");
  });

  it("lists laica-post with both the Placements it draws for", () => {
    expect(post).toMatchObject({
      brand: "laica",
      placements: ["linkedin/post", "linkedin/wide"],
    });
    expect(post.description).toContain("laica");
  });

  it.each(TEMPLATE_IDS)(
    "gives %s's Fields as a JSON Schema its example validates against",
    (id) => {
      const template = listed.find((t) => t.id === id)!;
      const validate = ajv.compile(template.fields);

      expect(validate(template.example), ajv.errorsText(validate.errors)).toBe(
        true
      );
    }
  );

  it("gives a schema that is not vacuous", () => {
    // `headline` is required, so the Fields `plan` refuses with
    // `invalid_fields` are refused here too.
    expect(ajv.compile(story.fields)({ kicker: "only a kicker" })).toBe(false);
    // Same for laica's `title`, whose Template carries a default for every
    // other Field and so would otherwise accept an empty object.
    expect(ajv.compile(post.fields)({ kicker: "only a kicker" })).toBe(false);
  });

  it("lists both Hope Family Templates when asked for that Brand", () => {
    expect(templates("hopefamily")).toMatchObject([
      {
        id: "hopefamily-post",
        brand: "hopefamily",
        placements: ["instagram/post", "facebook/post"],
      },
      {
        id: "hopefamily-story",
        brand: "hopefamily",
        placements: ["instagram/story", "facebook/story"],
      },
    ]);
  });

  it("lists nothing for a Brand with no Template", () => {
    expect(templates("no-such-brand")).toEqual([]);
  });

  it("lists a Brand's own Templates when asked for one", () => {
    expect(templates("swisshutless")).toEqual([story]);
    expect(templates("laica")).toEqual([post]);
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
