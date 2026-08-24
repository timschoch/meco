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
import { CROP_ANCHORS } from "./crop.js";
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

export function createMecoMcpHandler(storage: Storage) {
  return createMcpHandler(() => {
    const server = new McpServer({ name: "meco", version: "0.1.0" });

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
          "Cut a Source Image to an exact size. Give an anchor to choose the " +
          "region yourself, or a strategy to let the image decide — 'attention' " +
          "keeps the most salient area, which is what keeps a person in frame.",
        inputSchema: z.object({
          source: z.string().url().describe("URL of the Source Image."),
          width: z.number().int().positive(),
          height: z.number().int().positive(),
          anchor: z.enum(CROP_ANCHORS).optional(),
          strategy: z.enum(["attention", "entropy"]).optional(),
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

    return server;
  });
}
