import { createHash } from "node:crypto";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { Annotation } from "@meco/contracts";
import { createApp, ERROR_STATUS, type ErrorCode } from "../app";
import { catalogue } from "../catalogue";
import {
  createModelsClient,
  type FetchLike,
  ModelsError,
  type ModelsErrorCode,
} from "../index";
import { fakeCatalogue, fakeDetector, fakeFace } from "./fakes";
import { fixture } from "./fixtures";

// The seam: the client over the app, with no socket between them. This is the
// pair the gateway runs in production, so a bug in either shows up here.
const client = (fetch: FetchLike, timeoutMs?: number) =>
  createModelsClient({ baseUrl: "http://models.test", fetch, timeoutMs });

const overApp = client(createApp(catalogue).fetch);

const sha256 = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");

/** The `ModelsError` a call threw, or a failure naming what it returned instead. */
async function refusal(call: Promise<unknown>): Promise<ModelsError> {
  try {
    const answer = await call;
    throw new Error(`expected a ModelsError, got ${JSON.stringify(answer)}`);
  } catch (error) {
    expect(error).toBeInstanceOf(ModelsError);
    return error as ModelsError;
  }
}

/** A fetch that answers the same thing whatever it is asked. */
const answers = (body: string, init: ResponseInit): FetchLike => {
  return () => new Response(body, init);
};

/** Two in-memory Detectors, so `?models=` has something to choose between. */
const selection = [fakeDetector("a"), fakeDetector("b")];

describe("the client over the app", async () => {
  const bytes = await fixture("artemis-2-crew.jpg");

  it("round-trips a fixture body to an Annotation", async () => {
    const annotation = await overApp.annotate(bytes);

    expect(Annotation.parse(annotation)).toEqual(annotation);
    expect(annotation.hash).toBe(sha256(bytes));
    // Every Catalogue entry, read off the Catalogue: a Model added to it is a
    // Model the client is expected to carry, not a test to edit.
    expect(annotation.producedBy).toEqual(
      catalogue.detectors.map((d) => d.model)
    );
    expect(annotation.regions).not.toHaveLength(0);
  });

  it("accepts the Annotation when the hash it was given agrees", async () => {
    const annotation = await overApp.annotate(bytes, { hash: sha256(bytes) });
    expect(annotation.hash).toBe(sha256(bytes));
  });

  it("passes `models` on, so the host runs exactly those", async () => {
    const two = client(createApp(fakeCatalogue(...selection)).fetch);
    const one = await two.annotate(bytes, { models: ["b"] });
    expect(one.producedBy.map((m) => m.name)).toEqual(["b"]);

    // Two names travel as one comma-separated value, and the host reads them
    // back in Catalogue order however the client encoded the separator.
    const both = await two.annotate(bytes, { models: ["b", "a"] });
    expect(both.producedBy.map((m) => m.name)).toEqual(["a", "b"]);
  });

  it("lists the Catalogue with each Model's licence id", async () => {
    const entries = await overApp.catalogue();
    expect(entries.map((entry) => entry.name)).toContain("yunet");
    const yunet = entries.find((entry) => entry.name === "yunet");
    expect(yunet).toMatchObject({ licence: "MIT", kinds: ["face"] });
  });

  it("reads the instance's health", async () => {
    const health = await overApp.health();
    expect(health).toMatchObject({ ok: true, service: "models" });
    expect(health.models.map((m) => m.name)).toContain("yunet");
    expect(health.rss).toBeGreaterThan(0);
  });
});

describe("the client maps every wire error to its own code", () => {
  // The whole table, straight from the host's one copy of it: a code added
  // there without a client that understands it fails here.
  for (const [code, status] of Object.entries(ERROR_STATUS)) {
    it(`${code} as ${status}`, async () => {
      const canned = client(
        answers(JSON.stringify({ error: { code, message: "no" } }), { status })
      );
      const error = await refusal(canned.annotate(new Uint8Array([1])));
      expect(error.code).toBe(code);
      expect(error.status).toBe(status);
      expect(error.message).toContain("no");
    });
  }

  it("reads the same code off the real host, not only off a canned one", async () => {
    const error = await refusal(overApp.annotate(new Uint8Array(0)));
    expect(error.code).toBe<ModelsErrorCode>("empty_body");
    expect(error.status).toBe(ERROR_STATUS.empty_body);
  });

  it("refuses a Model the Catalogue does not hold, off the real host", async () => {
    const error = await refusal(
      overApp.annotate(new Uint8Array([1]), { models: ["no-such-model"] })
    );
    expect(error.code).toBe<ModelsErrorCode>("unknown_model");
  });

  it("model_unavailable off the real host, when a session cannot be created", async () => {
    const broken = client(
      createApp(fakeCatalogue(fakeDetector("broken", { warmFails: true })))
        .fetch
    );
    const grey = await sharp({
      create: { width: 8, height: 8, channels: 3, background: "#808080" },
    })
      .png()
      .toBuffer();
    const error = await refusal(broken.annotate(grey));
    expect(error.code).toBe<ModelsErrorCode>("model_unavailable");
    expect(error.status).toBe(503);
  });
});

