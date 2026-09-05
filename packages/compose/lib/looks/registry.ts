import type { Look } from "../../template";
import { swisshutless } from "./swisshutless";

/**
 * One Look per Brand, filled from static imports. A Brand with no entry cannot
 * be rendered for; compose refuses it rather than picking a default, because a
 * default Look would ship someone else's colours under this Brand's name.
 */
export const LOOKS: ReadonlyMap<string, Look> = new Map<string, Look>([
  [swisshutless.brand, swisshutless],
]);
