import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { OPERATIONS } from "../app";
import { HELD, KEY, TIMEOUT, open, rpc, type Opened } from "./harness";

const opened: Opened[] = [];
afterEach(async () => {
  await Promise.all(opened.splice(0).map((one) => one.close()));
});

async function stack(): Promise<Opened> {
  const one = await open();
  opened.push(one);
  return one;
}

const withKey = { headers: { Authorization: `Bearer ${KEY}` } };

type Tool = { name: string; inputSchema: unknown; description?: string };

describe("the Operation table on the MCP Door", () => {
  it(
    "answers initialize as the meco server at the gateway's version",
    async () => {
      const one = await stack();
      const answer = await rpc(one.app(), {
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "test", version: "0" },
        },
      });
      expect(answer.result).toMatchObject({
        serverInfo: { name: "meco", version: "test" },
      });
    },
    TIMEOUT
  );

  it(
    "lists exactly the table's Operations, each with the HTTP route's input as its schema",
    async () => {
      const one = await stack();
      const answer = await rpc(one.app(), { method: "tools/list" });
      const tools = (answer.result as { tools: Tool[] }).tools;

      expect(tools.map((t) => t.name).sort()).toEqual(
        OPERATIONS.map((o) => o.name).sort()
      );
      for (const operation of OPERATIONS) {
        const tool = tools.find((t) => t.name === operation.name);
        // The input side: what a client sends, which is what `tools/list` is
        // for. The output side would add `additionalProperties: false`.
        expect(tool?.inputSchema).toEqual(
          z.toJSONSchema(operation.input, { io: "input" })
        );
        expect(tool?.description).toBe(operation.description);
      }
    },
    TIMEOUT
  );

  it(
    "answers a tool call with the same JSON the HTTP route answers",
    async () => {
      const one = await stack();
      const res = await one.app().request("/v1/brands", withKey);
      const http: unknown = await res.json();

      const answer = await rpc(one.app(), {
        method: "tools/call",
        params: { name: "list_brands", arguments: {} },
      });

      expect(answer.result).toEqual({
        content: [{ type: "text", text: JSON.stringify(http) }],
      });
    },
    TIMEOUT
  );

  it(
    "carries an Operation's refusal as a tool error with the same body",
    async () => {
      const one = await stack();
      const answer = await rpc(one.app(), {
        method: "tools/call",
        params: {
          name: "find_subjects",
          arguments: {
            brand: HELD[0],
            source: { url: "https://x.test/a.jpg" },
          },
        },
      });
      expect(answer.result).toMatchObject({ isError: true });
      const text = (answer.result as { content: { text: string }[] }).content[0]
        ?.text;
      expect(JSON.parse(text ?? "")).toEqual({
        error: { code: "not_implemented", message: expect.any(String) },
      });
    },
    TIMEOUT
  );
});

describe("the Operation table on the HTTP Door", () => {
  it(
    "answers the Placement catalogue",
    async () => {
      const one = await stack();
      const res = await one.app().request("/v1/placements", withKey);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { id: string; width: number }[];
      expect(body.length).toBe(7);
      expect(body[0]).toEqual({
        id: "linkedin/post",
        width: 1200,
        height: 1200,
      });
    },
    TIMEOUT
  );

  it(
    "lists the Templates of one held Brand, or of every held Brand",
    async () => {
      const one = await stack();
      const app = one.app();
      const laica = (await (
        await app.request("/v1/templates?brand=laica", withKey)
      ).json()) as { id: string; brand: string; fields: unknown }[];
      const every = (await (
        await app.request("/v1/templates", withKey)
      ).json()) as { brand: string }[];

      expect(laica.length).toBeGreaterThan(0);
      expect(laica.every((t) => t.brand === "laica")).toBe(true);
      expect(laica[0]?.fields).toMatchObject({ type: "object" });
      const brands = new Set(every.map((t) => t.brand));
      expect([...brands].sort()).toEqual([...HELD].sort());
    },
    TIMEOUT
  );

  it(
    "lists People without their prints or Store Keys",
    async () => {
      const one = await stack();
      const person = await one.records.people.create({
        brand: "laica",
        name: "Ada",
      });
      const res = await one.app().request("/v1/people?brand=laica", withKey);

      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toEqual([
        {
          id: person.id,
          brand: "laica",
          name: "Ada",
          createdAt: person.createdAt,
          photos: [],
        },
      ]);
    },
    TIMEOUT
  );

  it(
    "answers the pipeline Operations as 501 not_implemented until their tickets land",
    async () => {
      const one = await stack();
      const res = await one.app().request("/v1/render", {
        ...withKey,
        method: "POST",
        headers: { ...withKey.headers, "content-type": "application/json" },
        body: JSON.stringify({
          brand: HELD[0],
          template: "laica-post",
          placement: "linkedin/post",
          fields: {},
          source: { url: "https://x.test/a.jpg" },
        }),
      });
      expect(res.status).toBe(501);
      await expect(res.json()).resolves.toMatchObject({
        error: { code: "not_implemented" },
      });
    },
    TIMEOUT
  );

  it(
    "refuses an input the Operation's schema rejects as 400 invalid_request, naming the field",
    async () => {
      const one = await stack();
      const res = await one.app().request("/v1/crop", {
        method: "POST",
        headers: { ...withKey.headers, "content-type": "application/json" },
        body: JSON.stringify({
          brand: HELD[0],
          source: { url: "http://insecure.test/a.jpg" },
          width: 0,
        }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as {
        error: {
          code: string;
          details: { properties: Record<string, unknown> };
        };
      };
      expect(body.error.code).toBe("invalid_request");
      expect(Object.keys(body.error.details.properties).sort()).toEqual([
        "height",
        "source",
        "width",
      ]);
    },
    TIMEOUT
  );

  it(
    "refuses a body that is not JSON as 400 and a route nothing answers as 404, both as the wire's error",
    async () => {
      const one = await stack();
      const app = one.app();
      const notJson = await app.request("/v1/annotate", {
        method: "POST",
        headers: withKey.headers,
        body: "not json",
      });
      const nothing = await app.request("/v1/nothing", withKey);

      expect(notJson.status).toBe(400);
      await expect(notJson.json()).resolves.toMatchObject({
        error: { code: "invalid_request" },
      });
      expect(nothing.status).toBe(404);
      await expect(nothing.json()).resolves.toMatchObject({
        error: { code: "not_found" },
      });
    },
    TIMEOUT
  );
});
