/**
 * The Front: the light Function the public `/mcp` rewrite points at. It knows
 * no tool. Every JSON-RPC message goes to the gateway's MCP Door as it came
 * and every answer comes back as it was, so a tool added, renamed or reshaped
 * in the gateway reaches a client with no change here. One case is
 * intercepted, `lib/cold-start.ts`: a `tools/call` that arrives while the
 * container is scaled to zero is told so within a second.
 */
import { Hono } from "hono";
import {
  COLD_START,
  type ColdStart,
  coldStartStream,
  toolCall,
  waitUntilUp,
} from "./lib/cold-start";
import { relay, toUpstream } from "./lib/forward";

export type { ColdStart } from "./lib/cold-start";

export interface FrontDeps {
  /** The gateway's base URL: `GATEWAY_URL`, from the service binding. */
  readonly upstream: string;
  /** Reaches the gateway. The global `fetch` by default. */
  readonly fetch?: typeof fetch;
  /** The cold-start timings; `COLD_START` for whatever is not given. */
  readonly coldStart?: Partial<ColdStart>;
}

export function createFront(deps: FrontDeps): Hono {
  const { upstream, fetch = globalThis.fetch } = deps;
  const config: ColdStart = { ...COLD_START, ...deps.coldStart };

  /** Whether the gateway answers `/health` inside the probe timeout. */
  const up = async (): Promise<boolean> => {
    try {
      const response = await fetch(new URL("/health", upstream), {
        signal: AbortSignal.timeout(config.probeTimeoutMs),
      });
      void response.body?.cancel();
      return response.ok;
    } catch {
      return false;
    }
  };

  const app = new Hono();
  app.all("/mcp", async (c) => {
    const request = c.req.raw;
    const body = request.method === "POST" ? await request.text() : null;
    const forward = (): Promise<Response> =>
      fetch(toUpstream(request, upstream, body));
    const call = body === null ? null : toolCall(body);
    if (call === null || (await up())) return relay(await forward());
    return coldStartStream({
      call,
      config,
      wait: () => waitUntilUp(up, config),
      forward,
    });
  });
  return app;
}
