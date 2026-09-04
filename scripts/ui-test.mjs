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


/**
 * People, kept as state rather than as a canned answer.
 *
 * The People tab reloads its cards after every change, so a stub that always
 * said the same thing could not tell an enrolment that worked from one that did
 * nothing. This one is written to, which is what lets the test assert that a
 * deleted Person is gone from the very next listing.
 */
const people = {
  laica: [
    {
      id: "p-ada", brand: "laica", name: "Ada", createdAt: "2026-09-01T10:00:00.000Z",
      photoCount: 1,
      photos: [{
        photoId: "ph-1",
        face: { x: 0.32, y: 0.11, width: 0.24, height: 0.3 },
        format: "jpg",
        enrolledAt: "2026-09-01T10:05:00.000Z",
        consentAt: "2026-09-01T10:05:00.000Z",
      }],
    },
    {
      id: "p-linus", brand: "laica", name: "Linus", createdAt: "2026-09-02T10:00:00.000Z",
      photoCount: 0, photos: [],
    },
  ],
  hopefamily: [],
  swisshutless: [],
};

/** A photograph with several faces in it, and one with nobody in it at all. */
const CROWD = "https://example.test/crowd.jpg";
const EMPTY = "https://example.test/desert.jpg";

const CROWD_FACES = [
  { index: 0, box: { x: 0.1, y: 0.2, width: 0.12, height: 0.15 }, score: 0.99, pixels: 130 },
  { index: 1, box: { x: 0.4, y: 0.18, width: 0.13, height: 0.16 }, score: 0.98, pixels: 140 },
  { index: 2, box: { x: 0.7, y: 0.22, width: 0.11, height: 0.14 }, score: 0.97, pixels: 120 },
];

/** What the People routes answer, given the form or JSON that arrived. */
function peopleRoute(path, method, body) {
  // A GET or a DELETE names the Brand in the query; an upload carries it as a
  // form field, because the same request also carries the files.
  const brand = new URLSearchParams(path.split("?")[1] ?? "").get("brand") ?? body?.brand;
  const route = path.split("?")[0];
  const parts = route.split("/");

  if (route === "/v1/people" && method === "GET") {
    return { brand, people: people[brand] ?? [] };
  }
  if (route === "/v1/people" && method === "POST") {
    const person = {
      id: "p-" + body.name.toLowerCase(), brand: body.brand, name: body.name,
      createdAt: "2026-09-05T10:00:00.000Z", photoCount: 0, photos: [],
    };
    people[body.brand].push(person);
    return person;
  }

  const personId = parts[3];
  const person = (people[brand] ?? []).find((p) => p.id === personId);

  // /v1/people/:id
  if (parts.length === 4 && method === "DELETE") {
    people[brand] = people[brand].filter((p) => p.id !== personId);
    return { deleted: true, objects: 3 };
  }
  // /v1/people/:id/photos
  if (parts.length === 5 && method === "POST") {
    const source = body.source;
    if (source === EMPTY) {
      return { status: 400, json: { error: "No face was found in this photograph." } };
    }
    if (source === CROWD && body.faceIndex === undefined) {
      return {
        personId, name: person.name,
        results: [{
          name: source, status: "pick-a-face", width: 1200, height: 800, faces: CROWD_FACES,
        }],
      };
    }
    const photo = {
      photoId: "ph-new",
      format: "jpg",
      face: (source === CROWD ? CROWD_FACES[Number(body.faceIndex)].box
        : { x: 0.4, y: 0.2, width: 0.2, height: 0.24 }),
      enrolledAt: "2026-09-05T10:01:00.000Z",
      ...(body.consent === "true" ? { consentAt: "2026-09-05T10:01:00.000Z" } : {}),
    };
    person.photos = [...person.photos.filter((p) => p.photoId !== photo.photoId), photo];
    person.photoCount = person.photos.length;
    return { personId, name: person.name, results: [{ name: source, status: "enrolled", photo }] };
  }
  // /v1/people/:id/photos/:photoId
  if (parts.length === 6 && method === "DELETE") {
    person.photos = person.photos.filter((p) => p.photoId !== parts[5]);
    person.photoCount = person.photos.length;
    return person;
  }
  // The bytes of one Reference Photo, which have no public URL.
  if (parts.length === 6 && method === "GET") {
    return { blob: true };
  }
  return null;
}

