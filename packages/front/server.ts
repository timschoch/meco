/**
 * Entry point: the Function Vercel runs, and the whole of `@meco/front`.
 *
 * The proxy itself is `@timschoch/vercel-mcp-cold-start`, extracted from this
 * package and published: it knows no tool, forwards every JSON-RPC message
 * verbatim, and tells a `tools/call` that arrives on a scaled-to-zero
 * container that it is starting. Nothing about it is meco's, which is why it
 * left. What stays here is the wiring only meco can know: which container,
 * what the notices call it, and the boot time they promise.
 *
 * `GATEWAY_URL` is the service binding to the gateway container
 * (`vercel.json`), injected at runtime only, so a deployment without it fails
 * on the first request with the variable named.
 */
import { createFront } from "@timschoch/vercel-mcp-cold-start";

const gateway = process.env["GATEWAY_URL"];
if (gateway === undefined || gateway === "") {
  throw new Error("front cannot start: GATEWAY_URL is unset");
}

/**
 * The MCP Door's own URL. The package joins nothing onto `upstream`, so the
 * path is named here rather than assumed there.
 *
 * `seconds` is meco's own last measured cold start (`DEPLOY.md`, "The Front"),
 * not the package's default of 30 — that is a ceiling for a server nobody has
 * measured, and meco has.
 */
const front = createFront({
  upstream: new URL("/mcp", gateway).toString(),
  coldStart: { name: "meco", seconds: 7 },
});

export { front as GET, front as POST, front as DELETE };
export default front;
