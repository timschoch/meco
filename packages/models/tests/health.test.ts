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
    expect(body).toEqual([
      ...catalogue.detectors.map((d) => ({
        name: d.model.name,
        version: d.model.version,
        kinds: d.kinds,
        licence: d.licenceId,
        warm: d.isWarm(),
      })),
      // An Enricher draws no Region of its own, so it lists no Kind.
      ...catalogue.enrichers.map((e) => ({
        name: e.model.name,
        version: e.model.version,
        kinds: [],
        licence: e.licenceId,
        warm: e.isWarm(),
      })),
    ]);
    expect(body.map((entry) => entry.name)).toEqual([
      "yunet",
      "dfine",
      "edgeface",
    ]);
    const licenceOf = (name: string) =>
      body.find((entry) => entry.name === name)?.licence;
    expect(licenceOf("yunet")).toBe("MIT");
    expect(licenceOf("dfine")).toBe("Apache-2.0");
    expect(licenceOf("edgeface")).toBe("CC-BY-NC-SA-4.0");
  });
});
