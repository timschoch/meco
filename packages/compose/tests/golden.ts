/**
 * Regenerates every golden image. Run it, look at what changed, commit it:
 *
 *     pnpm --filter @meco/compose golden
 *
 * Deliberately not a test. A suite that repairs its own expectations proves
 * nothing, so nothing under `*.test.ts` may write into `goldens/`.
 */
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { render } from "../index";
import { GOLDEN_CASES, inputFor } from "./cases";
import { GOLDENS } from "./goldens";

for (const test of GOLDEN_CASES) {
  const { bytes } = await render(await inputFor(test, { format: "png" }));
  const path = fileURLToPath(new URL(test.golden, GOLDENS));
  writeFileSync(path, bytes);
  console.log(`${test.golden}: ${bytes.length} bytes`);
}