/** Every request the page made, so the test can assert on the payloads. */
const calls = [];

function stubFetch(url, init = {}) {
  const method = init.method ?? "GET";
  // A multipart upload arrives as FormData, not as a JSON string. Duck-typed
  // rather than checked against a class, because the page builds it inside jsdom
  // and this file runs outside it.
  const form = init.body && typeof init.body.getAll === "function" ? init.body : null;
  const body = form
    ? Object.fromEntries([...form.entries()])
    : init.body ? JSON.parse(init.body) : undefined;
  // Files travel under one repeated name, which `fromEntries` would collapse to
  // the last of them — so they are read out separately.
  const files = form ? form.getAll("file").map((f) => f.name) : undefined;
  calls.push({ url, method, headers: init.headers ?? {}, body, files, multipart: !!form });

  if (url.startsWith("/v1/people")) {
    const answer = peopleRoute(url, method, body);
    if (!answer) throw new Error("test stub has no People route for " + method + " " + url);
    if (answer.status === 400) {
      return Promise.resolve({
        ok: false, status: 400, json: () => Promise.resolve(answer.json),
      });
    }
    if (answer.blob) {
      return Promise.resolve({
        ok: true, status: 200, blob: () => Promise.resolve({ size: 1 }),
      });
    }
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(answer) });
  }
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
    // The real endpoint reports the flag only when the request named an area,
    // so the stub has to be just as quiet — otherwise the card can never be
    // shown to stay clean for a Crop that asked for nothing.
    // The Annotation, in the shape src/annotations.ts stores it: two faces so
    // that "one box per face" is a count and not a coincidence.
    : url === "/v1/subjects" ? {
        source: { hash: "a".repeat(64), width: 1120, height: 1400 },
        annotatedAt: "2026-09-04T10:00:00.000Z",
        ImageRegion: [
          {
            RegionId: "face-1", RegionName: "Face 1",
            RegionBoundary: { RbShape: "rectangle", RbUnit: "relative", RbX: 0.4, RbY: 0.12, RbW: 0.25, RbH: 0.28 },
          },
          {
            RegionId: "face-2", RegionName: "Face 2",
            RegionBoundary: { RbShape: "rectangle", RbUnit: "relative", RbX: 0.1, RbY: 0.3, RbW: 0.12, RbH: 0.14 },
          },
        ],
      }
    : url === "/v1/crop" ? {
        width: body.width,
        height: body.height,
        resolvedBy: "saliency",
        url: "https://blob.test/crop.jpg",
        ...(body.subjectArea ? { subjectAreaSatisfied: body.subjectArea.x < 0.5 } : {}),
        // The real endpoint counts only when it was asked to blur, so the stub
        // is just as quiet — otherwise the card can never be shown to stay clean
        // for a Crop that asked for nothing.
        ...(body.blurUnknownFaces ? { blurred: 3 } : {}),
      }
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
    // A Reference Photo is fetched as bytes and shown through an object URL, so
    // the page never puts a token in an image address. jsdom has no object URL
    // store; a stable string is all the test needs to see that one was used.
    w.URL.createObjectURL = () => "blob:reference-photo";
  },
});
const { window } = dom;

const tick = () => new Promise((r) => window.setTimeout(r, 0));
/** The People tab awaits a fetch per Reference Photo, so it settles later. */
const settle = async () => { for (let i = 0; i < 8; i++) await tick(); };
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
check("a Crop with no Subject Area sent none", crop?.body.subjectArea === undefined);
check(
  "a Crop with no Subject Area said nothing about one on the card",
  !$(".card .meta")?.textContent.includes("Subject Area"),
  $(".card .meta")?.textContent ?? "no card",
);

// The Subject Area fields, which is the whole point of the tab for a Template
// that declares one. Filled in, they travel; the flag comes back on the card.
const areaFields = ["subjectAreaX", "subjectAreaY", "subjectAreaWidth", "subjectAreaHeight"];
check(
  "the Crop tab offers four Subject Area fields",
  areaFields.every((name) => $('[name="' + name + '"]')?.type === "number"),
);

