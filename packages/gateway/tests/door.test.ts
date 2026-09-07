import { describe, expect, it } from "vitest";
import {
  BRANDS,
  HELD,
  KEY,
  NOT_HELD,
  TIMEOUT,
  basic,
  rpc,
  useStacks,
  watchingPeopleList,
} from "./harness";

const stack = useStacks();

const heldRows = BRANDS.filter((b) =>
  (HELD as readonly string[]).includes(b.id)
);

describe("the Caller at the HTTP Door", () => {
  it(
    "refuses a request with no key as 401 unauthorized, and offers no browser prompt",
    async () => {
      const { app } = await stack();
      const res = await app().request("/v1/brands");

      expect(res.status).toBe(401);
      expect(res.headers.get("WWW-Authenticate")).toBeNull();
      await expect(res.json()).resolves.toEqual({
        error: { code: "unauthorized", message: expect.any(String) },
      });
    },
    TIMEOUT
  );

  it(
    "refuses a key no Caller holds",
    async () => {
      const { app } = await stack();
      const res = await app().request("/v1/brands", {
        headers: { Authorization: `Bearer not-${KEY}` },
      });
      expect(res.status).toBe(401);
    },
    TIMEOUT
  );

  it(
    "reaches the same Caller from Bearer, Basic and x-auth-token",
    async () => {
      const { app } = await stack();
      const built = app();
      const forms: Record<string, string>[] = [
        { Authorization: `Bearer ${KEY}` },
        { Authorization: basic("anyone", KEY) },
        { "x-auth-token": KEY },
      ];
      const answers = await Promise.all(
        forms.map(async (headers) => {
          const res = await built.request("/v1/brands", { headers });
          return { status: res.status, body: await res.json() };
        })
      );
      for (const answer of answers) {
        expect(answer.status).toBe(200);
        expect(answer.body).toEqual({
          // `redaction: null` on every Brand: none has set a default, and
          // `null` is not `false` — the policy falls to meco's default.
          items: heldRows.map(({ id, name }) => ({ id, name, redaction: null })),
        });
      }
    },
    TIMEOUT
  );

  it(
    "leaves /health open",
    async () => {
      const { app } = await stack();
      const res = await app().request("/health");
      expect(res.status).toBe(200);
    },
    TIMEOUT
  );

  it(
    "keeps the Basic challenge under /ui only",
    async () => {
      const { app } = await stack();
      const res = await app().request("/ui");
      expect(res.status).toBe(401);
      expect(res.headers.get("WWW-Authenticate")).toBe('Basic realm="meco"');
    },
    TIMEOUT
  );
});

describe("the Brand Wall", () => {
  it(
    "refuses a Brand the Caller does not hold with 403 brand_not_held before any module runs",
    async () => {
      const one = await stack();
      const { records, listed } = watchingPeopleList(one);
      const app = one.app({ records });

      const res = await app.request(`/v1/people?brand=${NOT_HELD}`, {
        headers: { Authorization: `Bearer ${KEY}` },
      });

      expect(res.status).toBe(403);
      await expect(res.json()).resolves.toEqual({
        error: { code: "brand_not_held", message: expect.any(String) },
      });
      expect(listed).toEqual([]);
    },
    TIMEOUT
  );

  it(
    "stands before the schema: a Brand not held is 403 even when the rest of the input is wrong",
    async () => {
      const one = await stack();
      const res = await one.app().request("/v1/crop", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${KEY}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ brand: NOT_HELD, width: "wide" }),
      });
      expect(res.status).toBe(403);
    },
    TIMEOUT
  );

  it(
    "is the same wall on the MCP Door: a tool error carrying the same JSON",
    async () => {
      const one = await stack();
      const res = await one.app().request(`/v1/templates?brand=${NOT_HELD}`, {
        headers: { Authorization: `Bearer ${KEY}` },
      });
      const http: unknown = await res.json();

      const answer = await rpc(one.app(), {
        method: "tools/call",
        params: { name: "list_templates", arguments: { brand: NOT_HELD } },
      });

      expect(answer.status).toBe(200);
      expect(answer.result).toMatchObject({
        isError: true,
        content: [{ type: "text", text: JSON.stringify(http) }],
      });
    },
    TIMEOUT
  );

  it(
    "lists every Brand the Caller holds when the request names none",
    async () => {
      const one = await stack();
      const { records, listed } = watchingPeopleList(one);
      const app = one.app({ records });

      const res = await app.request("/v1/people", {
        headers: { Authorization: `Bearer ${KEY}` },
      });

      expect(res.status).toBe(200);
      expect(listed).toEqual([...HELD]);
    },
    TIMEOUT
  );

  it(
    "refuses a Caller with no key on the MCP Door as HTTP 401, before JSON-RPC",
    async () => {
      const one = await stack();
      const answer = await rpc(one.app(), { method: "tools/list" }, {});
      expect(answer.status).toBe(401);
    },
    TIMEOUT
  );
});
