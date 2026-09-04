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

const brands = [
  { id: "laica", name: "Laica" },
  { id: "hopefamily", name: "Hope Family" },
  { id: "swisshutless", name: "Swiss Hutless" },
];

const gallery = [
  { key: "renders/laica/linkedin/post/a.png", url: "https://blob.test/a.png", bytes: 4096, createdAt: "2026-08-25T10:00:00.000Z", kind: "render", brand: "laica", placement: "linkedin/post" },
  { key: "carousels/laica/linkedin/post/b.pdf", url: "https://blob.test/b.pdf", bytes: 8192, createdAt: "2026-08-24T10:00:00.000Z", kind: "carousel", brand: "laica", placement: "linkedin/post" },
  { key: "renders/swisshutless/instagram/story/c.png", url: "https://blob.test/c.png", bytes: 2048, createdAt: "2026-08-23T10:00:00.000Z", kind: "render", brand: "swisshutless", placement: "instagram/story" },
  { key: "crops/d.jpg", url: "https://blob.test/d.jpg", bytes: 1024, createdAt: "2026-08-22T10:00:00.000Z", kind: "crop" },
];

/** Every request the page made, so the test can assert on the payloads. */
const calls = [];

function stubFetch(url, init = {}) {
  const body = init.body ? JSON.parse(init.body) : undefined;
  calls.push({ url, headers: init.headers ?? {}, body });
  const [path, query] = url.split("?");
  const params = new URLSearchParams(query ?? "");
  const wanted = params.get("brand");
  const wantedPlacement = params.get("placement");
  const json =
    path === "/v1/templates" ? templates
    : path === "/v1/channels" ? channels
    : path === "/v1/brands" ? brands
    : path === "/v1/gallery"
      ? (() => {
          const items = gallery
            .filter((i) => !wanted || i.brand === wanted)
            .filter((i) => !wantedPlacement || i.placement === wantedPlacement);
          return { total: items.length, items };
        })()
    : url === "/v1/render"
      ? { template: body.template, renders: body.channels.map((id) => ({ placement: id, width: 1, height: 1, bytes: 2048, url: "https://blob.test/" + id.replace("/", "-") + ".png" })) }
    : url === "/v1/carousel"
      ? (body.output === "images"
          ? { placement: body.channel, slides: body.slides.map((_, i) => ({ url: "https://blob.test/s" + i + ".png" })) }
          : { placement: body.channel, pages: body.slides.length, url: "https://blob.test/c.pdf" })
    : url === "/v1/crop" ? { width: body.width, height: body.height, resolvedBy: "saliency", url: "https://blob.test/crop.jpg" }
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
check("crop card named the producer that framed it", doc.body.textContent.includes("1080×1920 · saliency"));

// ------------------------------------------------------------ gallery tab

doc.querySelector('[data-panel="gallery"]').click();
await tick();
await tick();
check("gallery filter drew every brand plus All", $('[name="brand"]')?.options.length === brands.length + 1);
check("gallery listed everything", doc.querySelectorAll(".card").length === gallery.length);
check("gallery skipped the image for a PDF", doc.querySelectorAll(".card img").length === gallery.length - 1);
check("gallery captioned with brand and placement", doc.body.textContent.includes("laica · linkedin/post"));
check("placement filter offered every placement plus All", $('[name="placement"]')?.options.length === channels.placements.length + 1);

const brandPick = $('[name="brand"]');
brandPick.value = "swisshutless";
brandPick.dispatchEvent(new window.Event("change"));
await tick();
await tick();
const filtered = calls.filter((c) => c.url.startsWith("/v1/gallery")).at(-1);
check("filter asked the API for one brand", filtered?.url === "/v1/gallery?brand=swisshutless");
check("filtered gallery drew one card", doc.querySelectorAll(".card").length === 1);

// Both filters at once, and the picked brand must survive the second change.
const placementPick = $('[name="placement"]');
placementPick.value = "instagram/story";
placementPick.dispatchEvent(new window.Event("change"));
await tick();
await tick();
const both = calls.filter((c) => c.url.startsWith("/v1/gallery")).at(-1);
check("both filters went to the API", both?.url === "/v1/gallery?brand=swisshutless&placement=instagram%2Fstory", both?.url ?? "");
check("both filters kept the one match", doc.querySelectorAll(".card").length === 1);

// A filter that matches nothing must say so rather than draw an empty grid.
brandPick.value = "hopefamily";
brandPick.dispatchEvent(new window.Event("change"));
await tick();
await tick();
check("empty result explained", doc.body.textContent.includes("Nothing stored for that filter."));

// Leaving the Gallery and coming back keeps what was picked.
doc.querySelector('[data-panel="render"]').click();
await tick();
doc.querySelector('[data-panel="gallery"]').click();
await tick();
check("filters survived a tab switch", $('[name="brand"]')?.value === "hopefamily" && $('[name="placement"]')?.value === "instagram/story");

// ------------------------------------------------------------------- token

check(
  "requests carried the bearer token",
  calls.every((c) => !c.headers.authorization || c.headers.authorization.startsWith("Bearer ")),
);

console.log(problems.length ? `\n${problems.length} FAILED` : "\nUI OK");
process.exit(problems.length ? 1 : 0);
