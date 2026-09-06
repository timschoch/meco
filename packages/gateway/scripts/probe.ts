// The door, against a running deployment: `MECO_URL` and `MECO_KEY` from the
// environment, one line per check, exit 1 on the first line that is not what
// the ticket promised. Where every serious prototype bug was found.
//
//   MECO_URL=https://<preview> MECO_KEY=… pnpm --filter @meco/gateway probe

// A module, so the top-level awaits below are legal; nothing imports this.
export {};

const url = process.env["MECO_URL"]?.replace(/\/+$/, "");
const key = process.env["MECO_KEY"];
if (url === undefined || url === "" || key === undefined || key === "") {
  console.error("set MECO_URL and MECO_KEY");
  process.exit(2);
}

let failed = false;
const line = (ok: boolean, text: string): void => {
  console.log(`${ok ? "ok  " : "FAIL"} ${text}`);
  if (!ok) failed = true;
};

const basic = `Basic ${Buffer.from(`meco:${key}`).toString("base64")}`;

async function get(
  path: string,
  headers: Record<string, string> = {}
): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${url}${path}`, { headers });
  const text = await res.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    // not JSON: kept as text
  }
  return { status: res.status, body };
}

async function rpc(
  method: string,
  params?: unknown
): Promise<{ status: number; result?: unknown; error?: unknown }> {
  const res = await fetch(`${url}/mcp`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const text = await res.text();
  if (!res.ok) return { status: res.status, error: text };
  const json = res.headers.get("content-type")?.includes("text/event-stream")
    ? (text
        .split("\n")
        .find((l) => l.startsWith("data:"))
        ?.slice(5)
        .trim() ?? "")
    : text;
  const message = JSON.parse(json) as { result?: unknown; error?: unknown };
  return { status: res.status, result: message.result, error: message.error };
}

const health = await get("/health");
const h = health.body as {
  ok?: boolean;
  records?: { reachable?: boolean };
  models?: { warm?: boolean | null; reachable?: boolean };
};
line(
  health.status === 200 && h.ok === true,
  `GET /health -> ${health.status}, records.reachable: ${String(h.records?.reachable)}, models.reachable: ${String(h.models?.reachable)}, models.warm: ${String(h.models?.warm)}`
);
console.log(`     ${JSON.stringify(health.body)}`);

for (const path of ["/v1/brands", "/v1/templates", "/v1/placements"]) {
  const none = await get(path);
  line(none.status === 401, `GET ${path} without a key -> ${none.status}`);
  const bearer = await get(path, { Authorization: `Bearer ${key}` });
  line(bearer.status === 200, `GET ${path} with Bearer -> ${bearer.status}`);
  const withBasic = await get(path, { Authorization: basic });
  line(
    withBasic.status === 200,
    `GET ${path} with Basic -> ${withBasic.status}`
  );
  const token = await get(path, { "x-auth-token": key });
  line(
    token.status === 200,
    `GET ${path} with x-auth-token -> ${token.status}`
  );
}
const brands = await get("/v1/brands", { Authorization: `Bearer ${key}` });
console.log(`     brands: ${JSON.stringify(brands.body)}`);

const wall = await get("/v1/templates?brand=not-a-brand-this-key-holds", {
  Authorization: `Bearer ${key}`,
});
line(
  wall.status === 403 &&
    (wall.body as { error?: { code?: string } }).error?.code ===
      "brand_not_held",
  `GET /v1/templates?brand=<not held> -> ${wall.status} ${JSON.stringify(wall.body)}`
);

const init = await rpc("initialize", {
  protocolVersion: "2025-06-18",
  capabilities: {},
  clientInfo: { name: "meco-probe", version: "0" },
});
line(
  init.status === 200 && init.result !== undefined,
  `POST /mcp initialize -> ${init.status} ${JSON.stringify((init.result as { serverInfo?: unknown })?.serverInfo)}`
);

const list = await rpc("tools/list");
const tools =
  (list.result as { tools?: { name: string }[] } | undefined)?.tools ?? [];
line(
  list.status === 200 && tools.length > 0,
  `POST /mcp tools/list -> ${list.status}, tools: ${tools.map((t) => t.name).join(", ")}`
);

const call = await rpc("tools/call", { name: "list_brands", arguments: {} });
const text = (call.result as { content?: { text?: string }[] } | undefined)
  ?.content?.[0]?.text;
line(
  call.status === 200 && text === JSON.stringify(brands.body),
  `POST /mcp tools/call list_brands -> ${call.status}, same JSON as GET /v1/brands: ${String(text === JSON.stringify(brands.body))}`
);

// annotate (#182): a public photograph by URL, twice. The first is the whole
// Catalogue over the binding; the second is the cache. `MECO_SOURCE_URL`
// overrides the default, which is the crew fixture's own source on Commons at
// a width the binding carries (docs/specs/models.md, measurement (1)).
const sourceUrl =
  process.env["MECO_SOURCE_URL"] ??
  "https://commons.wikimedia.org/wiki/Special:FilePath/Artemis_2_Crew_Portrait.jpg?width=1600";

async function post(
  path: string,
  body: unknown
): Promise<{ status: number; body: unknown; ms: number; served: string }> {
  const at = performance.now();
  const res = await fetch(`${url}${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let parsed: unknown = text;
  try {
    parsed = JSON.parse(text);
  } catch {
    // not JSON: kept as text
  }
  return {
    status: res.status,
    body: parsed,
    ms: performance.now() - at,
    // Which instance answered. `x-vercel-id` is the only place a deployment
    // names itself on an ordinary response.
    served: res.headers.get("x-vercel-id") ?? "",
  };
}

