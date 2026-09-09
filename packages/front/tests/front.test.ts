/**
 * meco's wiring of `@timschoch/vercel-mcp-cold-start`, and nothing else.
 *
 * How the proxy behaves — verbatim forwarding, the probe, the notices, the
 * error paths — is the package's own test suite, in its own repository. What
 * cannot be tested there is what only meco knows: that the Function refuses to
 * start without `GATEWAY_URL`, that it addresses the MCP Door and not the
 * container's root, and that a cold caller is told meco's measured boot time
 * rather than the package's unmeasured ceiling.
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

/** `../server` afresh, with the stub already in place. */
async function load(): Promise<(request: Request) => Promise<Response>> {
  vi.resetModules();
  const module = (await import("../server")) as {
    default: (request: Request) => Promise<Response>;
  };
  return module.default;
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

  it("addresses the MCP Door on the container, not its root", async () => {
    const upstream = gateway(0);
    vi.stubGlobal("fetch", upstream.fetch);

    const front = await load();
    await callTo(front);

    expect(upstream.seen).toContain(`POST ${GATEWAY}/mcp`);
    expect(upstream.seen.every((hit) => hit.endsWith("/mcp"))).toBe(true);
  });

  it("promises meco's own measured cold start, not the package's ceiling", async () => {
    // Held past the package's 500 ms probe timeout, so the cold path opens.
    const upstream = gateway(700);
    vi.stubGlobal("fetch", upstream.fetch);

    const front = await load();
    const response = await callTo(front);

    expect(response.headers.get("content-type")).toContain("text/event-stream");

    const notices = (await frames(response)).filter(
      (frame): frame is { params: { data: string } } =>
        (frame as { method?: string }).method === "notifications/message"
    );
    expect(notices[0]?.params.data).toBe("meco is starting, about 7 seconds");
    expect(notices.at(-1)?.params.data).toBe(
      "meco is up, your request is now being processed"
    );
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
