import type { Look } from "../../template";
import { hopefamily } from "./hopefamily";
import { laica } from "./laica";
import { swisshutless } from "./swisshutless";

/**
 * One Look per Brand, filled from static imports. A Brand with no entry cannot
 * be rendered for; compose refuses it rather than picking a default, because a
 * default Look would ship someone else's colours under this Brand's name.
 */
export const LOOKS: ReadonlyMap<string, Look> = new Map<string, Look>([
  [laica.brand, laica],
  [swisshutless.brand, swisshutless],
  [hopefamily.brand, hopefamily],
]);
