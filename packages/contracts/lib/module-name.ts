/** Every module of the meco rebuild, in the order `CLAUDE.md` lists them. */
export const MODULE_NAMES = [
  "contracts",
  "store",
  "records",
  "models",
  "identify",
  "frame",
  "redact",
  "compose",
  "gateway",
  "webui",
  "front",
] as const;

/** The name of one module. */
export type ModuleName = (typeof MODULE_NAMES)[number];
