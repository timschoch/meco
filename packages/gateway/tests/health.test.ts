import { describe, expect, it, vi } from "vitest";
import { memoryStore } from "@meco/store";
import { records } from "@meco/records";
import { pgliteDatabase } from "@meco/records/pglite";
import { createApp } from "../app";

describe("gateway GET /health", () => {
  it("answers ok and reports that models is unbound without MODELS_URL", async () => {
    const res = await createApp().request("/health");

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      ok: true,
      service: "gateway",
      models: { bound: false, reachable: false, status: null },
    });
  });
});

describe("gateway GET /health with the models binding injected", () => {
  it("reports models reachable when the binding answers", async () => {
    const seen: string[] = [];
    vi.stubEnv("MODELS_URL", "http://models.internal");
    vi.stubGlobal("fetch", async (input: URL) => {
      seen.push(input.toString());
      return new Response(null, { status: 200 });
    });

    const res = await createApp().request("/health");

    await expect(res.json()).resolves.toMatchObject({
      models: { bound: true, reachable: true, status: 200 },
    });
    expect(seen).toEqual(["http://models.internal/health"]);

    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });
});

describe("gateway GET /health with neither store configured", () => {
  it("reports both stores unconfigured without reaching a backend", async () => {
    vi.stubEnv("BLOB_PUBLIC_STORE_ID", "");
    vi.stubEnv("BLOB_PRIVATE_STORE_ID", "");
    vi.stubGlobal("fetch", () => {
      throw new Error("no call should leave the process");
    });

    const res = await createApp().request("/health");

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      ok: true,
      store: {
        private: { configured: false, credential: null, roundTrip: false },
        public: { configured: false, credential: null, roundTrip: false },
      },
    });

    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });
});

describe("gateway GET /health with no records database", () => {
  it("reports records unconfigured without reaching one", async () => {
    vi.stubGlobal("fetch", () => {
      throw new Error("no call should leave the process");
    });

    const res = await createApp().request("/health");

    await expect(res.json()).resolves.toMatchObject({
      records: {
        configured: false,
        reachable: false,
        serverVersion: null,
        pending: null,
        migrated: null,
        roundTripMs: null,
      },
    });

    vi.unstubAllGlobals();
  });
});

describe("gateway GET /health with a migrated records database", () => {
  it("reports it reachable and on the current schema", async () => {
    // The in-process adapter, so this asserts the block the container serves
    // without the test holding a connection to `eu-central-1`.
    const database = pgliteDatabase();
    const opened = records({ database, store: memoryStore() });
    await opened.migrate();

    try {
      const res = await createApp({ records: opened }).request("/health");

      const body = (await res.json()) as {
        records: { reachable: boolean; pending: number; migrated: boolean };
      };
      expect(body.records).toMatchObject({
        configured: true,
        reachable: true,
        pending: 0,
        migrated: true,
        reason: null,
      });
    } finally {
      await opened.close();
    }
    // Booting PGlite costs more than Vitest's default five seconds under the
    // load of a full `pnpm check`.
  }, 30_000);
});