const setArea = (values) => {
  areaFields.forEach((name, i) => { $('[name="' + name + '"]').value = values[i]; });
};
const submit = async () => {
  $("#form").dispatchEvent(new window.Event("submit", { cancelable: true, bubbles: true }));
  await tick();
  await tick();
};

setArea(["0.3", "0.35", "0.4", "0.3"]);
await submit();
const aimed = calls.filter((c) => c.url === "/v1/crop").at(-1);
check(
  "the four fields posted one Subject Area",
  JSON.stringify(aimed?.body.subjectArea) === JSON.stringify({ x: 0.3, y: 0.35, width: 0.4, height: 0.3 }),
  JSON.stringify(aimed?.body.subjectArea),
);
check("the card reported the Subject Area was satisfied", doc.body.textContent.includes("Subject Area satisfied"));

setArea(["0.6", "0.35", "0.3", "0.3"]);
await submit();
check("the card reported a Subject Area that was missed", doc.body.textContent.includes("Subject Area missed"));

// Bad input has to be caught in the page. The API would refuse it too, but a
// number the browser can see is wrong should never cost a round trip.
const refused = async (label, values, wanted) => {
  const before = calls.length;
  setArea(values);
  await submit();
  check(label, calls.length === before && ($(".err")?.textContent ?? "").includes(wanted), $(".err")?.textContent ?? "no error shown");
};

await refused("a half-filled Subject Area is refused in the page", ["0.3", "", "0.4", "0.3"], "all four");
await refused("a Subject Area above 1 is refused in the page", ["0.3", "0.3", "1.4", "0.3"], "between 0 and 1");
await refused("a Subject Area off the edge is refused in the page", ["0.8", "0.3", "0.4", "0.3"], "inside the frame");

// ----------------------------------------------------------- face blur

/**
 * The Face Blur checkbox. Two claims: unchecked it sends nothing at all, so a
 * Crop nobody asked to anonymise posts the body it always posted; checked, the
 * flag travels and the count comes back onto the card where a human can read it.
 */
const blurBox = $('[name="blurUnknownFaces"]');
check("the Crop tab offers a Blur unknown faces checkbox", blurBox?.type === "checkbox");

setArea(["", "", "", ""]);
await submit();
const unblurred = calls.filter((c) => c.url === "/v1/crop").at(-1);
check("an unchecked box sends no flag", unblurred?.body.blurUnknownFaces === undefined);
check(
  "and the card says nothing about blurring",
  !$(".card .meta")?.textContent.includes("blurred"),
  $(".card .meta")?.textContent ?? "no card",
);

blurBox.checked = true;
await submit();
const blurred = calls.filter((c) => c.url === "/v1/crop").at(-1);
check("a checked box sends blurUnknownFaces", blurred?.body.blurUnknownFaces === true);
check(
  "the card reports how many faces were blurred",
  doc.body.textContent.includes("3 faces blurred"),
  $(".card .meta")?.textContent ?? "no card",
);
blurBox.checked = false;

// ------------------------------------------------ preview subjects overlay

/**
 * The overlay is the one thing in the console that draws geometry rather than
 * showing a URL, so it is the one thing a wrong coordinate would hide. Boxes are
 * real elements positioned in per cent, which is what lets this count them and
 * read back where they were put.
 */
/** How many Crops had been made before the preview, which must make none. */
const cropsBefore = calls.filter((c) => c.url === "/v1/crop").length;

const previewButton = [...doc.querySelectorAll("button")].find((b) => b.textContent === "Preview subjects");
check("the Crop tab offers a Preview subjects button", !!previewButton);

previewButton.click();
await tick();
await tick();

const previewed = calls.filter((c) => c.url === "/v1/subjects").at(-1);
check("preview asked /v1/subjects for the Source Image", previewed?.body.source === $('[name="source"]').value);
check("preview did not crop anything", calls.filter((c) => c.url === "/v1/crop").length === cropsBefore);

