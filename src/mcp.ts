/**
 * meco as a remote MCP server, so Claude Code and Claude Desktop can make
 * brand images without an HTTP client in between.
 *
 * Streamable HTTP, stateless: `createMcpHandler` builds one server per request,
 * which is what a scale-to-zero container wants — nothing to keep warm between
 * calls.
 */
import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import * as api from "./api.js";
import { BRANDS } from "./brands.js";
import { CHANNELS, PLACEMENTS } from "./channels.js";
import { CROP_ANCHORS, fetchSourceImage } from "./crop.js";
import * as people from "./people.js";
import type { Storage } from "./storage.js";
import { describeTemplates } from "./templates/registry.js";

/** MCP wants text; the caller wants the URLs. JSON carries both. */
function reply(payload: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }] };
}

function fail(err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  const details = err instanceof api.ApiError ? err.details : undefined;
  return {
    isError: true,
    content: [
      {
        type: "text" as const,
        text: JSON.stringify({ error: message, ...(details ? { details } : {}) }, null, 2),
      },
    ],
  };
}

/**
 * Turn away `subscriptions/listen` before the SDK can open a stream for it.
 *
 * That method is the 2026 spec's long-lived change feed, and the SDK always
 * serves it over SSE and holds it open until an event arrives. meco publishes
 * no events — its tools are compiled in and its capabilities say so — so the
 * stream would wait forever, and on a metered container an open stream is an
 * invocation billed until the platform kills it. Declining `listChanged` stops
 * a well-behaved client from asking; this stops the ones that ask anyway.
 *
 * `-32601` is the same answer the 2025 path has always given this method, and
 * clients on that path work fine, so it is a shape they already handle.
 */
async function declineSubscription(request: Request): Promise<Response> {
  let id: unknown = null;
  try {
    id = ((await request.json()) as { id?: unknown }).id ?? null;
  } catch {
    // A body we cannot parse still gets a well-formed answer, just without an id.
  }
  return Response.json({
    jsonrpc: "2.0",
    id,
    error: { code: -32601, message: "Method not found" },
  });
}

