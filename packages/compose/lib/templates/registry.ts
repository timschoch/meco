import type { Template } from "../../template";
import { LOOKS } from "../looks/registry";
import swisshutlessStory from "./swisshutless-story";

/** The Templates that ship, in the order their modules are imported. */
const REGISTERED: readonly Template[] = [swisshutlessStory];

/**
 * Every Template compose knows, filled from static imports. One map, so a later
 * loader for a caller's own TSX registers here and touches nothing else (#65).
 *
 * A Template whose Brand has no Look is refused here, at module load, rather
 * than at the first `plan` that names it: the pair is code in this package, so
 * a mismatch is a build mistake and not something a caller can cause. The
 * message names the Template id, because that is what the author has to edit.
 */
export const TEMPLATES: ReadonlyMap<string, Template> = new Map<
  string,
  Template
>(
  REGISTERED.map((template) => {
    if (!LOOKS.has(template.brand)) {
      throw new Error(
        `Template "${template.id}" names Brand "${template.brand}", which has no Look.`
      );
    }
    return [template.id, template];
  })
);