/** Every key named `facePrint` anywhere in a JSON value. */
const prints = (value: unknown): number => {
  if (Array.isArray(value)) return value.reduce((n, v) => n + prints(v), 0);
  if (typeof value === "object" && value !== null) {
    return Object.entries(value).reduce(
      (n, [k, v]) => n + (k === "facePrint" ? 1 : 0) + prints(v),
      0
    );
  }
  return 0;
};

/** The Step names off the Call View's HTML, in order. */
const stepsOn = (html: string): string[] =>
  [...html.matchAll(/class="step-name"[^>]*>([^<]+)</g)].map((m) => m[1] ?? "");

/** The first Brand this key holds. `/v1/brands` answers `{ items }` (#214). */
const firstBrand =
  (brands.body as { items?: { id: string }[] }).items?.[0]?.id ?? "laica";

type AnnotateAnswer = {
  call?: { id: string };
  annotation?: { hash: string; regions: { kind: string }[]; producedBy: unknown[] };
  error?: { code: string; message: string };
};

for (const round of ["first", "second"] as const) {
  const brand = firstBrand;
  const answer = await post("/v1/annotate", {
    brand,
    source: { url: sourceUrl },
  });
  const body = answer.body as AnnotateAnswer;
  line(
    answer.status === 200 && body.call?.id !== undefined,
    `POST /v1/annotate (${round}) -> ${answer.status} in ${answer.ms.toFixed(0)} ms, call ${body.call?.id ?? "-"}, hash ${body.annotation?.hash ?? "-"}, ${body.annotation?.regions.length ?? 0} regions, producedBy ${JSON.stringify(body.annotation?.producedBy ?? [])}`
  );
  line(prints(answer.body) === 0, `     no facePrint on the wire`);
  if (round === "second") console.log(`     ${JSON.stringify(answer.body)}`);

  if (body.call?.id !== undefined) {
    const view = await get(`/ui/calls/${body.call.id}`, { Authorization: basic });
    const steps = stepsOn(String(view.body));
    const modelsRan = steps.some((s) => s.startsWith("models."));
    // The first round may already be a hit: the deployment's database keeps
    // every photograph it has seen. The second round must be one.
    line(
      view.status === 200 && (round === "first" || !modelsRan),
      `GET /ui/calls/${body.call.id} -> ${view.status}, ${modelsRan ? "models ran" : "cache hit"}, steps: ${steps.join(", ")}`
    );
  }
}

// --- People, end to end (#185) -----------------------------------------------
//
// Create, enrol, list, erase, against the live database and the live private
// store. The photograph is a fixture one, which ADR-0003 Decision 2 says is not
// a precedent: meco has no consenting live subject yet, so the Person is
// created and erased inside this one run, exactly as identify's live acceptance
// does it (`packages/identify/tests/enrol.live.ts`). Replacing the URL with a
// consenting subject's photograph is the only change this block then needs.
//
// The last lines are the Erasure's own listing of everything that was theirs,
// and the listing after it. A run that leaves a Face Print behind fails here
// even if every line above it passed.

