import { createHash } from "node:crypto";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { Annotation, type Region } from "@meco/contracts";
import { createApp, ERROR_STATUS, type ErrorCode } from "../app";
import { catalogue, DECODE_BOUND, decode } from "../catalogue";
import { fakeCatalogue, fakeDetector, fakeFace } from "./fakes";
import { expectedFaces, fixture, matchGolden, MIN_IOU } from "./fixtures";

const app = createApp(catalogue);

const annotate = async (
  body: RequestInit["body"],
  query = "",
  headers: Record<string, string> = {}
) => app.request(`/annotate${query}`, { method: "POST", body, headers });

const sha256 = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");

const wireError = async (res: Response) =>
  ((await res.json()) as { error: { code: ErrorCode; message: string } }).error;

describe("POST /annotate on the crew fixture", async () => {
  const bytes = await fixture("artemis-2-crew.jpg");
  const res = await annotate(bytes);
  const body: unknown = await res.json();

  it("answers 200 with a contracts Annotation", () => {
    expect(res.status).toBe(200);
    expect(Annotation.parse(body)).toEqual(body);
  });

  it("hashes exactly the bytes it received", () => {
    expect(Annotation.parse(body).hash).toBe(sha256(bytes));
  });

  it("describes the Source Image, not the Decoded Image", async () => {
    const meta = await sharp(bytes).metadata();
    const annotation = Annotation.parse(body);
    expect(annotation.mime).toBe("image/jpeg");
    expect({ width: annotation.width, height: annotation.height }).toEqual({
      width: meta.width,
      height: meta.height,
    });
  });

  it("names yunet in producedBy and one face Region per crew member, numbered", () => {
    const annotation = Annotation.parse(body);
    expect(annotation.producedBy).toEqual([{ name: "yunet", version: "1" }]);
    expect(annotation.regions.map((r) => r.id)).toEqual([
      "face-1",
      "face-2",
      "face-3",
      "face-4",
    ]);
    for (const region of annotation.regions) {
      expect(region.kind).toBe("face");
      expect(region.landmarks).toBeDefined();
      expect(region.model).toEqual({ name: "yunet", version: "1" });
    }
  });

  it("times each stage in Server-Timing", () => {
    expect(res.headers.get("server-timing")).toMatch(
      /^decode;dur=\d+(\.\d+)?, yunet;dur=\d+(\.\d+)?$/
    );
  });
});

describe("POST /annotate honours EXIF orientation", async () => {
  // The crew fixture with its pixels turned a quarter clockwise and an EXIF
  // tag that turns them back. A viewer sees the same photograph; a decoder
  // that skips `.rotate()` sees it on its side, and no hand-marked box holds.
  const upright = await fixture("artemis-2-crew.jpg");
  const turned = await sharp(upright)
    .rotate(90)
    .jpeg({ quality: 95 })
    .withMetadata({ orientation: 8 })
    .toBuffer();
  const expected = await expectedFaces();
  const marked = expected.images.find((i) => i.file === "artemis-2-crew.jpg")!;

  it("is a fixture that is stored on its side", async () => {
    const meta = await sharp(turned).metadata();
    expect(meta.orientation).toBe(8);
    expect(meta.width).toBeGreaterThan(meta.height);
  });

  it("reports the upright size", async () => {
    const meta = await sharp(upright).metadata();
    const annotation = Annotation.parse(await (await annotate(turned)).json());
    expect({ width: annotation.width, height: annotation.height }).toEqual({
      width: meta.width,
      height: meta.height,
    });
  });

  it("finds every hand-marked face where it is in the upright photograph", async () => {
    const annotation = Annotation.parse(await (await annotate(turned)).json());
    expect(annotation.regions).toHaveLength(marked.faces.length);
    for (const match of matchGolden(marked.faces, annotation.regions)) {
      expect(match.iou, `${match.label} IoU`).toBeGreaterThanOrEqual(MIN_IOU);
      expect(match.centre, `${match.label} centre`).toBeLessThanOrEqual(
        expected.tolerance
      );
    }
  });
});

describe("the decode", () => {
  it("bounds the long edge to the Decode Bound and never enlarges", async () => {
    const big = await decode(await fixture("artemis-2-crew-full.jpg"));
    expect(Math.max(big.image.width, big.image.height)).toBe(DECODE_BOUND);
    expect({ width: big.width, height: big.height }).toEqual({
      width: 5878,
      height: 7348,
    });

    const small = await sharp({
      create: { width: 40, height: 30, channels: 3, background: "#808080" },
    })
      .png()
      .toBuffer();
    const decoded = await decode(small);
    expect(decoded.image).toMatchObject({ width: 40, height: 30, channels: 3 });
    expect(decoded.image.data).toHaveLength(40 * 30 * 3);
    expect(decoded.mime).toBe("image/png");
  });

  it("hands every adapter three channels, whatever the source had", async () => {
    const grey = await sharp({
      create: { width: 8, height: 8, channels: 3, background: "#808080" },
    })
      .greyscale()
      .png()
      .toBuffer();
    const withAlpha = await sharp({
      create: {
        width: 8,
        height: 8,
        channels: 4,
        background: { r: 128, g: 128, b: 128, alpha: 0.5 },
      },
    })
      .png()
      .toBuffer();
    for (const bytes of [grey, withAlpha]) {
      const { image } = await decode(bytes);
      expect(image.channels).toBe(3);
      expect(image.data).toHaveLength(8 * 8 * 3);
    }
  });
});

