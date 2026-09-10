/**
 * meco's wiring of `@timschoch/vercel-mcp-cold-start`, and nothing else.
 *
 * How the proxy behaves — verbatim forwarding, the notices, the error paths —
 * is the package's own test suite, in its own repository. What cannot be
 * tested there is what only meco knows: that the Function refuses to start
 * without `GATEWAY_URL`, that it addresses the MCP Door and not the
 * container's root, and that a slow caller hears the name `meco` rather than
 * the package's "the server".
 *
 * `createFront` reads `globalThis.fetch` when it is built, so the stub goes in
 * before `../server` is imported, and the module registry is reset between
 * cases because that import runs once.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const GATEWAY = "http://gateway.internal";

/** The one JSON-RPC message the front treats specially. */
const TOOLS_CALL = JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  method: "tools/call",
  params: { name: "list_brands", arguments: {} },
});

const callTo = (front: (request: Request) => Promise<Response>) =>
  front(
    new Request("https://meco.test/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: "Bearer sk_test_the_key",
      },
      body: TOOLS_CALL,
    })
  );

/** Every `data:` payload on an SSE body, in order. */
async function frames(response: Response): Promise<unknown[]> {
  const text = await response.text();
  return text
    .split("\n\n")
    .flatMap((frame) => frame.split("\n"))
    .filter((line) => line.startsWith("data: "))
    .map((line) => JSON.parse(line.slice(6)) as unknown);
}

/**
 * A fake gateway behind the global `fetch`. `heldMs` is how long it holds a
 * request, the way the platform holds one to a container that is starting.
 */
function gateway(heldMs: number) {
  const seen: string[] = [];
  const fetch = vi.fn(async (input: unknown) => {
    const request =
      input instanceof Request ? input : new Request(String(input));
    seen.push(`${request.method} ${request.url}`);
    await new Promise((resolve) => setTimeout(resolve, heldMs));
    if (request.method === "GET") return new Response("", { status: 401 });
    return new Response(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        result: { content: [{ type: "text", text: '{"items":[]}' }] },
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  });
  return { fetch, seen };
}

/** What `../server` exports, as Vercel's Node runtime reads it. */
type Server = {
  readonly GET?: unknown;
  readonly POST?: (request: Request) => Promise<Response>;
  readonly DELETE?: unknown;
  readonly default?: unknown;
};

/** `../server` afresh, with the stub already in place. */
async function serverExports(): Promise<Server> {
  vi.resetModules();
  return (await import("../server")) as Server;
}

/** The handler the calls below go through: the `POST` Vercel would pick. */
async function load(): Promise<(request: Request) => Promise<Response>> {
  const { POST } = await serverExports();
  if (POST === undefined) throw new Error("../server exports no POST");
  return POST;
}

describe("@meco/front", () => {
  beforeEach(() => {
    vi.stubEnv("GATEWAY_URL", GATEWAY);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("refuses to start when GATEWAY_URL is unset, naming the variable", async () => {
    vi.stubEnv("GATEWAY_URL", "");
    await expect(load()).rejects.toThrow(/GATEWAY_URL is unset/);
  });

  it("offers the three MCP verbs and no default function", async () => {
    // A default *function* is Vercel's `(req, res)` handler: it is handed
    // Node's `IncomingMessage`, whose `url` is the path alone, and the front
    // reads `request.url`, so `new URL("/mcp")` throws and every request is a
    // `500`. Measured on the preview for #252 before this line existed. Only
    // the method names, or a default object with `fetch`, get a web `Request`.
    vi.stubGlobal("fetch", gateway(0).fetch);
    const server = await serverExports();

    expect(typeof server.GET).toBe("function");
    expect(typeof server.POST).toBe("function");
    expect(typeof server.DELETE).toBe("function");
    expect(typeof server.default).not.toBe("function");
  });

  it("addresses the MCP Door on the container, not its root", async () => {
    const upstream = gateway(0);
    vi.stubGlobal("fetch", upstream.fetch);

    const front = await load();
    await callTo(front);

    expect(upstream.seen).toContain(`POST ${GATEWAY}/mcp`);
    expect(upstream.seen.every((hit) => hit.endsWith("/mcp"))).toBe(true);
  });

  it("calls itself meco in the notices, not the package's 'the server'", async () => {
    // Held past the package's 500 ms first notice, so the stream opens.
    const upstream = gateway(700);
    vi.stubGlobal("fetch", upstream.fetch);

    const front = await load();
    const response = await callTo(front);

    expect(response.headers.get("content-type")).toContain("text/event-stream");

    const notices = (await frames(response)).filter(
      (frame): frame is { params: { data: string } } =>
        (frame as { method?: string }).method === "notifications/message"
    );
    expect(notices).toHaveLength(1);
    expect(notices[0]?.params.data).toBe("meco is processing your request");
  });

  it("adds nothing to a warm answer", async () => {
    const upstream = gateway(0);
    vi.stubGlobal("fetch", upstream.fetch);

    const front = await load();
    const response = await callTo(front);

    expect(response.headers.get("content-type")).toContain("application/json");
    const body = (await response.json()) as { result: { content: unknown[] } };
    expect(body.result.content).toHaveLength(1);
  });
});
