import { describe, expect, it } from "vitest";
import { createApp } from "../app";

describe("models GET /health", () => {
  it("answers ok with its service name", async () => {
    const res = await createApp().request("/health");

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      ok: true,
      service: "models",
    });
  });
});
