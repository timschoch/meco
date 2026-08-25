/**
 * Run the demo console in jsdom and drive it.
 *
 * The console is the one part of meco a render test cannot reach: its bugs live
 * in the browser, not in the API. This loads the exact page the server serves,
 * stubs `fetch` with what the real endpoints return, and clicks through every
 * tab — which is how `dataset` being read-only got caught the second time.
 */
import { JSDOM, VirtualConsole } from "jsdom";

const { UI_HTML } = await import("../src/ui.ts");

// -------------------------------------------------------------- API stubbing

const templates = [
  {
    id: "laica-post",
    brand: "laica",
    description: "LinkedIn image",
    suggestedPlacements: ["linkedin/post", "linkedin/wide"],
    schema: {
      type: "object",
      required: ["title"],
      properties: {
        title: { type: "string", description: "Post title" },
        excerpt: { type: "string" },
        heroImage: { type: "string", format: "uri" },
      },
    },
    example: { title: "Viel gelernt", excerpt: "Kurz.", heroImage: "https://example.test/a.png" },
  },
  {
    id: "laica-slide",
    brand: "laica",
    description: "One carousel slide",
    suggestedPlacements: ["linkedin/post"],
    schema: {
      type: "object",
      properties: {
        kind: { type: "string", enum: ["cover", "point", "quote", "outro"] },
        title: { type: "string" },
        index: { type: "integer" },
      },
    },
    example: { kind: "cover", title: "Viele kleine Schritte" },
  },
  {
    id: "hopefamily-post",
    brand: "hopefamily",
    description: "Blog card",
    suggestedPlacements: ["instagram/post"],
    schema: { type: "object", required: ["title"], properties: { title: { type: "string" }, headerImage: { type: "string" } } },
    example: { title: "Eine Woche", headerImage: "https://example.test/h.jpg" },
  },
  {
    id: "swisshutless-product",
    brand: "swisshutless",
    description: "Product post",
    suggestedPlacements: ["instagram/post"],
    schema: {
      type: "object",
      required: ["name"],
      properties: {
        name: { type: "string" },
        price: { type: "string" },
        specs: { type: "array", items: { type: "string" } },
      },
    },
    example: { name: "Kart Mini", price: "CHF 4'990.00", specs: ["Motor: BMB L-X", "Reifen: LeCont"] },
  },
];

const channels = {
  placements: [
    { id: "linkedin/post", width: 1200, height: 1200 },
    { id: "linkedin/wide", width: 1200, height: 627 },
    { id: "instagram/post", width: 1080, height: 1350 },
    { id: "instagram/story", width: 1080, height: 1920 },
  ],
};

/** Every request the page made, so the test can assert on the payloads. */
const calls = [];

function stubFetch(url, init = {}) {
  const body = init.body ? JSON.parse(init.body) : undefined;
  calls.push({ url, headers: init.headers ?? {}, body });
  const json =
    url === "/v1/templates" ? templates
    : url === "/v1/channels" ? channels
    : url === "/v1/render"
      ? { template: body.template, renders: body.channels.map((id) => ({ placement: id, width: 1, height: 1, bytes: 2048, url: "https://blob.test/" + id.replace("/", "-") + ".png" })) }
    : url === "/v1/carousel"
      ? (body.output === "images"
          ? { placement: body.channel, slides: body.slides.map((_, i) => ({ url: "https://blob.test/s" + i + ".png" })) }
          : { placement: body.channel, pages: body.slides.length, url: "https://blob.test/c.pdf" })
    : url === "/v1/crop" ? { width: body.width, height: body.height, resolvedBy: "strategy", url: "https://blob.test/crop.jpg" }
    : null;
  if (!json) throw new Error("test stub has no route for " + url);
  return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(json) });
}

// ------------------------------------------------------------------- harness

const problems = [];
const virtualConsole = new VirtualConsole();
virtualConsole.on("jsdomError", (e) => problems.push("page threw: " + e.message));
virtualConsole.on("error", (...args) => problems.push("console.error: " + args.join(" ")));

