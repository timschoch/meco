import type { Template } from "../../template";
import { LOOKS } from "../looks/registry";
import { registerTemplates } from "./register";
import swisshutlessStory from "./swisshutless-story";

/**
 * Every Template compose knows, filled from static imports. One map, so a later
 * loader for a caller's own TSX registers here and touches nothing else (#65).
 *
 * `registerTemplates` is what refuses a Template whose Brand has no Look, so
 * the same rule holds for whatever that loader brings.
 */
export const TEMPLATES: ReadonlyMap<string, Template> = registerTemplates(
  [swisshutlessStory],
  LOOKS
);
