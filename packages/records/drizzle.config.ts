/**
 * `drizzle-kit generate` only. The SQL it writes under `drizzle/` is the
 * reviewable artefact; `migrations.ts` then embeds it in
 * `migrations.generated.ts`, which is what actually runs. Both steps are
 * `pnpm --filter @meco/records migrations`.
 *
 * There is no `dbCredentials` here on purpose: records never applies a
 * migration from a developer's machine. The gateway applies them at boot,
 * under an advisory lock, from the image that needs them.
 */
import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "postgresql",
  schema: "./lib/schema.ts",
  out: "./drizzle",
});