export function createMecoMcpHandler(storage: Storage) {
  const handler = createMcpHandler(() => {
    const server = new McpServer(
      { name: "meco", version: "0.1.0" },
      // meco's tools are compiled in: the list is the same for every caller and
      // never changes while the process lives. Advertising `listChanged` invites
      // clients to open a `subscriptions/listen` stream, which the SDK holds open
      // over SSE waiting for an event that can never arrive — on a metered
      // container that is an invocation billed until the platform kills it.
      { capabilities: { tools: { listChanged: false } } },
    );

    server.registerTool(
      "list_templates",
      {
        description:
          "List every meco Template with the exact JSON Schema its data must " +
          "satisfy. Call this before rendering: it is the only place the " +
          "required fields of a Template are written down.",
        inputSchema: z.object({
          brand: z
            .enum(["laica", "hopefamily", "swisshutless"])
            .optional()
            .describe("Only Templates belonging to this Brand."),
        }),
      },
      async ({ brand }) => {
        const all = describeTemplates();
        return reply(brand ? all.filter((t) => t.brand === brand) : all);
      },
    );

    server.registerTool(
      "list_placements",
      {
        description:
          "List the Channels and the Placements each offers, with pixel sizes. " +
          "A Placement is one way of posting — instagram/post, instagram/story.",
        inputSchema: z.object({}),
      },
      async () =>
        reply({
          channels: CHANNELS,
          placements: [...PLACEMENTS.values()],
          note: "Naming a bare channel renders every placement it offers.",
        }),
    );

    server.registerTool(
      "list_brands",
      {
        description: "List the Brands meco renders for, with their colours and fonts.",
        inputSchema: z.object({}),
      },
      async () =>
        reply(
          [...BRANDS.values()].map((b) => ({
            id: b.id,
            name: b.name,
            colors: b.colors,
            headingFamily: b.headingFamily,
            bodyFamily: b.bodyFamily,
          })),
        ),
    );

    server.registerTool(
      "render_image",
      {
        description:
          "Render one Template at one or more Placements and return a public " +
          "URL per Placement. Naming a bare Channel renders every Placement it " +
          "offers. Renders are content-addressed, so the same input returns the " +
          "same URL and a retry costs nothing.",
        inputSchema: z.object({
          template: z.string().describe("Template id from list_templates."),
          channels: z
            .array(z.string())
            .min(1)
            .describe('Channels or Placements, e.g. ["linkedin"] or ["instagram/story"].'),
          data: z
            .record(z.string(), z.unknown())
            .describe("Template data, matching that Template's schema exactly."),
          format: z.enum(["png", "jpeg", "webp"]).optional(),
          quality: z.number().int().min(1).max(100).optional(),
        }),
      },
      async (input) => {
        try {
          return reply(await api.render(api.renderBody.parse(input), storage));
        } catch (err) {
          return fail(err);
        }
      },
    );

    server.registerTool(
      "render_carousel",
      {
        description:
          "Render Slides into one multi-page PDF (LinkedIn) or a list of images " +
          "(Instagram). Each Slide names its own Template, so a carousel can be a " +
          "cover, some points and a closing card rather than one layout repeated.",
        inputSchema: z.object({
          slides: z
            .array(
              z.object({
                template: z.string(),
                data: z.record(z.string(), z.unknown()),
              }),
            )
            .min(1),
          channel: z.string().optional().describe("Placement for every Slide. Default linkedin/post."),
          output: z.enum(["pdf", "images"]).optional(),
        }),
      },
      async (input) => {
        try {
          return reply(await api.carousel(api.carouselBody.parse(input), storage));
        } catch (err) {
          return fail(err);
        }
      },
    );

    server.registerTool(
      "crop_image",
      {
        description:
          "Cut a Source Image to an exact size. A face in the picture frames the " +
          "Crop by itself, with the eye line on the upper golden line; otherwise " +
          "give an anchor to choose the region yourself, or a strategy to let the " +
          "image decide — 'attention' keeps the most salient area. Give a " +
          "subjectArea to say where in the result the Subject has to land. Set " +
          "blurUnknownFaces to hide the faces of people meco does not know.",
        inputSchema: z.object({
          source: z.string().url().describe("URL of the Source Image."),
          width: z.number().int().positive(),
          height: z.number().int().positive(),
          anchor: z.enum(CROP_ANCHORS).optional(),
          strategy: z.enum(["attention", "entropy"]).optional(),
          subjectArea: api.subjectAreaShape
            .optional()
            .describe(
              "The rectangle of the result the Subject must fill, as fractions " +
                "0..1 from the top-left. Overrides the anchor and the default " +
                "golden-ratio framing. The answer says whether it was satisfied.",
            ),
          blurUnknownFaces: z
            .boolean()
            .optional()
            .describe(
              "Blur every face in the result that is not a known Person, " +
                "behind an elliptical mask. Faces the crop left out are not " +
                "touched and not counted. The answer says how many were hidden.",
            ),
          format: z.enum(["png", "jpeg", "webp"]).optional(),
          quality: z.number().int().min(1).max(100).optional(),
        }),
      },
      async (input) => {
        try {
          return reply(await api.crop(api.cropBody.parse(input), storage));
        } catch (err) {
          return fail(err);
        }
      },
    );

    server.registerTool(
      "find_subjects",
      {
        description:
          "Find the Subjects in a Source Image without cropping it: every face, " +
          "as a rectangle in fractions 0..1 from the top-left. Use it to see what " +
          "a Crop would be framed on before choosing a size. The answer is cached " +
          "under the image's own hash, so asking twice costs one detection.",
        inputSchema: z.object({
          source: z.string().url().describe("URL of the Source Image."),
        }),
      },
      async (input) => {
        try {
          return reply(await api.findSubjects(api.subjectsBody.parse(input), storage));
        } catch (err) {
          return fail(err);
        }
      },
    );

    // ---------------------------------------------------------------- people

    /**
     * People are personal data, so these three tools are deliberately the whole
     * of what MCP can do with them: list, create, enrol. Deleting a Person is
     * not offered here — it is irreversible, it takes every Reference Photo and
     * Face Print with it, and it belongs behind a hand on a console rather than
     * behind a sentence an agent decided to act on.
     */
    server.registerTool(
      "list_people",
      {
        description:
          "List the People a Brand has enrolled, with how many Reference Photos " +
          "each has. A Person is a named individual the Brand wants recognised; " +
          "they belong to exactly one Brand.",
        inputSchema: z.object({
          brand: z
            .enum(["laica", "hopefamily", "swisshutless"])
            .describe("The Brand whose People to list."),
        }),
      },
      async ({ brand }) => {
        try {
          const enrolled = await people.listPeople(brand, storage);
          return reply({
            brand,
            people: enrolled.map((p) => ({
              id: p.id,
              name: p.name,
              createdAt: p.createdAt,
              photoCount: p.photos.length,
            })),
          });
        } catch (err) {
          return fail(err);
        }
      },
    );

    server.registerTool(
      "add_person",
      {
        description:
          "Create a Person under a Brand. Returns the Person id to enrol " +
          "Reference Photos against. Creating a Person stores nothing but a name.",
        inputSchema: z.object({
          brand: z.enum(["laica", "hopefamily", "swisshutless"]),
          name: z.string().describe("The Person's name, as a human would write it."),
        }),
      },
      async (input) => {
        try {
          return reply(await people.createPerson(people.addPersonBody.parse(input), storage));
        } catch (err) {
          return fail(err);
        }
      },
    );

    server.registerTool(
      "add_reference_photo",
      {
        description:
          "Enrol a photograph as a Reference Photo of one Person: meco finds the " +
          "faces, computes the Face Print and stores both privately. One face is " +
          "enrolled by itself; several come back as a list for you to choose from " +
          "with faceIndex; a photograph with no face, or a face under 40 px, is " +
          "refused. Only enrol people who agreed to it, and say so with consent.",
        inputSchema: z.object({
          brand: z.enum(["laica", "hopefamily", "swisshutless"]),
          personId: z.string().describe("Person id from list_people or add_person."),
          source: z.string().url().describe("URL of the photograph."),
          faceIndex: z
            .number()
            .int()
            .min(0)
            .optional()
            .describe("Which face to enrol, when a previous call returned several."),
          consent: z
            .boolean()
            .optional()
            .describe("True when this Person agreed to be enrolled. Stored as a timestamp."),
        }),
      },
      async ({ personId, ...rest }) => {
        try {
          const input = people.addReferencePhotoBody.parse(rest);
          return reply(
            await people.enrolReferencePhoto(
              {
                brand: input.brand,
                personId,
                source: await fetchSourceImage(input.source),
                ...(input.faceIndex === undefined ? {} : { faceIndex: input.faceIndex }),
                consent: input.consent === true,
              },
              storage,
            ),
          );
        } catch (err) {
          return fail(err);
        }
      },
    );

    return server;
  });

  // The 2026 era names the method in a header, so the decision is made without
  // touching the body of any request that is going through.
  return {
    ...handler,
    fetch: (request: Request) =>
      request.headers.get("mcp-method") === "subscriptions/listen"
        ? declineSubscription(request)
        : handler.fetch(request),
  };
}
