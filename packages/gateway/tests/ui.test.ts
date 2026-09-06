import type { Records } from "@meco/records";
import { describe, expect, it } from "vitest";
import { KEY, TIMEOUT, basic, useStacks } from "./harness";

const stack = useStacks();

describe("the gateway's /ui mount", () => {
  it(
    "answers 401 with a Basic challenge when no credential is sent",
    async () => {
      const one = await stack();
      const res = await one.app().request("/ui");

      expect(res.status).toBe(401);
      expect(res.headers.get("WWW-Authenticate")).toBe('Basic realm="meco"');
    },
    TIMEOUT
  );

  it(
    "renders the Gallery for Basic, Bearer and x-auth-token alike",
    async () => {
      const one = await stack();
      const app = one.app();

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
      const one = await stack();
      const res = await one.app().request("/ui", {
        headers: { Authorization: `Bearer not-${KEY}` },
      });

      expect(res.status).toBe(401);
    },
    TIMEOUT
  );

  it(
    "takes the key from the Basic password and hands it over whole",
    async () => {
      const one = await stack();
      const seen: string[] = [];
      const watched: Records = {
        ...one.records,
        callers: {
          ...one.records.callers,
          byKey: async (key) => {
            seen.push(key);
            return one.records.callers.byKey(key);
          },
        },
      };

      await one.app({ records: watched }).request("/ui", {
        headers: { Authorization: basic("ignored-user", KEY) },
      });

      // The user name is ignored and the password is the key, handed over
      // whole: `callers.byKey` is what hashes it, so a gateway that hashed
      // first would look a Caller up by the hash of a hash.
      expect(seen).toEqual([KEY]);
    },
    TIMEOUT
  );
});
