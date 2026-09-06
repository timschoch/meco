import { describe, expect, it } from "vitest";
import { createModelsClient, type ModelsErrorCode } from "@meco/models";
import { fixtureAnnotation } from "./annotations";
import {
  HELD,
  KEY,
  MODELS_URL,
  PHOTOS,
  TIMEOUT,
  fakeModels,
  useStacks,
  type Opened,
} from "./harness";

const stack = useStacks();

const FILE = "artemis-2-crew.jpg";

async function annotate(one: Opened, overrides?: Parameters<Opened["app"]>[0]) {
  const res = await one.app(overrides).request("/v1/annotate", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${KEY}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ brand: HELD[0], source: { url: `${PHOTOS}/${FILE}` } }),
  });
  return {
    status: res.status,
    body: (await res.json()) as { error?: { code: string } },
  };
}

/** A models wire that refuses `/annotate` with one wire code and its status. */
const refusing = (code: string, status: number) =>
  fakeModels({
    annotate: async () =>
      Response.json({ error: { code, message: `models says ${code}` } }, { status }),
  });

/**
 * Every `ModelsError` code, the status and code the gateway answers with
 * (spec, "Errors"), and how the wire produces it. The three that mean
 * "models did not answer" fold into `models_unavailable`; the rest travel
 * verbatim. A code the gateway itself can only cause by a bug answers 500.
 */
const TABLE: {
  code: ModelsErrorCode;
  status: number;
  wire?: string;
  models: () => ReturnType<typeof fakeModels>;
  timeoutMs?: number;
}[] = [
  { code: "empty_body", status: 500, models: () => refusing("empty_body", 400) },
  { code: "undecodable", status: 415, models: () => refusing("undecodable", 400) },
  {
    code: "unknown_model",
    status: 500,
    models: () => refusing("unknown_model", 400),
  },
  { code: "bad_models", status: 500, models: () => refusing("bad_models", 400) },
  {
    code: "unsupported_mime",
    status: 415,
    models: () => refusing("unsupported_mime", 415),
  },
  { code: "too_large", status: 413, models: () => refusing("too_large", 413) },
  {
    code: "model_unavailable",
    status: 503,
    wire: "models_unavailable",
    models: () => refusing("model_unavailable", 503),
  },
  { code: "internal", status: 502, models: () => refusing("internal", 500) },
  {
    code: "unreachable",
    status: 503,
    wire: "models_unavailable",
    models: () =>
      fakeModels({
        annotate: async () => {
          throw new Error("connection refused");
        },
      }),
  },
  {
    code: "timeout",
    status: 503,
    wire: "models_unavailable",
    models: () => fakeModels({ annotate: () => new Promise(() => {}) }),
    timeoutMs: 50,
  },
  {
    code: "bad_response",
    status: 502,
    models: () =>
      fakeModels({ annotate: async () => new Response("<html>", { status: 200 }) }),
  },
  {
    code: "hash_mismatch",
    status: 502,
    models: () =>
      fakeModels({
        annotate: async () =>
          Response.json({ ...fixtureAnnotation(FILE), hash: "0".repeat(64) }),
      }),
  },
];

describe("every models refusal on the wire, and on the Call", () => {
  for (const row of TABLE) {
    it(
      `${row.code} is ${row.status} ${row.wire ?? row.code}, and a failed Call naming models`,
      async () => {
        const wire = row.models();
        const one = await stack({ models: wire });
        const models = createModelsClient({
          baseUrl: MODELS_URL,
          fetch: wire.fetch,
          ...(row.timeoutMs === undefined ? {} : { timeoutMs: row.timeoutMs }),
        });
        const { status, body } = await annotate(one, { models });

        expect(status).toBe(row.status);
        expect(body.error?.code).toBe(row.wire ?? row.code);
        const failed = await one.records.calls.list({
          brand: HELD[0],
          status: "failed",
          limit: 10,
        });
        expect(failed.rows).toHaveLength(1);
        expect(failed.rows[0]).toMatchObject({
          error: { module: "models", code: row.code },
          request: { brand: HELD[0], source: { hash: fixtureAnnotation(FILE).hash } },
        });
        expect(failed.rows[0]?.steps.map((s) => s.name)).toEqual([
          "source.fetch",
          "records.annotations.get",
          "models.annotate",
        ]);
        // Bytes models refused are never filed.
        await expect(one.store.list("sources")).resolves.toEqual([]);
      },
      TIMEOUT
    );
  }
});

describe("the pipeline without a Catalogue", () => {
  it(
    "answers 503 models_unavailable with no models client, and /health still answers",
    async () => {
      const one = await stack();
      const { status, body } = await annotate(one, { models: null });
      expect(status).toBe(503);
      expect(body.error?.code).toBe("models_unavailable");
      const health = await one.app({ models: null }).request("/health");
      expect(health.status).toBe(200);
    },
    TIMEOUT
  );

  it(
    "retries the Catalogue on the next request while models is cold",
    async () => {
      const inner = fakeModels();
      let cold = true;
      const seen: string[] = [];
      const wire = {
        ...inner,
        seen,
        fetch: async (request: Request) => {
          const { pathname } = new URL(request.url);
          if (pathname === "/models" && cold) {
            cold = false;
            // Not even a wire error: a Catalogue the client cannot parse is
            // still no Catalogue, and the pipeline says so with one code.
            return new Response("<html>starting</html>", { status: 200 });
          }
          const res = await inner.fetch(request);
          seen.push(...inner.seen.splice(0));
          return res;
        },
      };
      const one = await stack({ models: wire });
      const app = one.app();

      const first = await annotate(one, { models: one.models });
      expect(first.status).toBe(503);
      expect(first.body.error?.code).toBe("models_unavailable");

      const res = await app.request("/v1/annotate", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${KEY}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          brand: HELD[0],
          source: { url: `${PHOTOS}/${FILE}` },
        }),
      });
      expect(res.status).toBe(200);
    },
    TIMEOUT
  );
});
