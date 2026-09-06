import { describe, expect, it } from "vitest";
import { createApp, type CatalogueEntry, type Health } from "../app";
import { catalogue } from "../catalogue";
import { fakeCatalogue, fakeDetector } from "./fakes";

describe("models GET /health", () => {
  it("answers ok with its service name, runtime and memory", async () => {
    const res = await createApp(catalogue).request("/health");

    expect(res.status).toBe(200);
    const body = (await res.json()) as Health;
    expect(body).toMatchObject({
      ok: true,
      service: "models",
      onnxruntime: catalogue.onnxruntime,
    });
    expect(body.rss).toBeGreaterThan(0);
  });

  it("reports warm per Model, for this instance", async () => {
    const cold = fakeDetector("cold");
    const warmed = fakeDetector("warmed");
    await warmed.warm();
    const app = createApp(fakeCatalogue(cold, warmed));

    const { models } = (await (await app.request("/health")).json()) as Health;

    expect(models).toEqual([
      { name: "cold", version: "1", warm: false },
      { name: "warmed", version: "1", warm: true },
    ]);
  });
});

describe("models GET /models", () => {
  it("lists the Catalogue with each Model's licence id, in Catalogue order", async () => {
    const res = await createApp(catalogue).request("/models");

    expect(res.status).toBe(200);
    const body = (await res.json()) as CatalogueEntry[];
    expect(body).toEqual(
      catalogue.detectors.map((d) => ({
        name: d.model.name,
        version: d.model.version,
        kinds: d.kinds,
        licence: d.licenceId,
        warm: d.isWarm(),
      }))
    );
    expect(body.map((entry) => entry.name)).toEqual(["yunet", "dfine"]);
    expect(body.find((entry) => entry.name === "yunet")?.licence).toBe("MIT");
    expect(body.find((entry) => entry.name === "dfine")?.licence).toBe(
      "Apache-2.0"
    );
  });
});
