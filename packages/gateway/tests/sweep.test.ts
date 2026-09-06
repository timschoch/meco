// `/internal/sweep`: the door a Vercel cron knocks on, and the only route that
// answers to something other than a Caller.
import { describe, expect, it } from "vitest";
import { CRON_SECRET, KEY, TIMEOUT, countingSweep, useStacks } from "./harness";

const stack = useStacks();

const cron = { Authorization: `Bearer ${CRON_SECRET}` };

describe("the Sweep on /internal/sweep", () => {
  it(
    "runs the Sweep once with the cron's secret and answers the Sweep Report",
    async () => {
      const one = await stack();
      const { records, swept } = countingSweep(one);
      const now = new Date("2026-09-06T04:00:00.000Z");
      const app = one.app({ records, cronSecret: CRON_SECRET, now: () => now });

      const res = await app.request("/internal/sweep", {
        method: "POST",
        headers: cron,
      });

      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toEqual({
        sweptAt: now.toISOString(),
        retentionDays: 30,
        files: [],
        keys: [],
      });
      // The clock the app was built with, not the wall clock: the Sweep
      // measures the Retention Window from `now()`.
      expect(swept).toEqual([now]);
    },
    TIMEOUT
  );

  it(
    "refuses a request with no header as 401 and never sweeps",
    async () => {
      const one = await stack();
      const { records, swept } = countingSweep(one);
      const app = one.app({ records, cronSecret: CRON_SECRET });

      const res = await app.request("/internal/sweep", { method: "POST" });

      expect(res.status).toBe(401);
      expect(res.headers.get("WWW-Authenticate")).toBeNull();
      await expect(res.json()).resolves.toEqual({
        error: { code: "unauthorized", message: expect.any(String) },
      });
      expect(swept).toEqual([]);
    },
    TIMEOUT
  );

  it(
    "refuses a header that merely starts with the secret, and one that is a prefix of it",
    async () => {
      const one = await stack();
      const { records, swept } = countingSweep(one);
      const app = one.app({ records, cronSecret: CRON_SECRET });

      const wrong = [
        `Bearer ${CRON_SECRET}-and-more`,
        `Bearer ${CRON_SECRET.slice(0, -1)}`,
        `Bearer ${CRON_SECRET.toUpperCase()}`,
        `Basic ${Buffer.from(`cron:${CRON_SECRET}`).toString("base64")}`,
      ];
      const answers = await Promise.all(
        wrong.map(async (Authorization) => {
          const res = await app.request("/internal/sweep", {
            method: "POST",
            headers: { Authorization },
          });
          return res.status;
        })
      );

      expect(answers).toEqual([401, 401, 401, 401]);
      expect(swept).toEqual([]);
    },
    TIMEOUT
  );

  it(
    "never lets a Caller's key through: /internal is not behind the Caller",
    async () => {
      const one = await stack();
      const { records, swept } = countingSweep(one);
      const app = one.app({ records, cronSecret: CRON_SECRET });

      const res = await app.request("/internal/sweep", {
        method: "POST",
        headers: { Authorization: `Bearer ${KEY}` },
      });

      expect(res.status).toBe(401);
      expect(swept).toEqual([]);
    },
    TIMEOUT
  );

  it(
    "does not exist without a cron secret: 404, with the header and without it",
    async () => {
      const one = await stack();
      const { records, swept } = countingSweep(one);
      const app = one.app({ records });

      const answers = await Promise.all(
        [cron, {}].map(async (headers) => {
          const res = await app.request("/internal/sweep", {
            method: "POST",
            headers,
          });
          return { status: res.status, body: await res.json() };
        })
      );

      for (const answer of answers) {
        expect(answer.status).toBe(404);
        expect(answer.body).toEqual({
          error: { code: "not_found", message: expect.any(String) },
        });
      }
      expect(swept).toEqual([]);
    },
    TIMEOUT
  );

  it(
    "sweeps on POST only: a GET with the secret is 404 and runs nothing",
    async () => {
      const one = await stack();
      const { records, swept } = countingSweep(one);
      const app = one.app({ records, cronSecret: CRON_SECRET });

      const res = await app.request("/internal/sweep", { headers: cron });

      expect(res.status).toBe(404);
      expect(swept).toEqual([]);
    },
    TIMEOUT
  );
});
