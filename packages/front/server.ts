/**
 * Entry point: the Function Vercel runs, and the whole of `@meco/front`.
 *
 * The proxy itself is `@timschoch/vercel-mcp-cold-start`, extracted from this
 * package and published: it knows no tool, forwards every JSON-RPC message
 * verbatim, and tells a request the container has not answered within half a
 * second that it is being processed, again every two seconds until it is.
 * Nothing about it is meco's, which is why it left. What stays here is the
 * wiring only meco can know: which container, and what the notices call it.
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
 * `name` is what the notices call the container; a person reads it in their
 * agent's log, so it is `meco` and not the package's "the server". The
 * timings stay the package's `NOTICES`: the first notice at 500 ms is inside
 * the ticket's one-second budget, and the gateway's measured cold start
 * (`DEPLOY.md`, "The Front") is long enough for at least one repeat.
 */
const front = createFront({
  upstream: new URL("/mcp", gateway).toString(),
  notices: { name: "meco" },
});

/**
 * Under the method names, and **never** as a bare default function. Vercel's
 * Node runtime picks the calling convention from the export shape: a named
 * `GET`/`POST`/`DELETE` or a `default` object with a `fetch` method is handed
 * the web `Request`, whose `url` is absolute; a default *function* is the old
 * `(req, res)` handler and is handed Node's `IncomingMessage`, whose `url` is
 * the path alone. The front reads `request.url` to carry the query string
 * over, so the Node shape fails it — `new URL("/mcp")` throws
 * `ERR_INVALID_URL`, and every request to the Front is a `500`. This file
 * exported both for a preview deployment, the default won, and that is what
 * happened. The three MCP verbs are the whole Streamable HTTP surface.
 */
export { front as GET, front as POST, front as DELETE };