describe("the client refuses what it cannot vouch for", async () => {
  const bytes = new Uint8Array([1]);
  // One real Annotation, doctored below into the answers a host must never be
  // believed on: the wrong hash, and a Region the schema refuses.
  const annotation = await overApp.annotate(await fixture("jezero-crater.jpg"));
  const wrongHash = client(
    answers(JSON.stringify({ ...annotation, hash: "0".repeat(64) }), {
      status: 200,
    })
  );

  it("hash_mismatch when the Annotation's hash is not the one it was given", async () => {
    const error = await refusal(
      wrongHash.annotate(bytes, { hash: annotation.hash })
    );
    expect(error.code).toBe<ModelsErrorCode>("hash_mismatch");
    expect(error.status).toBe(200);
    expect(error.message).toContain(annotation.hash);
  });

  it("says nothing about the hash when it was given none", async () => {
    expect((await wrongHash.annotate(bytes)).hash).toBe("0".repeat(64));
  });

  it("bad_response on a body that is not an Annotation", async () => {
    const wrong = client(
      answers(JSON.stringify({ regions: [] }), { status: 200 })
    );
    const error = await refusal(wrong.annotate(bytes));
    expect(error.code).toBe<ModelsErrorCode>("bad_response");
    expect(error.status).toBe(200);
  });

  it("bad_response on a body that is not JSON at all", async () => {
    const html = client(
      answers("<html>502 Bad Gateway</html>", { status: 200 })
    );
    expect((await refusal(html.annotate(bytes))).code).toBe<ModelsErrorCode>(
      "bad_response"
    );
  });

  it("bad_response on a Region the Annotation schema refuses", async () => {
    const faceless = {
      ...annotation,
      regions: [
        {
          ...fakeFace({ name: "liar", version: "1" }),
          id: "face-1",
          landmarks: undefined,
        },
      ],
    };
    const wrong = client(answers(JSON.stringify(faceless), { status: 200 }));
    expect((await refusal(wrong.annotate(bytes))).code).toBe<ModelsErrorCode>(
      "bad_response"
    );
  });

  it("bad_response on a failure body that is not the wire's error shape", async () => {
    const wrong = client(answers("upstream connect error", { status: 502 }));
    const error = await refusal(wrong.annotate(bytes));
    expect(error.code).toBe<ModelsErrorCode>("bad_response");
    expect(error.status).toBe(502);
  });

  it("keeps a field a newer host added, rather than refusing the answer", async () => {
    // The two containers deploy together, but not in the same instant. A
    // `/health` grown one field must not read as a models that is down.
    const newer = client(
      answers(JSON.stringify({ ...(await overApp.health()), queue: 3 }), {
        status: 200,
      })
    );
    expect((await newer.health()).ok).toBe(true);
  });

  it("bad_response on a Catalogue listing that is not the wire's", async () => {
    const wrong = client(
      answers(JSON.stringify([{ name: "yunet" }]), { status: 200 })
    );
    expect((await refusal(wrong.catalogue())).code).toBe<ModelsErrorCode>(
      "bad_response"
    );
  });

  it("bad_response on a health body that is not the wire's", async () => {
    const wrong = client(
      answers(JSON.stringify({ ok: true }), { status: 200 })
    );
    expect((await refusal(wrong.health())).code).toBe<ModelsErrorCode>(
      "bad_response"
    );
  });
});

describe("the client when models does not answer", () => {
  const bytes = new Uint8Array([1]);

  // A models that never answers and ignores the signal, which is the case
  // `timeoutMs` has to hold on its own: were the client only passing the
  // signal on, this call would hang for as long as the process lives.
  const hang: FetchLike = () => new Promise<Response>(() => {});

  it("unreachable, with no status, when the call itself fails", async () => {
    const dead: FetchLike = () => {
      throw new TypeError("fetch failed");
    };
    const error = await refusal(client(dead).annotate(bytes));
    expect(error.code).toBe<ModelsErrorCode>("unreachable");
    expect(error.status).toBeUndefined();
    expect(error.cause).toBeInstanceOf(TypeError);
  });

  it("timeout, not unreachable, when it hangs past timeoutMs", async () => {
    const error = await refusal(client(hang, 50).annotate(bytes));
    expect(error.code).toBe<ModelsErrorCode>("timeout");
    expect(error.status).toBeUndefined();
    expect(error.message).toContain("50ms");
  });

  it("times every route out, not only annotate", async () => {
    expect(
      (await refusal(client(hang, 50).health())).code
    ).toBe<ModelsErrorCode>("timeout");
    expect(
      (await refusal(client(hang, 50).catalogue())).code
    ).toBe<ModelsErrorCode>("timeout");
  });
});

describe("the client's shape", () => {
  it("is what the codes are, and nothing more", () => {
    const wire: ErrorCode[] = Object.keys(ERROR_STATUS) as ErrorCode[];
    const local: ModelsErrorCode[] = [
      "unreachable",
      "timeout",
      "bad_response",
      "hash_mismatch",
    ];
    // A wire code and a local code must never collide: the caller reads one
    // `code` and cannot tell which side refused if the words are shared.
    expect(wire.filter((code) => (local as string[]).includes(code))).toEqual(
      []
    );
  });
});
