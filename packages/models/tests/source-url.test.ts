// The second body shape of `POST /annotate`: a JSON `{ url }` the host fetches
// for itself, because the platform refuses a body over 4.5 MB between two
// container services (#201). Every fetch here is injected, so nothing in this
// file reaches a network.
import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { Annotation } from "@meco/contracts";
import { createApp, ERROR_STATUS, type ErrorCode } from "../app";
import { catalogue } from "../catalogue";
import { fakeCatalogue, fakeDetector } from "./fakes";
import { fixture } from "./fixtures";

/** What a Signed URL looks like from here: an https URL nothing dereferences. */
const SIGNED = "https://store.test/sources/deadbeef.jpg?sig=abc&exp=1";

const sha256 = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");

const wireError = async (res: Response) =>
  ((await res.json()) as { error: { code: ErrorCode; message: string } }).error;

/** A fetch that hands the same answer back whatever it is asked for. */
const answering = (answer: () => Response) =>
  vi.fn<typeof globalThis.fetch>(async () => answer());

/** `POST /annotate` with the JSON body, as the gateway sends it. */
const byUrl = async (
  app: ReturnType<typeof createApp>,
  body: unknown = { url: SIGNED },
  query = ""
): Promise<Response> =>
  app.request(`/annotate${query}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

describe("POST /annotate with a { url } body", async () => {
  const bytes = await fixture("artemis-2-crew.jpg");

  it("answers the same Annotation the bytes body answers, hashed on what it fetched", async () => {
    const fetch = answering(() => new Response(bytes));
    const app = createApp(catalogue, { fetch });

    const res = await byUrl(app, { url: SIGNED }, "?models=yunet");
    expect(res.status).toBe(200);
    const annotation = Annotation.parse(await res.json());

    expect(annotation.hash).toBe(sha256(bytes));
    expect(annotation.mime).toBe("image/jpeg");
    expect(annotation.regions).not.toHaveLength(0);
    expect(fetch).toHaveBeenCalledOnce();
    expect(String(fetch.mock.calls[0]?.[0])).toBe(SIGNED);
  });

  it("times the fetch beside the decode and the Models, and says how many hops it took", async () => {
    const app = createApp(catalogue, {
      fetch: answering(() => new Response(bytes)),
    });
    const res = await byUrl(app, { url: SIGNED }, "?models=yunet");
    // `hops` is a parameter of the fetch stage, never a stage of its own: a
    // count read as milliseconds would be a number with the wrong unit.
    expect(res.headers.get("server-timing")).toMatch(
      /^fetch;dur=[\d.]+;hops=1, decode;dur=[\d.]+, yunet;dur=[\d.]+$/
    );
  });

  it("counts every hop a redirect added", async () => {
    let served = false;
    const app = createApp(catalogue, {
      fetch: vi.fn<typeof globalThis.fetch>(async () => {
        if (served) return new Response(bytes);
        served = true;
        return new Response(null, {
          status: 302,
          headers: { location: "https://store.test/moved.jpg" },
        });
      }),
    });
    const res = await byUrl(app, { url: SIGNED }, "?models=yunet");
    expect(res.status).toBe(200);
    expect(res.headers.get("server-timing")).toMatch(/^fetch;dur=[\d.]+;hops=2,/);
  });

  it("fetches nothing when the Models named are not in the Catalogue", async () => {
    const fetch = answering(() => new Response(bytes));
    const res = await byUrl(
      createApp(catalogue, { fetch }),
      { url: SIGNED },
      "?models=nonesuch"
    );
    expect((await wireError(res)).code).toBe("unknown_model");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("still reads a raw-bytes body when no JSON content type is set", async () => {
    const fetch = answering(() => new Response(bytes));
    const res = await createApp(catalogue, { fetch }).request(
      "/annotate?models=yunet",
      { method: "POST", body: bytes }
    );
    expect(Annotation.parse(await res.json()).hash).toBe(sha256(bytes));
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("POST /annotate with a { url } body refuses", async () => {
  const bytes = await fixture("jezero-crater.jpg");
  const ok = () => new Response(bytes);

  const refusals: [ErrorCode, string, () => Promise<Response>][] = [
    [
      "bad_source",
      "a JSON body that names no url",
      () => byUrl(createApp(catalogue, { fetch: answering(ok) }), {}),
    ],
    [
      "bad_source",
      "a url that is not https",
      () =>
        byUrl(createApp(catalogue, { fetch: answering(ok) }), {
          url: "http://store.test/sources/a.jpg",
        }),
    ],
    [
      "bad_source",
      "a field beside the url",
      () =>
        byUrl(createApp(catalogue, { fetch: answering(ok) }), {
          url: SIGNED,
          key: "sources/a.jpg",
        }),
    ],
    [
      "bad_source",
      "a body that is not JSON at all",
      () => byUrl(createApp(catalogue, { fetch: answering(ok) }), "not json"),
    ],
    [
      "source_unfetchable",
      "an expired Signed URL, which the store answers 403",
      () =>
        byUrl(
          createApp(catalogue, {
            fetch: answering(() => new Response("expired", { status: 403 })),
          })
        ),
    ],
    [
      "source_unfetchable",
      "a key the store does not hold, which it answers 404",
      () =>
        byUrl(
          createApp(catalogue, {
            fetch: answering(() => new Response("missing", { status: 404 })),
          })
        ),
    ],
    [
      "source_unfetchable",
      "a URL that does not answer at all",
      () =>
        byUrl(
          createApp(catalogue, {
            fetch: vi.fn<typeof globalThis.fetch>(() =>
              Promise.reject(new Error("ECONNREFUSED"))
            ),
          })
        ),
    ],
    [
      "source_unfetchable",
      "a URL that answers no bytes",
      () =>
        byUrl(
          createApp(catalogue, {
            fetch: answering(() => new Response(new Uint8Array(0))),
          })
        ),
    ],
    [
      "source_unfetchable",
      "more redirects than the host follows",
      () =>
        byUrl(
          createApp(catalogue, {
            fetch: answering(
              () =>
                new Response(null, {
                  status: 302,
                  headers: { location: "https://store.test/again.jpg" },
                })
            ),
          })
        ),
    ],
    [
      "too_large",
      "a fetched body that declares more than the guard",
      () =>
        byUrl(
          createApp(catalogue, {
            fetch: answering(
              () =>
                new Response(bytes, {
                  headers: { "content-length": String(64 * 1024 * 1024) },
                })
            ),
          })
        ),
    ],
    [
      "too_large",
      "a fetched body longer than the guard with no length declared",
      () => {
        const chunk = new Uint8Array(1024 * 1024);
        let sent = 0;
        const stream = new ReadableStream<Uint8Array>({
          pull(controller) {
            if (sent++ < 40) controller.enqueue(chunk);
            else controller.close();
          },
        });
        return byUrl(
          createApp(catalogue, {
            fetch: answering(() => new Response(stream)),
          })
        );
      },
    ],
    [
      "undecodable",
      "bytes that are no photograph",
      () =>
        byUrl(
          createApp(catalogue, {
            fetch: answering(
              () => new Response(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]))
            ),
          })
        ),
    ],
  ];

  for (const [code, what, request] of refusals) {
    it(`${code} as ${ERROR_STATUS[code]} on ${what}`, async () => {
      const res = await request();
      expect(res.status).toBe(ERROR_STATUS[code]);
      const error = await wireError(res);
      expect(error.code).toBe(code);
      expect(error.message).not.toBe("");
    });
  }

  // An abandoned body holds the connection open while the far side keeps
  // sending, and the bodies this host abandons are the large ones.
  for (const [what, headers] of [
    ["by the length it declares", { "content-length": String(64 * 1024 * 1024) }],
    ["by the stream, with no length declared", {}],
  ] as const) {
    it(`cancels a body it refuses ${what}`, async () => {
      let cancelled = false;
      let sent = 0;
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (sent++ < 64) controller.enqueue(new Uint8Array(1024 * 1024));
          else controller.close();
        },
        cancel() {
          cancelled = true;
        },
      });

      const res = await byUrl(
        createApp(catalogue, {
          fetch: answering(() => new Response(body, { headers })),
        })
      );
      expect(res.status).toBe(ERROR_STATUS.too_large);
      expect(cancelled).toBe(true);
    });
  }

  it("refuses a redirect off https without ever dereferencing it", async () => {
    // The http hop serves a perfectly good photograph, so a host that followed
    // it would answer 200 — and would have pulled the photograph over the wire
    // in clear. Only refusing every hop, and not merely the first, is red here.
    const fetch = vi.fn<typeof globalThis.fetch>(async (input) => {
      const at = String(input instanceof Request ? input.url : input);
      if (at.startsWith("https:")) {
        return new Response(null, {
          status: 302,
          headers: { location: "http://store.test/a.jpg" },
        });
      }
      return new Response(bytes);
    });

    const res = await byUrl(createApp(catalogue, { fetch }));
    expect(res.status).toBe(ERROR_STATUS.source_unfetchable);
    expect((await wireError(res)).code).toBe("source_unfetchable");
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("names the status the URL answered, so an expired URL is told from a missing key", async () => {
    const app = createApp(fakeCatalogue(fakeDetector("a")), {
      fetch: answering(() => new Response("expired", { status: 403 })),
    });
    expect((await wireError(await byUrl(app))).message).toContain("403");
  });
});
