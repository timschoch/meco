import { Hono } from "hono";

/**
 * A temporary door to `models` for the measurements that need a request to
 * reach it from outside: `POST /probe/annotate` forwards the body and the
 * query to `MODELS_URL/annotate` and hands back its status, body and
 * `Server-Timing`; `GET /probe/models/health` forwards `/health`.
 *
 * Registered by `createApp` only when `GATEWAY_PROBE=1`, which is set on the
 * Preview environment and never on Production. Removed when the gateway's own
 * `/annotate` lands: ledgered on #118 and on the gateway parent #88.
 */
export function probeRoutes(
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl: typeof fetch = fetch
): Hono {
  const probe = new Hono();

  const forward = async (
    path: string,
    init: RequestInit & { duplex?: "half" }
  ): Promise<Response> => {
    const base = env["MODELS_URL"];
    if (base === undefined || base === "") {
      return Response.json(
        { error: { code: "unbound", message: "MODELS_URL is not set" } },
        { status: 503 }
      );
    }
    const upstream = await fetchImpl(new URL(path, base), init);
    const headers = new Headers({
      "content-type": upstream.headers.get("content-type") ?? "text/plain",
    });
    const timing = upstream.headers.get("server-timing");
    if (timing !== null) headers.set("server-timing", timing);
    return new Response(upstream.body, { status: upstream.status, headers });
  };

  // `?pad=<bytes>` grows the body to that many bytes with trailing zeros
  // before it crosses the binding. The platform refuses a public request
  // above 4.5 MB before the gateway sees it, so the only way to measure what
  // the binding carries is to make the body large on this side of it. A JPEG
  // decoder stops at the end-of-image marker, so the padded photograph still
  // decodes; only its hash changes.
  probe.post("/probe/annotate", async (c) => {
    const url = new URL(c.req.url);
    const pad = Number(url.searchParams.get("pad") ?? 0);
    url.searchParams.delete("pad");
    let body: RequestInit["body"] = c.req.raw.body;
    if (pad > 0) {
      const received = new Uint8Array(await c.req.arrayBuffer());
      const padded = new Uint8Array(Math.max(pad, received.byteLength));
      padded.set(received);
      body = padded;
    }
    return forward(`/annotate${url.search}`, {
      method: "POST",
      body,
      duplex: "half",
      signal: AbortSignal.timeout(60_000),
    });
  });

  probe.get("/probe/models/health", () =>
    forward("/health", { signal: AbortSignal.timeout(30_000) })
  );

  return probe;
}
