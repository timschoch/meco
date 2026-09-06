/**
 * The HTTP Door: one route per Operation, under `/v1`. A `GET` or `DELETE`
 * reads its input from the query and the path, a `POST` from the JSON body and
 * the path; every answer is JSON, and every refusal is `toWire`'s body.
 */
import { Hono } from "hono";
import type { Caller } from "@meco/records";
import { GatewayError } from "./errors";
import { type Operation, type OperationContext, run } from "./operations";

/** What the Caller middleware leaves on the context for every route behind it. */
export type CallerEnv = { Variables: { caller: Caller } };

export function httpDoor(
  operations: readonly Operation[],
  deps: Pick<OperationContext, "records" | "store" | "models">
): Hono<CallerEnv> {
  const door = new Hono<CallerEnv>();

  for (const operation of operations) {
    door.on(operation.method, operation.path, async (c) => {
      const raw =
        operation.method === "POST"
          ? { ...(await jsonBody(c.req.raw)), ...c.req.param() }
          : { ...c.req.query(), ...c.req.param() };
      const result = await run(operation, deps, c.get("caller"), raw);
      return c.json(result);
    });
  }

  return door;
}

/** The body as an object, or `invalid_request`: a Door never throws a SyntaxError. */
async function jsonBody(request: Request): Promise<Record<string, unknown>> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    throw new GatewayError("invalid_request", "the body is not JSON");
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new GatewayError("invalid_request", "the body is not a JSON object");
  }
  return body as Record<string, unknown>;
}
