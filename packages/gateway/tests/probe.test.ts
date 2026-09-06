import { afterEach, describe, expect, it, vi } from "vitest";
import { TIMEOUT, open, type Opened } from "./harness";

const opened: Opened[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(opened.splice(0).map((one) => one.close()));
});

async function stack(): Promise<Opened> {
  const one = await open();
  opened.push(one);
  return one;
}

describe("the gateway probe door", () => {
  it(
    "is not there unless GATEWAY_PROBE=1",
    async () => {
      vi.stubEnv("GATEWAY_PROBE", "");
      const one = await stack();
      const res = await one.app().request("/probe/models/health");
      expect(res.status).toBe(404);
    },
    TIMEOUT
  );

  it(
    "is there when GATEWAY_PROBE=1 and says so when models is unbound",
    async () => {
      vi.stubEnv("GATEWAY_PROBE", "1");
      vi.stubEnv("MODELS_URL", "");
      const one = await stack();
      const res = await one.app().request("/probe/models/health");
      expect(res.status).toBe(503);
    },
    TIMEOUT
  );
});
