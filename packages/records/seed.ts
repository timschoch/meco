// Entry point: the Seed, and the script that runs it against a real database.
//
// Run it with `pnpm records:seed`, from a checkout that has the connection
// string and the bootstrap key in its environment — `vercel env pull .env.local`
// puts both there. It is idempotent: the Brands are upserted and the bootstrap
// Caller is created only when its key belongs to no Caller yet.
//
// The report it prints holds Brand ids, the Caller's name and the Brands it
// holds. `MECO_BOOTSTRAP_KEY` is never printed, and neither is its hash.
import { fileURLToPath } from "node:url";
import { memoryStore } from "@meco/store";
import { neonDatabase } from "./lib/neon-database";
import { records } from "./lib/records";
import {
  BOOTSTRAP_BRANDS,
  BOOTSTRAP_CALLER_NAME,
  type SeedBrand,
  type SeedOptions,
  type SeedReport,
  seedRecords,
} from "./lib/seed";

export {
  BOOTSTRAP_BRANDS,
  BOOTSTRAP_CALLER_NAME,
  type SeedBrand,
  type SeedOptions,
  type SeedReport,
  seedRecords,
};

/** The direct connection string, the same one the gateway migrates with. */
const CONNECTION_STRING_VAR = "RECORDS_DATABASE_URL_UNPOOLED";

/** The first Caller's bearer key. Owner-set; the seed is its only reader. */
const BOOTSTRAP_KEY_VAR = "MECO_BOOTSTRAP_KEY";

function required(name: string, env: NodeJS.ProcessEnv): string {
  const value = env[name];
  if (value === undefined || value === "") {
    throw new Error(
      `@meco/records: ${name} is not set. Run \`vercel env pull .env.local\` first.`
    );
  }
  return value;
}

/** The host a connection string names, with nothing that authenticates. */
function hostOf(connectionString: string): string {
  return /@([^/?:]+)/.exec(connectionString)?.[1] ?? "an unreadable host";
}

async function main(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  // The key first: a run with no key must refuse before it opens a pool, so
  // the refusal is the same one whether or not a database is reachable.
  const bootstrapKey = required(BOOTSTRAP_KEY_VAR, env);
  const connectionString = required(CONNECTION_STRING_VAR, env);

  // The host, never the credential: a reading with no provenance is a trap,
  // and this one is the difference between eu-central-1 and a dead project.
  console.log(`connecting to ${hostOf(connectionString)}`);

  const opened = records({
    database: neonDatabase(connectionString),
    // The Seed writes rows and no bytes. A `Store` is what `records()` takes
    // because deletion goes through one, and an in-memory one is the honest
    // way to say this run will never reach a store at all.
    store: memoryStore(),
  });

  try {
    // The schema first: a seed against a database the gateway has not booted
    // against yet would fail on a table that does not exist.
    const { applied } = await opened.migrate();
    const report = await seedRecords(opened, { bootstrapKey });

    console.log(`migrations applied: ${applied}`);
    console.log(`brands: ${report.brands.join(", ")}`);
    console.log(
      `caller: ${report.caller.name} (${report.caller.created ? "created" : "already existed"}), holds ${report.caller.brands.join(", ")}`
    );
  } finally {
    await opened.close();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main();
}