const PHOTOGRAPH =
  process.env["MECO_PERSON_URL"] ??
  "https://commons.wikimedia.org/wiki/Special:FilePath/Jonny_Kim_official_portrait.jpg";

async function send(
  method: string,
  path: string
): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${url}${path}`, {
    method,
    headers: { Authorization: `Bearer ${key}` },
  });
  const text = await res.text();
  let parsed: unknown = text;
  try {
    parsed = JSON.parse(text);
  } catch {
    // not JSON: kept as text
  }
  return { status: res.status, body: parsed };
}

const created = await post("/v1/people", {
  brand: firstBrand,
  name: `probe-${new Date().toISOString()}`,
});
const personId = (created.body as { id?: string }).id;
line(
  created.status === 200 && typeof personId === "string",
  `POST /v1/people -> ${created.status} ${JSON.stringify(created.body)}`
);

if (typeof personId === "string") {
  try {
    const enrolled = await post(`/v1/people/${personId}/photos`, {
      brand: firstBrand,
      source: { url: PHOTOGRAPH },
      consentAt: new Date().toISOString(),
    });
    const answer = enrolled.body as { status?: string };
    line(
      enrolled.status === 200 && answer.status === "enrolled",
      `POST /v1/people/<id>/photos -> ${enrolled.status} in ${enrolled.ms.toFixed(0)} ms ${JSON.stringify(enrolled.body)}`
    );
    line(prints(enrolled.body) === 0, "     no facePrint on the wire");

    const listed = await get(`/v1/people?brand=${firstBrand}`, {
      Authorization: `Bearer ${key}`,
    });
    const people = (listed.body as { items?: { id: string; photos: unknown[] }[] })
      .items;
    const mine = people?.find((one) => one.id === personId);
    line(
      listed.status === 200 && mine?.photos.length === 1,
      `GET /v1/people?brand=${firstBrand} -> ${listed.status}, reference photos for this Person: ${String(mine?.photos.length)}`
    );
    line(prints(listed.body) === 0, "     no facePrint on the wire");
    console.log(`     ${JSON.stringify(mine)}`);

    // The other Door, on the same rows: one table, so the tool has to answer
    // exactly what the route answered.
    const tool = await rpc("tools/call", {
      name: "list_people",
      arguments: { brand: firstBrand },
    });
    const toolText = (
      tool.result as { content?: { text?: string }[] } | undefined
    )?.content?.[0]?.text;
    line(
      tool.status === 200 && toolText === JSON.stringify(listed.body),
      `POST /mcp tools/call list_people -> ${tool.status}, same JSON as GET /v1/people: ${String(toolText === JSON.stringify(listed.body))}`
    );
  } finally {
    const erased = await send(
      "DELETE",
      `/v1/people/${personId}?brand=${firstBrand}`
    );
    const erasure = erased.body as {
      erased?: boolean;
      remaining?: unknown[];
    };
    line(
      erased.status === 200 &&
        erasure.erased === true &&
        erasure.remaining?.length === 0,
      `DELETE /v1/people/<id> -> ${erased.status} ${JSON.stringify(erased.body)}`
    );

    const after = await get(`/v1/people?brand=${firstBrand}`, {
      Authorization: `Bearer ${key}`,
    });
    const left = (after.body as { items?: { id: string }[] }).items?.find(
      (one) => one.id === personId
    );
    line(
      after.status === 200 && left === undefined,
      `GET /v1/people?brand=${firstBrand} after the Erasure -> ${after.status}, this Person is gone: ${String(left === undefined)}`
    );
  }
}

// --- the story (#183) -------------------------------------------------------
//
// The tracer bullet, against whatever this deployment holds: a Template of a
// Brand the key holds, its own example Fields, one of its Placements, and a
// public photograph. Rendered twice, so the second is a Replay.

/** What `/v1/templates` says about one Template. */
type Described = {
  id: string;
  brand: string;
  placements: string[];
  example: Record<string, unknown>;
};

/** The Steps of one Call, off the Call View's HTML, with their durations. */
const stepTimes = (html: string): string[] =>
  [
    ...html.matchAll(
      /class="step-name"[^>]*>([^<]+)<[\s\S]{0,400}?class="step-dur"[^>]*>([^<]+)</g
    ),
  ].map((m) => `${m[1] ?? ""} ${m[2] ?? ""}`);

const catalogue = await get("/v1/templates", { Authorization: `Bearer ${key}` });
const described = (catalogue.body as { items?: Described[] }).items ?? [];
// The one route that needs compose. Until #183 it was `503 module_unavailable`
// on every deployment; a 200 here is the image carrying compose's runtime.
line(
  catalogue.status === 200 && described.length > 0,
  `GET /v1/templates -> ${catalogue.status}, ${described.length} templates: ${described.map((t) => t.id).join(", ")}`
);

const wanted = process.env["MECO_TEMPLATE"] ?? "swisshutless-story";
const template = described.find((t) => t.id === wanted) ?? described[0];

/**
 * The photographs the story is rendered from, by default the two karting
 * fixtures at their own Commons originals (`fixtures/karts/LICENCE.md`), at the
 * 1600 px bound the committed copies were taken at. Public URLs, because the
 * gateway fetches them itself and holds no key for this repository.
 *
 * The first is the fixture the kart study turns on: two drivers, both visors
 * down, and YuNet finds no face, so the `kart` rung is what places the window.
 * The second has twelve faces and two karts, so the Face Report has something
 * to say.
 */
const commons = (file: string): string =>
  `https://commons.wikimedia.org/wiki/Special:FilePath/${file}?width=1600`;