const drawn = doc.querySelectorAll(".overlay .face");
check("the overlay drew one box per detected face", drawn.length === 2, String(drawn.length));
check(
  "the overlay drew the Source Image under them",
  $(".overlay img")?.getAttribute("src") === $('[name="source"]').value,
);
check(
  "a box sits where the region says it does",
  drawn[0]?.style.left === "40%" && drawn[0]?.style.top === "12%"
    && drawn[0]?.style.width === "25%" && drawn[0]?.style.height === "28%",
  drawn[0]?.getAttribute("style") ?? "no box",
);
check("each box is labelled with its region", drawn[0]?.querySelector("b")?.textContent === "Face 1");
check("the count is stated in words too", doc.body.textContent.includes("2 subjects found."));


// --------------------------------------------------------------- people tab

/**
 * The People tab, which is the one part of the console that handles personal
 * data — so what is checked here is not only that it draws, but that it draws
 * from bytes it had to ask for, records consent when the box is ticked, and does
 * not delete a Person on one click.
 */
doc.querySelector('[data-panel="people"]').click();
await settle();

check("people form drew a company select", !!$('[name="peopleBrand"]'));
check(
  "people listed as cards",
  doc.querySelectorAll("[data-person]").length === 2,
  String(doc.querySelectorAll("[data-person]").length),
);
check("a card names the Person and the photo count", doc.body.textContent.includes("Ada · 1 photo"));
check("a Person with no photos says so", doc.body.textContent.includes("Linus · 0 photos"));

const thumb = $('[data-person="p-ada"] .photos .overlay');
check("the Reference Photo is drawn", !!thumb);
check(
  "it came from the private route, not a URL on the record",
  calls.some((c) => c.url === "/v1/people/p-ada/photos/ph-1?brand=laica"),
  calls.filter((c) => c.url.startsWith("/v1/people/p-ada")).map((c) => c.url).join(" "),
);
check(
  "and it is shown through an object URL, so no token is in the address",
  thumb?.querySelector("img")?.getAttribute("src") === "blob:reference-photo",
  thumb?.querySelector("img")?.getAttribute("src") ?? "no image",
);
check(
  "the enrolled face is outlined on it",
  thumb?.querySelector(".face")?.style.left === "32%"
    && thumb?.querySelector(".face")?.style.width === "24%",
  thumb?.querySelector(".face")?.getAttribute("style") ?? "no box",
);
check("the card says whether consent was recorded", doc.body.textContent.includes("consent recorded"));

// Adding a Person: a name, and the Brand the tab is showing.
$('[name="personName"]').value = "Grace";
[...doc.querySelectorAll("button")].find((b) => b.textContent === "Add person").click();
await settle();
const added = calls.filter((c) => c.url === "/v1/people" && c.method === "POST").at(-1);
check(
  "adding a Person posted the name and the Brand",
  added?.body.name === "Grace" && added?.body.brand === "laica",
  JSON.stringify(added?.body),
);
check("the new Person appears in the list", doc.body.textContent.includes("Grace · 0 photos"));

// Enrolling by URL, with consent ticked. The request has to be multipart, since
// the same form also carries files.
$('[name="person"]').value = "p-ada";
$('[name="photoUrl"]').value = "https://example.test/portrait.jpg";
$('[name="consent"]').checked = true;
const enrolButton = [...doc.querySelectorAll("button")].find((b) => b.textContent === "Enrol photos");
enrolButton.click();
await settle();

const enrolled = calls.filter((c) => c.url.endsWith("/photos") && c.method === "POST").at(-1);
check("enrolling sent a multipart request", enrolled?.multipart === true);
check("it named the Brand and the photograph", enrolled?.body.brand === "laica"
  && enrolled?.body.source === "https://example.test/portrait.jpg", JSON.stringify(enrolled?.body));
check("the consent checkbox travelled", enrolled?.body.consent === "true", String(enrolled?.body.consent));
check("the enrolment was reported", doc.body.textContent.includes("Enrolled a face from"));
check("and the card now counts two photos", doc.body.textContent.includes("Ada · 2 photos"));

// Several faces: the caller has to pick one, and only that photograph is sent
// again — an index means something different in every picture.
$('[name="photoUrl"]').value = CROWD;
enrolButton.click();
await settle();
const boxes = doc.querySelectorAll(".pickable .face.pick");
check("a photograph with several faces offered a picker", boxes.length === 3, String(boxes.length));
check("the picker labelled each face", boxes[1]?.querySelector("b")?.textContent === "face 2");
check(
  "a picked face is not enrolled until it is clicked",
  calls.filter((c) => c.body?.faceIndex !== undefined).length === 0,
);

