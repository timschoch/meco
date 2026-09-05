import type { ModuleName } from "@meco/contracts";

const NAME = "compose" satisfies ModuleName;

/**
 * Placeholder. The module agent that owns `@meco/compose` replaces this with the
 * real interface; the entry point stays the only way in.
 */
export function describeModule(): {
  readonly name: ModuleName;
  readonly ready: boolean;
} {
  return { name: NAME, ready: false };
}