const sources = process.env["MECO_STORY_URL"]
  ? [process.env["MECO_STORY_URL"]]
  : [
      commons("Giuseppe_Gnazzo_-_Kart_driver.jpg"),
      commons("Challenge_kart.JPG"),
    ];

/** What `render` and `crop` both answer. A Crop names no Placement. */
type RenderAnswer = {
  output?: {
    url: string;
    key: string;
    placement?: string;
    width: number;
    height: number;
    mime: string;
    bytes: number;
  };
  call?: { id: string; replayed: boolean };
  framing?: { resolvedBy: string; leadRegionId?: string; fallback?: string };
  faces?: {
    regionId: string;
    verdict: string;
    hidden: boolean;
    inFrame: boolean;
  }[];
  error?: { code: string; message: string };
};

/**
 * The bytes themselves, for whoever asked to see the picture. Written only
 * when `MECO_SAVE_DIR` names a folder, so an ordinary probe run writes nothing.
 */
async function save(answer: RenderAnswer | undefined): Promise<void> {
  const into = process.env["MECO_SAVE_DIR"];
  const output = answer?.output;
  if (into === undefined || into === "" || output === undefined) return;
  const fetched = await fetch(output.url);
  const name = output.key.split("/").pop() ?? "output";
  const { writeFile } = await import("node:fs/promises");
  await writeFile(`${into}/${name}`, new Uint8Array(await fetched.arrayBuffer()));
  console.log(`     saved ${into}/${name}`);
}

if (template === undefined) {
  line(false, "no Template to render: skipping the story");
} else {
  for (const source of sources) {
    console.log(`\n--- ${template.id} on ${source}`);
    let first: RenderAnswer | undefined;

    for (const round of ["first", "replay"] as const) {
      const answer = await post("/v1/render", {
        brand: template.brand,
        template: template.id,
        placement: template.placements[0],
        fields: template.example,
        source: { url: source },
      });
      const body = answer.body as RenderAnswer;
      const replayed = body.call?.replayed === true;

      line(
        answer.status === 200 && (round === "first" || replayed),
        `POST /v1/render (${round}) -> ${answer.status} in ${answer.ms.toFixed(0)} ms, replayed ${String(replayed)}, call ${body.call?.id ?? "-"}${answer.served === "" ? "" : `, served by ${answer.served}`}`
      );
      if (answer.status !== 200) {
        console.log(`     ${JSON.stringify(answer.body)}`);
        break;
      }

      const output = body.output;
      console.log(
        `     output: ${output?.url ?? "-"} (${output?.width}x${output?.height} ${output?.mime}, ${output?.bytes} bytes)`
      );
      console.log(
        `     framing: resolvedBy ${body.framing?.resolvedBy ?? "-"}, lead ${body.framing?.leadRegionId ?? "none"}, fallback ${body.framing?.fallback ?? "none"}`
      );
      console.log(
        `     faces: ${body.faces?.length ?? 0} — ${(body.faces ?? []).map((f) => `${f.regionId} ${f.verdict}${f.hidden ? " hidden" : ""}${f.inFrame ? " inFrame" : " cut"}`).join("; ") || "none"}`
      );

      if (round === "first") {
        first = body;
      } else if (output?.key !== undefined) {
        line(
          output.key === first?.output?.key,
          `     the Replay answers the same key: ${String(output.key === first?.output?.key)}`
        );
      }

      if (body.call?.id !== undefined) {
        const view = await get(`/ui/calls/${body.call.id}`, {
          Authorization: basic,
        });
        const steps = stepTimes(String(view.body));
        line(
          view.status === 200 && steps.length > 0,
          `GET /ui/calls/${body.call.id} -> ${view.status}, steps: ${steps.join(" | ")}`
        );
      }
    }

    await save(first);
  }
}

