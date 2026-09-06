/**
 * `/internal/*`: the routes nobody outside the platform calls.
 *
 * The Sweep runs when nobody is calling, which is exactly when it matters: a
 * container that scales to zero after five idle minutes has no timer of its
 * own, so a Vercel cron posts here instead (#88, Q8; #164 dropped the boot
 * timer for it). Vercel sends `Authorization: Bearer $CRON_SECRET` and nothing
 * else, so that header is the whole door — no Caller lookup runs here, and a
 * Caller's key opens nothing.
 *
 * With no secret configured these routes are never registered, so the path
 * answers `404 not_found` like any other unknown one. That is deliberate: a
 * deployment that forgot the variable must not have a route that a wrong guess
 * could tell apart from a right one.
 */
import { timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import type { Records } from "@meco/records";
import { GatewayError } from "./errors";

export interface InternalDeps {
  readonly records: Records;
  /** `CRON_SECRET`. The routes exist only because this is a non-empty string. */
  readonly cronSecret: string;
  /** The instant the Retention Window is measured from. */
  now(): Date;
}

/**
 * The whole `Authorization` header against the whole expected one, in constant
 * time. Comparing only the credential would leak the scheme, and comparing
 * with `startsWith` or `===` would answer a wrong key faster the sooner it
 * went wrong. Lengths that differ are not the same secret and cannot be fed to
 * `timingSafeEqual`, which throws on unequal buffers.
 */
function carriesSecret(header: string | null, cronSecret: string): boolean {
  if (header === null) return false;
  const sent = Buffer.from(header);
  const expected = Buffer.from(`Bearer ${cronSecret}`);
  return sent.length === expected.length && timingSafeEqual(sent, expected);
}

export function internalRoutes(deps: InternalDeps): Hono {
  const internal = new Hono();

  internal.use("/*", async (c, next) => {
    if (
      !carriesSecret(c.req.raw.headers.get("authorization"), deps.cronSecret)
    ) {
      throw new GatewayError("unauthorized", "this door is the cron's");
    }
    await next();
  });

  internal.post("/sweep", async (c) =>
    c.json(await deps.records.sweep(deps.now()))
  );

  return internal;
}
