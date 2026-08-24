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

const app = new Hono();
const storage = createStorage();

/** Bearer auth, on only when a token is configured. */
const TOKEN = process.env.MECO_TOKEN;

const requireToken = async (c: Context, next: Next) => {
  if (!TOKEN) return next();
  const header = c.req.header("authorization") ?? "";
  if (header !== `Bearer ${TOKEN}`) {
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
