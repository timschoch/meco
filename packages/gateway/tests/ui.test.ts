import { records, type Records } from "@meco/records";
import { pgliteDatabase } from "@meco/records/pglite";
import { memoryStore } from "@meco/store";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../app";

const TIMEOUT = 30_000;

const opened: Records[] = [];

afterEach(async () => {
  await Promise.all(opened.splice(0).map((one) => one.close()));
});

const KEY = "sk_test_the_bootstrap_key";

async function openRecords(): Promise<Records> {
  const one = records({ database: pgliteDatabase(), store: memoryStore() });
  opened.push(one);
  await one.migrate();
  await one.brands.ensure({ id: "laica", name: "laica" });
  await one.callers.create({ name: "test", key: KEY, brands: ["laica"] });
  return one;
}

const basic = (user: string, key: string): string =>
  `Basic ${Buffer.from(`${user}:${key}`).toString("base64")}`;

describe("the gateway's /ui mount", () => {
  it(
    "answers 401 with a Basic challenge when no credential is sent",
    async () => {
      const one = await openRecords();

      const res = await createApp({
        records: one,
        store: memoryStore(),
      }).request("/ui");

      expect(res.status).toBe(401);
      expect(res.headers.get("WWW-Authenticate")).toBe('Basic realm="meco"');
    },
    TIMEOUT
  );

  it(
    "renders the Gallery for Basic, Bearer and x-auth-token alike",
    async () => {
      const one = await openRecords();
      const app = createApp({ records: one, store: memoryStore() });

      // Any user name: the key is the password and the user is ignored.
      const withBasic = await app.request("/ui", {
        headers: { Authorization: basic("anything", KEY) },
      });
      const withBearer = await app.request("/ui", {
        headers: { Authorization: `Bearer ${KEY}` },
      });
      const withHeader = await app.request("/ui", {
        headers: { "x-auth-token": KEY },
      });

      expect([withBasic.status, withBearer.status, withHeader.status]).toEqual([
        200, 200, 200,
      ]);
    },
    TIMEOUT
  );

  it(
    "refuses a key no Caller holds",
    async () => {
      const one = await openRecords();

      const res = await createApp({
        records: one,
        store: memoryStore(),
      }).request("/ui", {
        headers: { Authorization: `Bearer not-${KEY}` },
      });

      expect(res.status).toBe(401);
    },
    TIMEOUT
  );

  it(
    "takes the key from the Basic password and hands it over whole",
    async () => {
      const one = await openRecords();
      const seen: string[] = [];
      const watched: Records = {
        ...one,
        callers: {
          ...one.callers,
          byKey: async (key) => {
            seen.push(key);
            return one.callers.byKey(key);
          },
        },
      };

      await createApp({ records: watched, store: memoryStore() }).request(
        "/ui",
        { headers: { Authorization: basic("ignored-user", KEY) } }
      );

      // The user name is ignored and the password is the key, handed over
      // whole: `callers.byKey` is what hashes it, so a gateway that hashed
      // first would look a Caller up by the hash of a hash.
      expect(seen).toEqual([KEY]);
    },
    TIMEOUT
  );
});
