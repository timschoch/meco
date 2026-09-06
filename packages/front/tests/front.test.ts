// The front over a fake gateway: a Hono app behind an injected `fetch`, so no
// test opens a socket. It answers `/mcp` the way the stateless SDK handler
// does — one SSE frame carrying the result, or JSON when asked — refuses a
// request with no key as the gateway's `401`, and echoes `Mcp-Session-Id`.
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { createFront } from "../index";

const UPSTREAM = "http://gateway.internal";
const KEY = "sk_test_the_key";

/** The fake gateway; `up` says what `/health` answers right now. */
function gateway(
  options: { up?: () => boolean; answer?: "sse" | "json" } = {}
) {
  const hits: string[] = [];
  const requests: Request[] = [];
  const app = new Hono();
  app.use(async (c, next) => {
    hits.push(`${c.req.method} ${c.req.path}`);
    await next();
  });
  app.get("/health", (c) =>
    (options.up?.() ?? true) ? c.json({ ok: true }) : c.body(null, 503)
  );
  app.all("/mcp", async (c) => {
    requests.push(c.req.raw.clone());
    if (c.req.method !== "POST") return c.body(null, 405);
    if (!c.req.header("authorization") && !c.req.header("x-auth-token")) {
      return c.json({ error: { code: "unauthorized" } }, 401);
    }
    const message = JSON.parse(await c.req.text()) as {
      id: unknown;
      method: string;
    };
    const result = {
      jsonrpc: "2.0",
      id: message.id,
      result: { echo: message.method },
    };
    const session = c.req.header("mcp-session-id");
    const headers: Record<string, string> =
      session === undefined ? {} : { "mcp-session-id": session };
    if (options.answer === "json") return c.json(result, 200, headers);
    return c.body(`event: message\ndata: ${JSON.stringify(result)}\n\n`, 200, {
      ...headers,
      "content-type": "text/event-stream",
    });
  });
  const fetch: typeof globalThis.fetch = (input, init) =>
    Promise.resolve(app.fetch(new Request(input, init)));
  return { hits, requests, fetch };
}

const message = (
  method: string,
  params: unknown = {}
): { jsonrpc: string; id: number; method: string; params: unknown } => ({
  jsonrpc: "2.0",
  id: 7,
  method,
  params,
});

function post(
  front: Hono,
  body: unknown,
  headers: Record<string, string> = { authorization: `Bearer ${KEY}` }
): Promise<Response> {
  return Promise.resolve(
    front.request("http://front/mcp", {
      method: "POST",
      headers: {
        ...headers,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify(body),
    })
  );
}

/** The SSE frames of a response, one parsed `data:` message per frame. */
async function* frames(response: Response): AsyncGenerator<unknown> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let end = buffer.indexOf("\n\n");
    while (end !== -1) {
      const data = buffer
        .slice(0, end)
        .split("\n")
        .find((line) => line.startsWith("data:"))
        ?.slice(5)
        .trim();
      buffer = buffer.slice(end + 2);
      if (data !== undefined) yield JSON.parse(data);
      end = buffer.indexOf("\n\n");
    }
  }
}

/** A `tools/call`, with timings a test can wait through. */
const COLD = { seconds: 9, probeTimeoutMs: 50, pollMs: 5, capMs: 500 };

