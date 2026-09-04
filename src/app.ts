/**
 * The meco HTTP API, as routes over a Storage.
 *
 * Small on purpose: render a Template at some Placements, stitch Slides into a
 * Carousel, crop a Source Image, and describe what exists so another tool can
 * discover all of it without being told.
 *
 * Separate from `server.ts` so the API can be driven without binding a port —
 * `scripts/http-probe.ts` calls `createApp(...).fetch` directly, the same way
 * the MCP probe calls the MCP handler. Everything that needs a listening socket
 * or a disk to serve from stays in `server.ts`.
 */
import { Hono, type Context, type Next } from "hono";
import { z } from "zod";

import * as api from "./api.js";
import { BRANDS } from "./brands.js";
import { CHANNELS, PLACEMENTS } from "./channels.js";
import { fetchSourceImage } from "./crop.js";
import { createMecoMcpHandler } from "./mcp.js";
import * as people from "./people.js";
import type { Storage } from "./storage.js";
import { describeTemplates } from "./templates/registry.js";
import { UI_HTML } from "./ui.js";

export function createApp(storage: Storage): Hono {
  const app = new Hono();

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

  // -------------------------------------------------------------- discovery

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

  // ---------------------------------------------------------------- gallery

  // Everything rendered so far, newest first, optionally for one Brand only.
  app.get("/v1/gallery", async (c) => {
    const limit = c.req.query("limit");
    const parsed = api.galleryQuery.safeParse({
      ...(c.req.query("brand") ? { brand: c.req.query("brand") } : {}),
      ...(c.req.query("placement") ? { placement: c.req.query("placement") } : {}),
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

  // ----------------------------------------------------------------- render

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

  // --------------------------------------------------------------- carousel

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

  // ------------------------------------------------------------------- crop

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

  // --------------------------------------------------------------- subjects

  // The Annotation for a Source Image, without cropping it — what the console
  // draws its "Preview subjects" overlay from.
  app.post("/v1/subjects", async (c) => {
    const parsed = api.subjectsBody.safeParse(await c.req.json());
    if (!parsed.success) {
      return c.json({ error: "Invalid request", details: z.treeifyError(parsed.error) }, 400);
    }
    try {
      return c.json(await api.findSubjects(parsed.data, storage));
    } catch (err) {
      return errorResponse(c, err);
    }
  });

  // ----------------------------------------------------------------- people

  /**
   * A Person always travels with the Brand that owns them.
   *
   * The record lives at `people/<brand>/<personId>/…`, so an id on its own does
   * not locate it — finding one would mean listing every Brand's prefix on every
   * call. Naming the Brand also means a mistyped id cannot reach into another
   * Brand's People, which for personal data is worth one query parameter.
   */
  const brandOf = (c: Context): string => {
    const brand = c.req.query("brand");
    if (!brand) throw new Error("Name the Brand this Person belongs to: ?brand=<id>.");
    return brand;
  };

  app.get("/v1/people", async (c) => {
    try {
      const brand = brandOf(c);
      const enrolled = await people.listPeople(brand, storage);
      return c.json({ brand, people: enrolled.map(describePerson) });
    } catch (err) {
      return errorResponse(c, err);
    }
  });

  app.post("/v1/people", async (c) => {
    const parsed = people.addPersonBody.safeParse(await c.req.json());
    if (!parsed.success) {
      return c.json({ error: "Invalid request", details: z.treeifyError(parsed.error) }, 400);
    }
    try {
      return c.json(describePerson(await people.createPerson(parsed.data, storage)));
    } catch (err) {
      return errorResponse(c, err);
    }
  });

  app.delete("/v1/people/:id", async (c) => {
    try {
      const removed = await people.deletePerson(brandOf(c), c.req.param("id"), storage);
      return c.json({ deleted: true, objects: removed.deleted });
    } catch (err) {
      return errorResponse(c, err);
    }
  });

  /**
   * Add Reference Photos to a Person, as an upload or as a URL.
   *
   * Several photographs may arrive in one multipart request, and each is enrolled
   * on its own: one may enrol, the next may have several faces and come back for
   * a pick, a third may have no face at all. So the answer is a result per
   * photograph rather than one verdict, and the request is only a 400 when
   * nothing in it could succeed — no photograph enrolled and none waiting on a
   * face to be picked.
   *
   * The platform caps a request body at 100 MB, which meco does not narrow: the
   * limit that matters is the one the request will actually meet, and inventing a
   * second one here would refuse photographs the platform would have carried.
   */
  app.post("/v1/people/:id/photos", async (c) => {
    try {
      const personId = c.req.param("id");
      const uploads = await readUploads(c);
      const person = await people.getPerson(uploads.brand, personId, storage);

      const results: PhotoResult[] = [];
      // Kept beside the list so a request where nothing worked can say why in the
      // one field every other failure in this API uses.
      let firstRejection = "";
      for (const one of uploads.photos) {
        try {
          const enrolment = await people.enrolReferencePhoto(
            {
              brand: uploads.brand,
              personId,
              source: one.bytes,
              ...(uploads.faceIndex === undefined ? {} : { faceIndex: uploads.faceIndex }),
              consent: uploads.consent,
            },
            storage,
          );
          results.push({ name: one.name, ...enrolment });
        } catch (err) {
          // One unusable photograph does not throw away the ones beside it.
          const message = (err as Error).message;
          firstRejection ||= message;
          results.push({ name: one.name, status: "rejected", error: message });
        }
      }

      const usable = results.some((r) => r.status !== "rejected");
      return c.json(
        {
          personId,
          name: person.name,
          results,
          ...(usable ? {} : { error: firstRejection || "Nothing could be enrolled." }),
        },
        usable ? 200 : 400,
      );
    } catch (err) {
      return errorResponse(c, err);
    }
  });

  /**
   * The bytes of one Reference Photo.
   *
   * A Reference Photo is private in the store, so its own URL hands nothing over.
   * This is the only way to see one, and it is behind the same token as the rest
   * of `/v1/*` — which is what lets the console outline the enrolled face on the
   * actual photograph without the photograph having a public address.
   */
  app.get("/v1/people/:id/photos/:photoId", async (c) => {
    try {
      const photo = await people.referencePhotoBytes(
        brandOf(c),
        c.req.param("id"),
        c.req.param("photoId"),
        storage,
      );
      return c.body(photo.bytes as unknown as ArrayBuffer, 200, {
        "content-type": photo.contentType,
        // Personal data behind a token must not be left in a shared cache.
        "cache-control": "private, no-store",
      });
    } catch (err) {
      return errorResponse(c, err);
    }
  });

  app.delete("/v1/people/:id/photos/:photoId", async (c) => {
    try {
      const person = await people.deleteReferencePhoto(
        brandOf(c),
        c.req.param("id"),
        c.req.param("photoId"),
        storage,
      );
      return c.json(describePerson(person));
    } catch (err) {
      return errorResponse(c, err);
    }
  });

  // -------------------------------------------------------------------- MCP

  // The same operations over MCP, so Claude Code and Claude Desktop reach them as
  // tools rather than as HTTP. Stateless: one server per request, nothing to keep
  // warm in a container that scales to zero.
  const mcp = createMecoMcpHandler(storage);

  /**
   * Serve one MCP exchange and record when its response body actually ended.
   *
   * The platform bills a request until its body closes, and a body that never
   * closes shows up in the platform log only as a timeout with no method
   * attached — which makes an expensive exchange indistinguishable from a cheap
   * one. Wrapping the stream is the only place that end is observable.
   */
  async function serveMcp(request: Request): Promise<Response> {
    const started = performance.now();
    const method = request.headers.get("mcp-method") ?? "?";
    const response = await mcp.fetch(request);

    const done = (note: string) => {
      const ms = (performance.now() - started).toFixed(0);
      console.log(`mcp ${method} ${String(response.status)} ${note} ${ms}ms`);
    };

    if (!response.body) {
      done("no-body");
      return response;
    }

    // Identity transform: it changes nothing about the bytes or the backpressure,
    // it only gives us a hook on the end of the stream.
    const { readable, writable } = new TransformStream();
    void response.body
      .pipeTo(writable)
      .then(() => {
        done("closed");
      })
      .catch(() => {
        done("aborted");
      });

    return new Response(readable, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  }

  app.all("/mcp", (c) => serveMcp(c.req.raw));

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
    return serveMcp(c.req.raw);
  });

  return app;
}

/** A Person as a caller reads one: the record, plus the count the console shows. */
function describePerson(person: people.Person) {
  return { ...person, photoCount: person.photos.length };
}

/** What became of one photograph in a request that carried several. */
type PhotoResult =
  | ({ name: string } & people.Enrolment)
  | { name: string; status: "rejected"; error: string };

/** One photograph on its way in, with something to call it in the answer. */
interface Upload {
  name: string;
  bytes: Buffer;
}

interface Uploads {
  brand: string;
  faceIndex?: number;
  consent: boolean;
  photos: Upload[];
}

/**
 * The photographs in one request, however they were sent.
 *
 * Multipart and a JSON body with a URL are the two ways a Reference Photo
 * arrives, and they differ only in where the bytes come from — so they are read
 * into the same shape here and the route below never learns which it was. A
 * browser can only upload; an MCP client can only name a URL; both have to work.
 */
async function readUploads(c: Context): Promise<Uploads> {
  const type = c.req.header("content-type") ?? "";

  if (!type.startsWith("multipart/form-data")) {
    const parsed = people.addReferencePhotoBody.safeParse(await c.req.json());
    if (!parsed.success) {
      throw new api.ApiError("Invalid request", z.treeifyError(parsed.error));
    }
    return {
      brand: parsed.data.brand,
      ...(parsed.data.faceIndex === undefined ? {} : { faceIndex: parsed.data.faceIndex }),
      consent: parsed.data.consent === true,
      photos: [{ name: parsed.data.source, bytes: await fetchSourceImage(parsed.data.source) }],
    };
  }

  // `all` so that several files under one field name arrive as a list rather
  // than as whichever one happened to be parsed last.
  const form = await c.req.parseBody({ all: true });
  const field = (name: string): string | undefined => {
    const value = form[name];
    return typeof value === "string" ? value : undefined;
  };

  const brand = field("brand");
  if (!brand) throw new Error("Name the Brand this Person belongs to: a `brand` field.");

  const photos: Upload[] = [];
  const files = form["file"];
  for (const one of Array.isArray(files) ? files : files ? [files] : []) {
    if (typeof one === "string") continue;
    photos.push({
      name: one.name || "upload",
      bytes: Buffer.from(await one.arrayBuffer()),
    });
  }

  // A URL may ride along in a form too, so the console can offer both without
  // sending two different kinds of request.
  const source = field("source");
  if (source) photos.push({ name: source, bytes: await fetchSourceImage(source) });

  if (photos.length === 0) {
    throw new Error("Attach at least one photograph as `file`, or name one as `source`.");
  }

  const index = field("faceIndex");
  const consent = field("consent");
  return {
    brand,
    ...(index === undefined || index === "" ? {} : { faceIndex: Number(index) }),
    // A checkbox arrives as "on"; an API client is likelier to send "true".
    consent: consent === "true" || consent === "on" || consent === "1",
    photos,
  };
}
