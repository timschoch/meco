import type { Template } from "../../template";
import swisshutlessStory from "./swisshutless-story";

/**
 * Every Template compose knows, filled from static imports. One map, so a later
 * loader for a caller's own TSX registers here and touches nothing else (#65).
 */
export const TEMPLATES: ReadonlyMap<string, Template> = new Map<
  string,
  Template
>([[swisshutlessStory.id, swisshutlessStory]]);