describe("@meco/front", () => {
  it("forwards a message verbatim and relays the answer as it came", async () => {
    const upstream = gateway();
    const front = createFront({ upstream: UPSTREAM, fetch: upstream.fetch });
    const body = message("tools/list");

    const res = await post(front, body);

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    expect(await res.text()).toBe(
      `event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: 7, result: { echo: "tools/list" } })}\n\n`
    );
    // No probe on anything but a tools/call: one hop, nothing else.
    expect(upstream.hits).toEqual(["POST /mcp"]);
    const seen = upstream.requests[0]!;
    expect(new URL(seen.url).href).toBe(`${UPSTREAM}/mcp`);
    expect(seen.headers.get("authorization")).toBe(`Bearer ${KEY}`);
    expect(seen.headers.get("accept")).toBe(
      "application/json, text/event-stream"
    );
    expect(await seen.text()).toBe(JSON.stringify(body));
  });

  it("carries x-auth-token too, and a request with no key is the gateway's 401", async () => {
    const upstream = gateway();
    const front = createFront({ upstream: UPSTREAM, fetch: upstream.fetch });

    const token = await post(front, message("initialize"), {
      "x-auth-token": KEY,
    });
    expect(token.status).toBe(200);
    expect(upstream.requests[0]!.headers.get("x-auth-token")).toBe(KEY);

    const none = await post(front, message("initialize"), {});
    expect(none.status).toBe(401);
    expect(await none.json()).toEqual({ error: { code: "unauthorized" } });
  });

  it("carries Mcp-Session-Id both ways", async () => {
    const upstream = gateway();
    const front = createFront({ upstream: UPSTREAM, fetch: upstream.fetch });

    const res = await post(front, message("tools/list"), {
      authorization: `Bearer ${KEY}`,
      "mcp-session-id": "session-42",
    });

    expect(upstream.requests[0]!.headers.get("mcp-session-id")).toBe(
      "session-42"
    );
    expect(res.headers.get("mcp-session-id")).toBe("session-42");
  });

  it("forwards GET and DELETE untouched, so the gateway's 405 is the answer", async () => {
    const upstream = gateway();
    const front = createFront({ upstream: UPSTREAM, fetch: upstream.fetch });

    for (const method of ["GET", "DELETE"]) {
      const res = await front.request("http://front/mcp", {
        method,
        headers: { authorization: `Bearer ${KEY}` },
      });
      expect(res.status).toBe(405);
    }
    expect(upstream.hits).toEqual(["GET /mcp", "DELETE /mcp"]);
  });

  it("probes once before a warm tools/call and adds nothing to the answer", async () => {
    const upstream = gateway();
    const front = createFront({ upstream: UPSTREAM, fetch: upstream.fetch });

    const res = await post(
      front,
      message("tools/call", { name: "list_brands" })
    );

    expect(upstream.hits).toEqual(["GET /health", "POST /mcp"]);
    expect(res.status).toBe(200);
    const received = [];
    for await (const frame of frames(res)) received.push(frame);
    expect(received).toEqual([
      { jsonrpc: "2.0", id: 7, result: { echo: "tools/call" } },
    ]);
  });

  it("answers a cold tools/call before the gateway is up, then confirms, then relays", async () => {
    let up = false;
    const upstream = gateway({ up: () => up });
    const front = createFront({
      upstream: UPSTREAM,
      fetch: upstream.fetch,
      coldStart: COLD,
    });

    const res = await post(
      front,
      message("tools/call", { name: "render_image" })
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/event-stream");

    const stream = frames(res);
    expect((await stream.next()).value).toEqual({
      jsonrpc: "2.0",
      method: "notifications/message",
      params: {
        level: "info",
        logger: "meco",
        data: "meco is starting, about 9 seconds",
      },
    });
    // The first notice went out while the gateway was still down: nothing
    // has been forwarded yet.
    expect(upstream.hits).not.toContain("POST /mcp");

    up = true;
    const rest = [];
    for await (const frame of stream) rest.push(frame);
    expect(rest).toEqual([
      {
        jsonrpc: "2.0",
        method: "notifications/message",
        params: {
          level: "info",
          logger: "meco",
          data: "meco is up, your request is now being processed",
        },
      },
      { jsonrpc: "2.0", id: 7, result: { echo: "tools/call" } },
    ]);
    expect(upstream.hits.at(-1)).toBe("POST /mcp");
    expect(upstream.requests[0]!.headers.get("authorization")).toBe(
      `Bearer ${KEY}`
    );
  });

  it("says the same as progress when the call carries a progressToken", async () => {
    const upstream = gateway({ up: () => true });
    let probes = 0;
    const fetch: typeof globalThis.fetch = (input, init) => {
      // Cold for the first probe only.
      if (
        new URL(input instanceof Request ? input.url : input).pathname ===
          "/health" &&
        probes++ === 0
      ) {
        return Promise.resolve(new Response(null, { status: 503 }));
      }
      return upstream.fetch(input, init);
    };
    const front = createFront({ upstream: UPSTREAM, fetch, coldStart: COLD });

    const res = await post(
      front,
      message("tools/call", {
        name: "crop_image",
        _meta: { progressToken: "p1" },
      })
    );
    const received = [];
    for await (const frame of frames(res)) received.push(frame);

    expect(received.map((f) => (f as { method?: string }).method)).toEqual([
      "notifications/message",
      "notifications/progress",
      "notifications/message",
      "notifications/progress",
      undefined,
    ]);
    expect(received[1]).toEqual({
      jsonrpc: "2.0",
      method: "notifications/progress",
      params: {
        progressToken: "p1",
        progress: 0,
        message: "meco is starting, about 9 seconds",
      },
    });
  });

  it("wraps a JSON answer as the stream's final frame on the cold path", async () => {
    let up = false;
    const upstream = gateway({ up: () => up, answer: "json" });
    const front = createFront({
      upstream: UPSTREAM,
      fetch: upstream.fetch,
      coldStart: COLD,
    });

    const res = await post(
      front,
      message("tools/call", { name: "list_brands" })
    );
    const stream = frames(res);
    await stream.next();
    up = true;
    const rest = [];
    for await (const frame of stream) rest.push(frame);

    expect(rest.at(-1)).toEqual({
      jsonrpc: "2.0",
      id: 7,
      result: { echo: "tools/call" },
    });
  });

  it("answers a JSON-RPC error with the call's id when the gateway never comes up", async () => {
    const upstream = gateway({ up: () => false });
    const front = createFront({
      upstream: UPSTREAM,
      fetch: upstream.fetch,
      coldStart: COLD,
    });

    const started = Date.now();
    const res = await post(
      front,
      message("tools/call", { name: "list_brands" })
    );
    const received = [];
    for await (const frame of frames(res)) received.push(frame);

    expect(Date.now() - started).toBeLessThan(COLD.capMs + 500);
    expect(received.at(-1)).toEqual({
      jsonrpc: "2.0",
      id: 7,
      error: {
        code: -32000,
        message: "meco did not start within 0.5 s; send the call again",
      },
    });
    expect(upstream.hits).not.toContain("POST /mcp");
  });

  it("turns a refusal on the cold path into a JSON-RPC error, the status line being sent", async () => {
    let up = false;
    const upstream = gateway({ up: () => up });
    const front = createFront({
      upstream: UPSTREAM,
      fetch: upstream.fetch,
      coldStart: COLD,
    });

    const res = await post(
      front,
      message("tools/call", { name: "list_brands" }),
      {}
    );
    const stream = frames(res);
    await stream.next();
    up = true;
    const rest = [];
    for await (const frame of stream) rest.push(frame);

    expect(rest.at(-1)).toEqual({
      jsonrpc: "2.0",
      id: 7,
      error: {
        code: -32000,
        message: "meco answered 401",
        data: JSON.stringify({ error: { code: "unauthorized" } }),
      },
    });
  });
});
