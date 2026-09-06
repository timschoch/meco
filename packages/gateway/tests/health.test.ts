import { afterEach, describe, expect, it, vi } from "vitest";
import { createModelsClient } from "@meco/models";
import { TIMEOUT, MODELS_URL, fakeModels, useStacks } from "./harness";
import modelsHealth from "./fixtures/models-health.json";

const stack = useStacks();
afterEach(() => vi.unstubAllEnvs());

/** A clock the test moves by hand, so the cache's TTL is a fact and not a wait. */
function clock(start = Date.parse("2026-09-06T12:00:00Z")) {
  let at = start;
  return {
    now: () => new Date(at),
    advance: (ms: number) => {
      at += ms;
    },
  };
}

describe("gateway GET /health", () => {
  it(
    "answers ok with every block and no key, and reports models unbound without a client",
    async () => {
      const one = await stack();
      const res = await one.app({ models: null }).request("/health");

      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toMatchObject({
        ok: true,
        service: "gateway",
        version: "test",
        probedAt: expect.any(String),
        models: { bound: false, reachable: false, status: null, warm: null },
        store: expect.any(Object),
        records: expect.any(Object),
      });
    },
    TIMEOUT
  );

  it(
    "reports models reachable and warm off its own /health when the binding answers",
    async () => {
      const one = await stack();
      const res = await one.app().request("/health");

      await expect(res.json()).resolves.toMatchObject({
        models: { bound: true, reachable: true, status: 200, warm: true },
      });
      expect(one.modelsSeen).toEqual(["GET /health"]);
    },
    TIMEOUT
  );

  it(
    "reports warm false while one Model on the instance has no session yet",
    async () => {
      const cold = {
        ...modelsHealth,
        models: modelsHealth.models.map((m, i) =>
          i === 0 ? { ...m, warm: false } : m
        ),
      };
      const one = await stack({ models: fakeModels({ health: cold }) });
      const res = await one.app().request("/health");

      await expect(res.json()).resolves.toMatchObject({
        models: { reachable: true, warm: false },
      });
    },
    TIMEOUT
  );

  it(
    "reports warm null and the status when models refuses, and null status when it never answers",
    async () => {
      const one = await stack();
      const refusing = createModelsClient({
        baseUrl: MODELS_URL,
        fetch: async () =>
          Response.json(
            { error: { code: "internal", message: "no" } },
            { status: 500 }
          ),
      });
      const silent = createModelsClient({
        baseUrl: MODELS_URL,
        fetch: async () => {
          throw new Error("connection refused");
        },
      });

      const refused = await one.app({ models: refusing }).request("/health");
      const unanswered = await one.app({ models: silent }).request("/health");

      await expect(refused.json()).resolves.toMatchObject({
        models: { bound: true, reachable: false, status: 500, warm: null },
      });
      await expect(unanswered.json()).resolves.toMatchObject({
        models: { bound: true, reachable: false, status: null, warm: null },
      });
    },
    TIMEOUT
  );

  it(
    "probes once for every request inside 30 s, and again after",
    async () => {
      const one = await stack();
      const time = clock();
      const app = one.app({ now: time.now });

      const first = await app.request("/health");
      time.advance(29_000);
      const second = await app.request("/health");
      expect(one.modelsSeen).toEqual(["GET /health"]);
      const firstBody = (await first.json()) as { probedAt: string };
      const secondBody = (await second.json()) as { probedAt: string };
      expect(secondBody.probedAt).toBe(firstBody.probedAt);

      time.advance(1_000);
      const third = await app.request("/health");
      expect(one.modelsSeen).toEqual(["GET /health", "GET /health"]);
      const thirdBody = (await third.json()) as { probedAt: string };
      expect(thirdBody.probedAt).not.toBe(firstBody.probedAt);
    },
    TIMEOUT
  );

  it(
    "reports both stores unconfigured without reaching a backend",
    async () => {
      vi.stubEnv("BLOB_PUBLIC_STORE_ID", "");
      vi.stubEnv("BLOB_PRIVATE_STORE_ID", "");
      const one = await stack();

      const res = await one.app().request("/health");

      await expect(res.json()).resolves.toMatchObject({
        store: {
          private: { configured: false, credential: null, roundTrip: false },
          public: { configured: false, credential: null, roundTrip: false },
        },
      });
    },
    TIMEOUT
  );

  it(
    "reports a migrated records database reachable and on the current schema",
    async () => {
      // The in-process adapter, so this asserts the block the container serves
      // without the test holding a connection to `eu-central-1`.
      const one = await stack();
      const res = await one.app().request("/health");

      const body = (await res.json()) as { records: unknown };
      expect(body.records).toMatchObject({
        configured: true,
        reachable: true,
        pending: 0,
        migrated: true,
        reason: null,
      });
    },
    TIMEOUT
  );
});