// --- the bare Crop (#184) ---------------------------------------------------
//
// The same photograph through `cut` instead of a Template: a size in, a Crop
// out, framed on whatever the ladder finds. Rendered twice, so the second is a
// Replay, and once more as a PNG, whose bytes are read back off the public URL
// — a `mime` in the answer is a claim, and the signature is the fact.

const cropSource =
  process.env["MECO_CROP_URL"] ?? commons("Giuseppe_Gnazzo_-_Kart_driver.jpg");
const CROP_SIZE = { width: 1080, height: 1350 };

console.log(`\n--- crop ${CROP_SIZE.width}x${CROP_SIZE.height} on ${cropSource}`);
let firstCrop: RenderAnswer | undefined;

for (const round of ["first", "replay"] as const) {
  const answer = await post("/v1/crop", {
    brand: firstBrand,
    source: { url: cropSource },
    ...CROP_SIZE,
  });
  const body = answer.body as RenderAnswer;
  const replayed = body.call?.replayed === true;

  line(
    answer.status === 200 && (round === "first" || replayed),
    `POST /v1/crop (${round}) -> ${answer.status} in ${answer.ms.toFixed(0)} ms, replayed ${String(replayed)}, call ${body.call?.id ?? "-"}${answer.served === "" ? "" : `, served by ${answer.served}`}`
  );
  if (answer.status !== 200) {
    console.log(`     ${JSON.stringify(answer.body)}`);
    break;
  }

  const output = body.output;
  line(
    output?.key.startsWith("crops/") === true &&
      output.width === CROP_SIZE.width &&
      output.height === CROP_SIZE.height,
    `     output: ${output?.url ?? "-"} (${output?.width}x${output?.height} ${output?.mime}, ${output?.bytes} bytes)`
  );
  console.log(
    `     framing: resolvedBy ${body.framing?.resolvedBy ?? "-"}, lead ${body.framing?.leadRegionId ?? "none"}, fallback ${body.framing?.fallback ?? "none"}`
  );
  console.log(
    `     faces: ${body.faces?.length ?? 0} — ${(body.faces ?? []).map((f) => `${f.regionId} ${f.verdict}${f.hidden ? " hidden" : ""}${f.inFrame ? " inFrame" : " cut"}`).join("; ") || "none"}`
  );

  if (round === "first") {
    firstCrop = body;
  } else if (output?.key !== undefined) {
    line(
      output.key === firstCrop?.output?.key,
      `     the Replay answers the same key: ${String(output.key === firstCrop?.output?.key)}`
    );
  }

  if (body.call?.id !== undefined) {
    const view = await get(`/ui/calls/${body.call.id}`, { Authorization: basic });
    const steps = stepTimes(String(view.body));
    line(
      view.status === 200 && steps.length > 0,
      `GET /ui/calls/${body.call.id} -> ${view.status}, steps: ${steps.join(" | ")}`
    );
  }
}

const asPng = await post("/v1/crop", {
  brand: firstBrand,
  source: { url: cropSource },
  ...CROP_SIZE,
  format: "png",
});
const pngBody = asPng.body as RenderAnswer;
line(
  asPng.status === 200 && pngBody.output?.mime === "image/png",
  `POST /v1/crop format png -> ${asPng.status}, mime ${pngBody.output?.mime ?? "-"}, ${pngBody.output?.url ?? "-"}`
);
if (pngBody.output?.url !== undefined) {
  const fetched = await fetch(pngBody.output.url);
  const head = new Uint8Array((await fetched.arrayBuffer()).slice(0, 8));
  const signature = [137, 80, 78, 71, 13, 10, 26, 10];
  line(
    fetched.ok && head.every((byte, i) => byte === signature[i]),
    `     the bytes at that URL are a PNG: ${[...head].join(" ")}`
  );
}

await save(firstCrop);

process.exit(failed ? 1 : 0);