// beforeParse, because the page calls boot() as soon as its script is parsed.
const dom = new JSDOM(UI_HTML, {
  runScripts: "dangerously",
  virtualConsole,
  url: "https://meco.test/",
  beforeParse(w) {
    w.fetch = stubFetch;
  },
});
const { window } = dom;

const tick = () => new Promise((r) => window.setTimeout(r, 0));
await tick();
await tick();

const doc = window.document;
const $ = (s) => doc.querySelector(s);
const check = (name, ok, detail = "") => {
  console.log((ok ? "ok   " : "FAIL ") + name + (detail ? "  — " + detail : ""));
  if (!ok) problems.push(name);
};

// ------------------------------------------------------------- render tab

const err = $(".err");
check("no error banner on load", !err, err?.textContent?.slice(0, 120) ?? "");
check("templates loaded into the picker", $('[name="template"]')?.options.length === templates.length);

const titleInput = $('[name="title"]');
check("form built from the schema", !!titleInput);
check("form pre-filled from the example", titleInput?.value === "Viel gelernt", titleInput?.value ?? "");
check(
  "suggested placements pre-checked",
  [...doc.querySelectorAll('[data-role="placement"]')].filter((b) => b.checked).map((b) => b.value).join(",") ===
    "linkedin/post,linkedin/wide",
);

$("#form").dispatchEvent(new window.Event("submit", { cancelable: true, bubbles: true }));
await tick();
await tick();

const render = calls.find((c) => c.url === "/v1/render");
check("submit posted to /v1/render", !!render);
check("payload carried the template", render?.body.template === "laica-post");
check("payload carried both placements", render?.body.channels.join(",") === "linkedin/post,linkedin/wide");
check("payload carried the form data", render?.body.data.title === "Viel gelernt" && render?.body.data.heroImage === "https://example.test/a.png");
check("results rendered as cards", doc.querySelectorAll(".card img").length === 2);

// Switching template must rebuild the form, including enum and array inputs.
const pick = $('[name="template"]');
pick.value = "swisshutless-product";
pick.dispatchEvent(new window.Event("change"));
await tick();
check("array field became a textarea", $('[name="specs"]')?.tagName === "TEXTAREA");
check("array example joined by line", $('[name="specs"]')?.value === "Motor: BMB L-X\nReifen: LeCont");

$("#form").dispatchEvent(new window.Event("submit", { cancelable: true, bubbles: true }));
await tick();
await tick();
const productCall = calls.filter((c) => c.url === "/v1/render").at(-1);
check("array field posted as an array", Array.isArray(productCall?.body.data.specs) && productCall.body.data.specs.length === 2);

pick.value = "laica-slide";
pick.dispatchEvent(new window.Event("change"));
await tick();
check("enum field became a select", $('[name="kind"]')?.tagName === "SELECT");
check("enum pre-selected from the example", $('[name="kind"]')?.value === "cover");

// ----------------------------------------------------------- carousel tab

doc.querySelector('[data-panel="carousel"]').click();
await tick();
check("carousel form drew", !!$('[name="slides"]'));
$("#form").dispatchEvent(new window.Event("submit", { cancelable: true, bubbles: true }));
await tick();
await tick();
const carousel = calls.find((c) => c.url === "/v1/carousel");
check("carousel posted parsed slides", Array.isArray(carousel?.body.slides) && carousel.body.slides.length === 3);
check("carousel result shown", doc.body.textContent.includes("3-page PDF"));

// --------------------------------------------------------------- crop tab

doc.querySelector('[data-panel="crop"]').click();
await tick();
check("crop form drew", !!$('[name="source"]'));
$("#form").dispatchEvent(new window.Event("submit", { cancelable: true, bubbles: true }));
await tick();
await tick();
const crop = calls.find((c) => c.url === "/v1/crop");
check("crop posted numeric size", crop?.body.width === 1080 && crop?.body.height === 1920);

// ------------------------------------------------------------------- token

check(
  "requests carried the bearer token",
  calls.every((c) => !c.headers.authorization || c.headers.authorization.startsWith("Bearer ")),
);

console.log(problems.length ? `\n${problems.length} FAILED` : "\nUI OK");
process.exit(problems.length ? 1 : 0);
