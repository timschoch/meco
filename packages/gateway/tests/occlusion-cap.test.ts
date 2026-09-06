// Its own file, because the mock has to be in place before the app graph
// loads and every other file renders on the real compose.
import { templates } from "@meco/compose";
import { MAX_OCCLUSION_ZONES } from "@meco/contracts";
import { describe, expect, it, vi } from "vitest";
import { fixtureBytes, sha256 } from "./annotations";
import { KEY, PHOTOS, TIMEOUT, useStacks } from "./harness";

/**
 * compose, with a Plan that declares one Occlusion Zone more than the contract
 * allows.
 *
 * No shipped Template emits seventeen and none should — the cap is a design
 * bound on frame's O(n⁴) free-area sweep, decided on #82 — so the only honest
 * way to reach it is to hand the pipeline a Plan that does. Everything else is
 * the real compose, so what refuses the request is the contracts schema and
 * nothing this file wrote.
 */
vi.mock("@meco/compose", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@meco/compose")>();
  return {
    ...actual,
    plan: async (input: Parameters<typeof actual.plan>[0]) => ({
      ...(await actual.plan(input)),
      occlusion: Array.from(
        { length: MAX_OCCLUSION_ZONES + 1 },
        (_unused, i) => ({ x: i / 100, y: 0, width: 0.01, height: 0.01 })
      ),
    }),
  };
});

const stack = useStacks();

const FILE = "artemis-2-crew.jpg";
const BRAND = "hopefamily";
const TEMPLATE = "hopefamily-story";

describe("a Plan with more Occlusion Zones than the contract allows", () => {
  it(
    `is 400 invalid_request at ${MAX_OCCLUSION_ZONES + 1} zones, before frame runs`,
    async () => {
      const one = await stack();
      const fields = templates(BRAND).find((t) => t.id === TEMPLATE)?.example;
      const res = await one.app().request("/v1/render", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${KEY}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          brand: BRAND,
          template: TEMPLATE,
          placement: "instagram/story",
          fields,
          source: { url: `${PHOTOS}/${FILE}` },
        }),
      });
      const body = (await res.json()) as { error?: { code: string } };
      const calls = await one.records.calls.list({ brand: BRAND, limit: 10 });

      expect(res.status).toBe(400);
      expect(body.error?.code).toBe("invalid_request");
      // A failed Call is a row, and its Steps stop where the contract did.
      expect(calls.rows[0]).toMatchObject({ status: "failed", kind: "render" });
      expect(calls.rows[0]?.steps.map((s) => s.name)).not.toContain(
        "frame.crop"
      );
      expect(calls.rows[0]?.sourceHash).toBe(sha256(fixtureBytes(FILE)));
    },
    TIMEOUT
  );
});
