import { describe, expect, it, vi } from "vitest";
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