boxes[1].click();
await settle();
const picked = calls.filter((c) => c.url.endsWith("/photos") && c.method === "POST").at(-1);
check("clicking a face sent it by index", picked?.body.faceIndex === "1", String(picked?.body.faceIndex));
check("and only that photograph went back", picked?.body.source === CROWD, String(picked?.body.source));

// A photograph with no face is refused, and the page says why rather than
// silently doing nothing.
$('[name="photoUrl"]').value = EMPTY;
enrolButton.click();
await settle();
check(
  "a photograph with no face is reported to the user",
  ($(".err")?.textContent ?? "").includes("No face was found"),
  $(".err")?.textContent ?? "no error shown",
);

/**
 * Dropping photographs, which is how the console is meant to be used and the one
 * path a file input cannot cover: a browser will not let a page put a File into
 * an input, so dropped files are kept beside it and joined when the form is sent.
 * jsdom has no DataTransfer, so the event carries a stand-in with the one field
 * the page reads.
 */
$('[name="photoUrl"]').value = "";
const dropZone = $('[data-role="drop"]');
check("the enrol form offers somewhere to drop photographs", !!dropZone);

const dropEvent = new window.Event("drop", { bubbles: true, cancelable: true });
dropEvent.dataTransfer = {
  files: [
    new window.File(["one"], "first.jpg", { type: "image/jpeg" }),
    new window.File(["two"], "second.jpg", { type: "image/jpeg" }),
  ],
};
dropZone.dispatchEvent(dropEvent);
await tick();
check(
  "dropped photographs are counted before anything is sent",
  dropZone.textContent === "2 photographs ready",
  dropZone.textContent,
);
check(
  "and dropping sends nothing by itself",
  calls.filter((c) => c.url.endsWith("/photos") && c.method === "POST").at(-1)?.body.source
    === EMPTY,
);

enrolButton.click();
await settle();
const droppedCall = calls.filter((c) => c.url.endsWith("/photos") && c.method === "POST").at(-1);
check(
  "enrolling sends the dropped photographs as files",
  droppedCall?.multipart === true && droppedCall.files?.join(",") === "first.jpg,second.jpg",
  String(droppedCall?.files),
);
check(
  "and the queue is emptied, so the next enrolment does not send them again",
  dropZone.textContent === "or drop photographs here",
  dropZone.textContent,
);

// Deleting: irreversible, so it takes two clicks.
doc.querySelector('[data-panel="people"]').click();
await settle();
const deleteButton = [...doc.querySelectorAll('[data-person="p-linus"] button')]
  .find((b) => b.textContent === "Delete Person");
const deletesBefore = calls.filter((c) => c.method === "DELETE").length;
deleteButton.click();
await tick();
check(
  "one click on Delete Person deletes nothing",
  calls.filter((c) => c.method === "DELETE").length === deletesBefore
    && deleteButton.textContent === "Really delete?",
  deleteButton.textContent,
);
deleteButton.click();
await settle();
const deleted = calls.filter((c) => c.method === "DELETE").at(-1);
check("the second click deleted the Person", deleted?.url === "/v1/people/p-linus?brand=laica", deleted?.url ?? "none");
check(
  "and they are gone from the list",
  !doc.querySelector('[data-person="p-linus"]')
    && doc.body.textContent.includes("Deleted Linus and every photograph of them."),
  doc.querySelectorAll("[data-person]").length + " cards left",
);

// Removing one Reference Photo leaves the Person standing.
const removeButton = [...doc.querySelectorAll('[data-person="p-ada"] button')]
  .find((b) => b.textContent === "Remove");
removeButton.click();
await settle();
const removed = calls.filter((c) => c.method === "DELETE").at(-1);
check(
  "removing one photograph names the photograph",
  removed?.url === "/v1/people/p-ada/photos/ph-1?brand=laica",
  removed?.url ?? "none",
);
check("the Person is still there", doc.body.textContent.includes("Ada · 1 photo"));

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
