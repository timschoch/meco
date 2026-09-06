import { afterEach, describe, expect, it, vi } from "vitest";
import { KEY, TIMEOUT, rpc, useStacks } from "./harness";

const stack = useStacks();
afterEach(() => vi.doUnmock("@meco/compose"));

// Its own file: the mock must be in place before the first dynamic import of
// compose, and the other files load the real one.
describe("an image without compose", () => {
  it(
    "answers the one route that needs it as 503 module_unavailable on both Doors, and serves the rest",
    async () => {
      vi.doMock("@meco/compose", () => {
        throw new Error("Cannot find package 'sharp'");
      });
      const one = await stack();
      const app = one.app();

      const http = await app.request("/v1/templates", {
        headers: { Authorization: `Bearer ${KEY}` },
      });
      const body: unknown = await http.json();
      const tool = await rpc(app, {
        method: "tools/call",
        params: { name: "list_templates", arguments: {} },
      });
      const placements = await app.request("/v1/placements", {
        headers: { Authorization: `Bearer ${KEY}` },
      });

      expect(http.status).toBe(503);
      expect(body).toEqual({
        error: {
          code: "module_unavailable",
          message: "compose is not in this image yet (#183)",
        },
      });
      expect(tool.result).toMatchObject({
        isError: true,
        content: [{ type: "text", text: JSON.stringify(body) }],
      });
      expect(placements.status).toBe(200);
    },
    TIMEOUT
  );
});