describe("POST /annotate refuses", () => {
  const refusals: [ErrorCode, () => Promise<Response>][] = [
    ["empty_body", () => annotate(null)],
    ["undecodable", () => annotate(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]))],
    [
      // A readable header on an unreadable file: metadata passes, decode fails.
      "undecodable",
      async () => annotate((await fixture("soyuz-crew.jpg")).subarray(0, 2048)),
    ],
    [
      "unknown_model",
      async () => annotate(await fixture("jezero-crater.jpg"), "?models=dfine"),
    ],
    [
      "bad_models",
      async () => annotate(await fixture("jezero-crater.jpg"), "?models="),
    ],
    [
      "bad_models",
      async () =>
        annotate(await fixture("jezero-crater.jpg"), "?models=yunet,yunet"),
    ],
    [
      "unsupported_mime",
      async () =>
        annotate(
          await sharp({
            create: { width: 8, height: 8, channels: 3, background: "#808080" },
          })
            .gif()
            .toBuffer()
        ),
    ],
    [
      "too_large",
      () =>
        annotate(new Uint8Array(16), "", {
          "content-length": String(64 * 1024 * 1024),
        }),
    ],
    [
      "too_large",
      // A stream longer than the guard, with no length declared up front.
      async () => {
        const chunk = new Uint8Array(1024 * 1024);
        let sent = 0;
        const body = new ReadableStream<Uint8Array>({
          pull(controller) {
            if (sent++ < 40) controller.enqueue(chunk);
            else controller.close();
          },
        });
        return app.request("/annotate", {
          method: "POST",
          body,
          duplex: "half",
        });
      },
    ],
  ];

  for (const [code, request] of refusals) {
    it(`${code} as ${ERROR_STATUS[code]}`, async () => {
      const res = await request();
      expect(res.status).toBe(ERROR_STATUS[code]);
      const error = await wireError(res);
      expect(error.code).toBe(code);
      expect(error.message).not.toBe("");
    });
  }

  it("does not fetch a Model it does not know: unknown_model wins over the body", async () => {
    const res = await annotate(null, "?models=dfine");
    expect((await wireError(res)).code).toBe("unknown_model");
  });

  it("model_unavailable as 503 when a session cannot be created", async () => {
    const broken = createApp(
      fakeCatalogue(fakeDetector("broken", { warmFails: true }))
    );
    const res = await broken.request("/annotate", {
      method: "POST",
      body: await fixture("jezero-crater.jpg"),
    });
    expect(res.status).toBe(503);
    expect((await wireError(res)).code).toBe("model_unavailable");
    // The stages that did finish are still timed on a refusal.
    expect(res.headers.get("server-timing")).toMatch(/^decode;dur=/);
  });

  it("internal as 500 when an adapter answers what is not a Region", async () => {
    const liar = fakeDetector("liar", {
      found: () => [
        { ...fakeFace({ name: "liar", version: "1" }), landmarks: undefined },
      ],
    });
    const res = await createApp(fakeCatalogue(liar)).request("/annotate", {
      method: "POST",
      body: await fixture("jezero-crater.jpg"),
    });
    expect(res.status).toBe(500);
    expect((await wireError(res)).code).toBe("internal");
  });
});

describe("?models= selects Catalogue entries", () => {
  const a = fakeDetector("a");
  const b = fakeDetector("b", { found: () => [] });
  const selective = createApp(fakeCatalogue(a, b));
  const post = async (query: string) =>
    Annotation.parse(
      await (
        await selective.request(`/annotate${query}`, {
          method: "POST",
          body: await fixture("jezero-crater.jpg"),
        })
      ).json()
    );

  it("runs every entry when absent", async () => {
    const { producedBy } = await post("");
    expect(producedBy.map((m) => m.name)).toEqual(["a", "b"]);
  });

  it("runs exactly the named ones, in Catalogue order", async () => {
    expect((await post("?models=b,a")).producedBy.map((m) => m.name)).toEqual([
      "a",
      "b",
    ]);
    const only = await post("?models=b");
    expect(only.producedBy.map((m) => m.name)).toEqual(["b"]);
    expect(only.regions).toEqual([]);
  });

  it("numbers the union of every adapter's Regions", async () => {
    const twice = createApp(
      fakeCatalogue(fakeDetector("a"), fakeDetector("c"))
    );
    const res = await twice.request("/annotate", {
      method: "POST",
      body: await fixture("jezero-crater.jpg"),
    });
    const { regions } = Annotation.parse(await res.json());
    expect(regions.map((r: Region) => r.id)).toEqual(["face-1", "face-2"]);
  });
});
