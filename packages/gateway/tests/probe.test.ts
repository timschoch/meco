import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../app";

const probeEnv = { GATEWAY_PROBE: "1" };

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("the gateway probe door", () => {
  it("is not there unless GATEWAY_PROBE=1", async () => {
    vi.stubEnv("GATEWAY_PROBE", "");
    const res = await createApp().request("/probe/models/health");
    expect(res.status).toBe(404);
  });

  it("is there when GATEWAY_PROBE=1 and says so when models is unbound", async () => {
    vi.stubEnv("GATEWAY_PROBE", probeEnv.GATEWAY_PROBE);
    vi.stubEnv("MODELS_URL", "");
    const res = await createApp().request("/probe/models/health");
    expect(res.status).toBe(503);
  });
});
