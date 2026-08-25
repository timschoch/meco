/**
 * The meco HTTP API.
 *
 * Small on purpose: render a Template at some Placements, stitch Slides into a
 * Carousel, crop a Source Image, and describe what exists so another tool can
 * discover all of it without being told.
 */
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono, type Context, type Next } from "hono";
import { z } from "zod";

import * as api from "./api.js";
import { BRANDS } from "./brands.js";
import { CHANNELS, PLACEMENTS } from "./channels.js";
import { createMecoMcpHandler } from "./mcp.js";
import { createStorage } from "./storage.js";
import { describeTemplates } from "./templates/registry.js";
import { UI_HTML } from "./ui.js";

const app = new Hono();
const storage = createStorage();

/** Bearer auth, on only when a token is configured. */
const TOKEN = process.env.MECO_TOKEN;

/**
 * `x-auth-token` alongside the usual bearer header: Claude Desktop reserves
 * `Authorization` for its own OAuth flow and greys it out in the connector
 * dialog, leaving `x-auth-token` as the only approved name a custom connector
 * can actually set.
 */
const requireToken = async (c: Context, next: Next) => {
  if (!TOKEN) return next();
  const bearer = c.req.header("authorization") === `Bearer ${TOKEN}`;
  const direct = c.req.header("x-auth-token") === TOKEN;
  if (!bearer && !direct) {
    return c.json({ error: "Unauthorized" }, 401);
  }
  return next();
};

app.use("/v1/*", requireToken);
app.use("/mcp", requireToken);

/** Every failure here is a caller mistake — a bad name, bad data, a dead URL. */
function errorResponse(c: Context, err: unknown) {
  const details = err instanceof api.ApiError ? err.details : undefined;
  return c.json(
    { error: (err as Error).message, ...(details ? { details } : {}) },
    400,
  );
}

app.get("/health", (c) =>
  c.json({ ok: true, storage: storage.kind, templates: describeTemplates().length }),
);

// The demo console. The page itself is public; every call it makes carries the
// bearer token the visitor pasted, so it is exactly as protected as `/v1/*`.
app.get("/", (c) => c.html(UI_HTML));

// ---------------------------------------------------------------- discovery

app.get("/v1/templates", (c) => {
  const brand = c.req.query("brand");
  const all = describeTemplates();
  return c.json(brand ? all.filter((t) => t.brand === brand) : all);
});

app.get("/v1/channels", (c) =>
  c.json({
    channels: CHANNELS,
    placements: [...PLACEMENTS.values()],
    note: "Naming a bare channel renders every placement it offers.",
  }),
);

app.get("/v1/brands", (c) =>
  c.json(
    [...BRANDS.values()].map((b) => ({
      id: b.id,
      name: b.name,
      colors: b.colors,
      headingFamily: b.headingFamily,
      bodyFamily: b.bodyFamily,
    })),
  ),
);

// ------------------------------------------------------------------ gallery

// Everything rendered so far, newest first, optionally for one Brand only.
app.get("/v1/gallery", async (c) => {
  const limit = c.req.query("limit");
  const parsed = api.galleryQuery.safeParse({
    ...(c.req.query("brand") ? { brand: c.req.query("brand") } : {}),
    ...(limit ? { limit: Number(limit) } : {}),
  });
  if (!parsed.success) {
    return c.json({ error: "Invalid request", details: z.treeifyError(parsed.error) }, 400);
  }
  try {
    return c.json(await api.gallery(parsed.data, storage));
  } catch (err) {
    return errorResponse(c, err);
  }
});

// ------------------------------------------------------------------- render

app.post("/v1/render", async (c) => {
  const parsed = api.renderBody.safeParse(await c.req.json());
  if (!parsed.success) {
    return c.json({ error: "Invalid request", details: z.treeifyError(parsed.error) }, 400);
  }
  try {
    return c.json(await api.render(parsed.data, storage));
  } catch (err) {
    return errorResponse(c, err);
  }
});

// ----------------------------------------------------------------- carousel

app.post("/v1/carousel", async (c) => {
  const parsed = api.carouselBody.safeParse(await c.req.json());
  if (!parsed.success) {
    return c.json({ error: "Invalid request", details: z.treeifyError(parsed.error) }, 400);
  }
  try {
    return c.json(await api.carousel(parsed.data, storage));
  } catch (err) {
    return errorResponse(c, err);
  }
});

// --------------------------------------------------------------------- crop

app.post("/v1/crop", async (c) => {
  const parsed = api.cropBody.safeParse(await c.req.json());
  if (!parsed.success) {
    return c.json({ error: "Invalid request", details: z.treeifyError(parsed.error) }, 400);
  }
  try {
    return c.json(await api.crop(parsed.data, storage));
  } catch (err) {
    return errorResponse(c, err);
  }
});

// ---------------------------------------------------------------------- MCP

// The same operations over MCP, so Claude Code and Claude Desktop reach them as
// tools rather than as HTTP. Stateless: one server per request, nothing to keep
// warm in a container that scales to zero.
const mcp = createMecoMcpHandler(storage);
app.all("/mcp", (c) => mcp.fetch(c.req.raw));

/**
 * The same endpoint with the token in the path.
 *
 * A 401 from `/mcp` is what the MCP spec uses to start an OAuth flow, so a
 * client that sees one goes looking for an authorisation server instead of
 * sending the token it was given — which is where Claude Desktop's custom
 * connector gets stuck. Carrying the token in the path means the request is
 * authorised on arrival and no 401 is ever produced.
 *
 * The cost is that the token appears in request logs, so treat this URL as the
 * secret it contains and prefer the header on clients that can send one.
 */
app.all("/mcp/:token", (c) => {
  if (TOKEN && c.req.param("token") !== TOKEN) {
    return c.json({ error: "Unauthorized" }, 401);
  }
  return mcp.fetch(c.req.raw);
});

// Serve local renders so the URLs the local driver hands back actually resolve.
// Only mounted for local storage: on Blob the URLs point at Blob, and mounting
// these would just log a missing-directory warning on every request.
if (storage.kind === "local") {
  mkdirSync(resolve(process.cwd(), "out"), { recursive: true });
  app.use("/renders/*", serveStatic({ root: "./out" }));
  app.use("/carousels/*", serveStatic({ root: "./out" }));
  app.use("/crops/*", serveStatic({ root: "./out" }));
}

const port = Number(process.env.PORT ?? 8787);
serve({ fetch: app.fetch, port, hostname: "0.0.0.0" }, (info) => {
  console.log(`meco listening on :${info.port}  storage=${storage.kind}`);
});

export default app;
