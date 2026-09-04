/**
 * A demo console for meco.
 *
 * One self-contained page, served as a string so it behaves the same in the
 * container as it does locally — no static directory to mount, nothing to
 * bundle. It calls `/v1/*` over HTTP like any other client, so what it shows is
 * exactly what a calling tool gets; the bearer token lives in the browser and
 * never in the page.
 */
export const UI_HTML = String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>meco console</title>
<style>
  :root {
    --bg: #0e1013; --panel: #171a1f; --line: #262b33; --ink: #e8eaed;
    --dim: #9aa3af; --accent: #48d597; --bad: #ff6b6b;
    font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--ink); font-size: 15px; }
  header {
    display: flex; align-items: center; gap: 16px; flex-wrap: wrap;
    padding: 14px 20px; border-bottom: 1px solid var(--line); background: var(--panel);
    position: sticky; top: 0; z-index: 5;
  }
  h1 { font-size: 17px; margin: 0; letter-spacing: -0.01em; }
  h1 span { color: var(--accent); }
  .grow { flex: 1; }
  .tabs { display: flex; gap: 4px; }
  .tab {
    padding: 6px 14px; border-radius: 999px; border: 1px solid transparent;
    background: none; color: var(--dim); cursor: pointer; font: inherit;
  }
  .tab[aria-selected="true"] { background: var(--bg); color: var(--ink); border-color: var(--line); }
  main { display: grid; grid-template-columns: minmax(320px, 420px) 1fr; gap: 0; min-height: calc(100vh - 59px); }
  @media (max-width: 860px) { main { grid-template-columns: 1fr; } }
  form { padding: 20px; border-right: 1px solid var(--line); }
  .out { padding: 20px; }
  label { display: block; margin: 0 0 12px; font-size: 13px; color: var(--dim); }
  label > span { display: block; margin-bottom: 4px; }
  input, select, textarea, button {
    font: inherit; color: var(--ink); background: var(--panel);
    border: 1px solid var(--line); border-radius: 8px; padding: 8px 10px; width: 100%;
  }
  textarea { min-height: 88px; resize: vertical; font-family: ui-monospace, SFMono-Regular, monospace; font-size: 13px; }
  button { cursor: pointer; }
  .go { background: var(--accent); color: #06281a; border-color: var(--accent); font-weight: 600; padding: 10px; }
  .go[disabled] { opacity: 0.5; cursor: progress; }
  .ghost { width: auto; padding: 5px 10px; font-size: 13px; background: none; color: var(--dim); }
  fieldset { border: 1px solid var(--line); border-radius: 8px; padding: 10px 12px; margin: 0 0 14px; }
  legend { font-size: 12px; color: var(--dim); padding: 0 4px; }
  .checks { display: flex; flex-wrap: wrap; gap: 6px 14px; }
  .checks label { display: flex; align-items: center; gap: 6px; margin: 0; color: var(--ink); font-size: 13px; }
  .checks input { width: auto; }
  .checks input[type="number"] { width: 5.5em; }
  .cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: 16px; }
  .card { border: 1px solid var(--line); border-radius: 10px; overflow: hidden; background: var(--panel); }
  .card img { display: block; width: 100%; background: #000; }
  .meta { padding: 8px 10px; font-size: 12px; color: var(--dim); word-break: break-all; }
  .meta b { color: var(--ink); font-weight: 600; }
  .meta a { color: var(--accent); }
  .note { color: var(--dim); font-size: 13px; }
  /* The Subject preview: boxes drawn over the Source Image, positioned in per
     cent so they hold wherever the picture is scaled to. */
  .overlay { position: relative; display: inline-block; max-width: 100%; line-height: 0; }
  .overlay img { display: block; width: 100%; background: #000; }
  .face { position: absolute; border: 2px solid var(--accent); border-radius: 3px; }
  .face b {
    position: absolute; left: -2px; bottom: 100%; padding: 1px 5px;
    background: var(--accent); color: #06281a; font-size: 11px; line-height: 1.5;
    border-radius: 3px 3px 0 0; white-space: nowrap; font-weight: 600;
  }
  /* A face meco cannot name. Grey rather than a second bright colour, because
     the preview is read for what is recognised: the names have to be what the
     eye lands on, and everything else has to be visibly not that. */
  .face.unknown { border-color: var(--dim); }
  .face.unknown b { background: var(--dim); color: var(--bg); }
  /* A Person card: the Reference Photos sit in a row under the name, each one an
     overlay of its own so the enrolled face can be outlined on it. */
  .photos { display: flex; flex-wrap: wrap; gap: 8px; padding: 8px 10px 10px; }
  .photos .overlay { width: 92px; }
  .drop {
    border: 1px dashed var(--line); border-radius: 8px; padding: 16px;
    margin: 0 0 12px; text-align: center; color: var(--dim); font-size: 13px;
  }
  .drop.over { border-color: var(--accent); color: var(--ink); }
  .face.pick { cursor: pointer; border-color: var(--dim); }
  .face.pick:hover { border-color: var(--accent); }
  .pickable { max-width: 520px; }
  .row { display: flex; gap: 8px; align-items: center; }
  .row .go { flex: 1; }
  .err { color: var(--bad); white-space: pre-wrap; font-family: ui-monospace, monospace; font-size: 12px; }
  .token { display: flex; gap: 6px; align-items: center; }
  .token input { width: 220px; }
</style>
</head>
<body>
<header>
  <h1>meco <span>console</span></h1>
  <div class="tabs" role="tablist">
    <button class="tab" role="tab" data-panel="render" aria-selected="true">Render</button>
    <button class="tab" role="tab" data-panel="carousel" aria-selected="false">Carousel</button>
    <button class="tab" role="tab" data-panel="crop" aria-selected="false">Crop</button>
    <button class="tab" role="tab" data-panel="people" aria-selected="false">People</button>
    <button class="tab" role="tab" data-panel="gallery" aria-selected="false">Gallery</button>
  </div>
  <div class="grow"></div>
  <div class="token">
    <input id="token" type="password" placeholder="MECO_TOKEN" autocomplete="off">
    <button class="ghost" id="save-token">Save</button>
  </div>
</header>

<main>
  <form id="form"></form>
  <div class="out" id="out"><p class="note">Pick a template and hit Render.</p></div>
</main>

<!-- A classic script, not a module: nothing here imports, and it lets the
     jsdom test in scripts/ui-test.mjs execute this exact page. -->
<script>
const $ = (s) => document.querySelector(s);
const out = $("#out");
let templates = [];
let channels = { placements: [] };
let brands = [];
let panel = "render";
// Survives a tab switch, so coming back to the Gallery keeps the filters.
let galleryBrand = "";
let galleryPlacement = "";
let peopleBrand = "";
let cropBrand = "";

// ------------------------------------------------------------------ plumbing

const tokenBox = $("#token");
tokenBox.value = localStorage.getItem("meco-token") ?? "";
$("#save-token").onclick = () => {
  localStorage.setItem("meco-token", tokenBox.value.trim());
  boot();
};

async function call(path, body) {
  const token = tokenBox.value.trim();
  const res = await fetch(path, {
    method: body ? "POST" : "GET",
    headers: {
      ...(token ? { authorization: "Bearer " + token } : {}),
      ...(body ? { "content-type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const json = await res.json().catch(() => ({ error: res.status + " " + res.statusText }));
  if (!res.ok) {
    const err = new Error(JSON.stringify(json, null, 2));
    err.status = res.status;
    throw err;
  }
  return json;
}

/**
 * A request that is not a JSON POST: a multipart upload, or a delete.
 *
 * Kept beside "call" rather than folded into it, because the one thing this must
 * not do is set a content type. A FormData body carries a boundary the browser
 * generates, and naming the type by hand overwrites it with one that has no
 * boundary in it — the request then arrives as a form with no parts.
 */
async function send(path, method, body) {
  const token = tokenBox.value.trim();
  const res = await fetch(path, {
    method,
    headers: { ...(token ? { authorization: "Bearer " + token } : {}) },
    ...(body ? { body } : {}),
  });
  const json = await res.json().catch(() => ({ error: res.status + " " + res.statusText }));
  if (!res.ok) {
    const err = new Error(json.error ?? JSON.stringify(json, null, 2));
    err.status = res.status;
    throw err;
  }
  return json;
}

/**
 * A picture that has no public URL, as one the page can show.
 *
 * A Reference Photo is private in the store, so nothing serves it from its own
 * address: meco hands the bytes over only to a caller carrying the token, and an
 * "img" tag cannot carry a header. So the page fetches the bytes itself and
 * points the tag at an object URL — which keeps the token out of the address bar
 * and out of any log, where a token in a query string would end up.
 */
async function privateImage(path) {
  const token = tokenBox.value.trim();
  const res = await fetch(path, {
    headers: { ...(token ? { authorization: "Bearer " + token } : {}) },
  });
  if (!res.ok) throw new Error("Could not load the Reference Photo: " + res.status);
  return URL.createObjectURL(await res.blob());
}

function el(tag, attrs = {}, ...kids) {
  // dataset is a read-only accessor, so Object.assign throws on it; its keys
  // have to be written one at a time.
  const { dataset, ...rest } = attrs;
  const n = Object.assign(document.createElement(tag), rest);
  if (dataset) for (const [k, v] of Object.entries(dataset)) n.dataset[k] = v;
  for (const k of kids) n.append(k);
  return n;
}

function field(name, node, hint) {
  const l = el("label");
  l.append(el("span", { textContent: hint ? name + " — " + hint : name }), node);
  return l;
}

// ------------------------------------------------------- schema-driven inputs

/** One input per schema property, so a new Template needs no change here. */
function inputsFor(schema) {
  const required = new Set(schema.required ?? []);
  return Object.entries(schema.properties ?? {}).map(([key, spec]) => {
    const label = key + (required.has(key) ? " *" : "");
    let node;
    if (spec.enum) {
      node = el("select", { name: key });
      for (const v of spec.enum) node.append(el("option", { value: v, textContent: v }));
    } else if (spec.type === "array") {
      node = el("textarea", { name: key, dataset: { kind: "lines" }, placeholder: "one per line" });
    } else if (spec.type === "integer" || spec.type === "number") {
      node = el("input", { name: key, type: "number", dataset: { kind: "number" } });
    } else if ((spec.maxLength ?? 200) > 120 || key === "excerpt" || key === "body") {
      node = el("textarea", { name: key });
    } else {
      node = el("input", { name: key, type: "text" });
    }
    return field(label, node, spec.description);
  });
}

/** Read the generated inputs back into the shape the API expects. */
function readData(form) {
  const data = {};
  for (const node of form.querySelectorAll("[name]")) {
    if (node.dataset.role) continue;
    const raw = node.value.trim();
    if (!raw) continue;
    if (node.dataset.kind === "number") data[node.name] = Number(raw);
    else if (node.dataset.kind === "lines") data[node.name] = raw.split("\n").map((s) => s.trim()).filter(Boolean);
    else data[node.name] = raw;
  }
  return data;
}

function fill(form, values) {
  for (const [key, value] of Object.entries(values ?? {})) {
    const node = form.querySelector('[name="' + key + '"]');
    if (node) node.value = Array.isArray(value) ? value.join("\n") : String(value);
  }
}

// ------------------------------------------------------------------- results

function show(nodes) {
  out.replaceChildren(...nodes);
}

function card(url, caption, isPdf) {
  const c = el("div", { className: "card" });
  if (!isPdf) c.append(el("img", { src: url, loading: "lazy" }));
  const meta = el("div", { className: "meta" });
  meta.append(el("b", { textContent: caption }), el("br"), el("a", { href: url, target: "_blank", textContent: url }));
  c.append(meta);
  return c;
}

function fail(err) {
  show([el("p", { className: "err", textContent: err.message })]);
}

function note(text) {
  return el("p", { className: "note", textContent: text });
}

/**
 * A fraction as a per cent, rounded before it is written: 0.28 * 100 is
 * 28.000000000000004 in binary floating point, and a stylesheet should not
 * carry that.
 */
function pc(n) {
  return +(n * 100).toFixed(4) + "%";
}

/**
 * One outlined box over a picture, positioned in fractions of it.
 *
 * Per cent rather than a canvas, for the same reason the Crop tab's overlay uses
 * it: a box is already a fraction, so it stays right at whatever width the
 * picture is shown at, and it is a real element the jsdom test can count.
 */
function faceBox(box, label, className) {
  const node = el("div", {
    className: className ? "face " + className : "face",
    style: "left:" + pc(box.x) + ";top:" + pc(box.y) + ";"
      + "width:" + pc(box.width) + ";height:" + pc(box.height),
  });
  if (label) node.append(el("b", { textContent: label }));
  return node;
}

// --------------------------------------------------------------------- forms

function renderForm() {
  const form = $("#form");
  form.replaceChildren();

  const pick = el("select", { name: "template", dataset: { role: "control" } });
  for (const t of templates) pick.append(el("option", { value: t.id, textContent: t.id + " — " + t.description }));
  form.append(field("Template", pick));

  const places = el("fieldset");
  places.append(el("legend", { textContent: "Placements" }));
  const checks = el("div", { className: "checks" });
  for (const p of channels.placements) {
    const box = el("input", { type: "checkbox", value: p.id, dataset: { role: "placement" } });
    const l = el("label");
    l.append(box, document.createTextNode(p.id + " " + p.width + "×" + p.height));
    checks.append(l);
  }
  places.append(checks);
  form.append(places);

  const body = el("div");
  form.append(body);

  const go = el("button", { className: "go", type: "submit", textContent: "Render" });
  form.append(go);

  function load() {
    const t = templates.find((x) => x.id === pick.value);
    body.replaceChildren(...inputsFor(t.schema));
    fill(form, t.example);
    for (const box of form.querySelectorAll('[data-role="placement"]')) {
      box.checked = t.suggestedPlacements.includes(box.value);
    }
  }
  pick.onchange = load;
  load();

  form.onsubmit = async (e) => {
    e.preventDefault();
    const channelsPicked = [...form.querySelectorAll('[data-role="placement"]')].filter((b) => b.checked).map((b) => b.value);
    if (!channelsPicked.length) return fail(new Error("Pick at least one Placement."));
    go.disabled = true;
    show([el("p", { className: "note", textContent: "Rendering …" })]);
    try {
      const res = await call("/v1/render", { template: pick.value, channels: channelsPicked, data: readData(form) });
      show([el("div", { className: "cards" }, ...res.renders.map((r) =>
        card(r.url, r.placement + " · " + r.width + "×" + r.height + " · " + Math.round(r.bytes / 1024) + " KB")))]);
    } catch (err) { fail(err); } finally { go.disabled = false; }
  };
}

function carouselForm() {
  const form = $("#form");
  form.replaceChildren();

  const channel = el("select", { name: "channel", dataset: { role: "control" } });
  for (const p of channels.placements) channel.append(el("option", { value: p.id, textContent: p.id }));
  channel.value = "linkedin/post";
  form.append(field("Placement", channel));

  const output = el("select", { name: "output", dataset: { role: "control" } });
  output.append(el("option", { value: "pdf", textContent: "pdf — LinkedIn" }));
  output.append(el("option", { value: "images", textContent: "images — Instagram" }));
  form.append(field("Output", output));

  const cover = templates.find((t) => t.id === "laica-slide").example;
  const slides = el("textarea", {
    name: "slides",
    dataset: { role: "control" },
    style: "min-height:320px",
    value: JSON.stringify([
      { template: "laica-slide", data: cover },
      { template: "laica-slide", data: { kind: "point", index: 1, total: 2, title: "Marketing ist schwierig", body: "Der Rücklauf auf kalte Nachrichten bleibt dünn." } },
      { template: "laica-slide", data: { kind: "outro", title: "Schreib uns", cta: "laica.dev" } },
    ], null, 2),
  });
  form.append(field("Slides", slides, "each Slide names its own Template"));

  const go = el("button", { className: "go", type: "submit", textContent: "Build carousel" });
  form.append(go);

  form.onsubmit = async (e) => {
    e.preventDefault();
    go.disabled = true;
    show([el("p", { className: "note", textContent: "Rendering …" })]);
    try {
      const res = await call("/v1/carousel", {
        channel: channel.value,
        output: output.value,
        slides: JSON.parse(slides.value),
      });
      const items = res.slides
        ? res.slides.map((s, i) => card(s.url, "slide " + (i + 1)))
        : [card(res.url, res.pages + "-page PDF · " + res.placement, true)];
      show([el("div", { className: "cards" }, ...items)]);
    } catch (err) { fail(err); } finally { go.disabled = false; }
  };
}

function cropForm() {
  const form = $("#form");
  form.replaceChildren();

  const source = el("input", { name: "source", type: "url", value: templates.find((t) => t.id === "hopefamily-post").example.headerImage });
  form.append(field("Source Image", source, "any public image URL"));

  const width = el("input", { name: "width", type: "number", value: "1080" });
  const height = el("input", { name: "height", type: "number", value: "1920" });
  form.append(field("Width", width), field("Height", height));

  // The Brand, and with it the People meco may recognise in the picture. Left at
  // "none" no matching happens at all — which is not the same as matching that
  // found nobody, and the two must not be spelt the same way in the form.
  const brand = el("select", { name: "brand", dataset: { role: "control" } });
  brand.append(el("option", { value: "", textContent: "none — do not recognise anyone" }));
  for (const b of brands) brand.append(el("option", { value: b.id, textContent: b.name }));
  brand.value = cropBrand;
  form.append(field("Company", brand, "whose People may be recognised"));

  /**
   * What the Crop is pinned on, with the Brand's People spelt out by name.
   *
   * A Person is an option here rather than a second field, because "pin on
   * Sarah" and "pin on whoever is recognised" and "pin on the biggest face" are
   * one decision with several answers, and a form that split them would let a
   * caller ask for two at once.
   */
  const pinTo = el("select", { name: "pinTo", dataset: { role: "control" } });
  form.append(field("Pin to", pinTo, "what the frame belongs to"));

  function fillPinTo(people) {
    const chosen = pinTo.value;
    pinTo.replaceChildren(
      el("option", { value: "", textContent: "whatever the picture offers" }),
      ...(brand.value
        ? [
            el("option", { value: "person", textContent: "anyone this company knows" }),
            ...people.map((p) =>
              el("option", { value: "person:" + p.id, textContent: p.name })),
          ]
        : []),
      el("option", { value: "faces", textContent: "the largest face, whoever it is" }),
      el("option", { value: "attention", textContent: "the most salient area" }),
    );
    // Keeping the choice across a Brand change is worth a line, but only when it
    // still exists: a Person of the Brand that was just deselected does not.
    if ([...pinTo.options].some((o) => o.value === chosen)) pinTo.value = chosen;
  }

  fillPinTo([]);

  const anchor = el("select", { name: "anchor" });
  anchor.append(el("option", { value: "", textContent: "let the image decide (attention)" }));
  for (const a of ["center", "top", "bottom", "left", "right", "top-left", "top-right", "bottom-left", "bottom-right"]) {
    anchor.append(el("option", { value: a, textContent: a }));
  }
  form.append(field("Crop Anchor", anchor));

  // The Subject Area, as four fractions of the result. Left blank it is absent
  // and the golden grid frames the Crop, which is what the tab always did.
  const area = el("fieldset");
  area.append(el("legend", { textContent: "Subject Area — fractions of the result, 0–1, all four or none" }));
  const areaFields = el("div", { className: "checks" });
  const areaInput = (key, label) => {
    const input = el("input", { name: "subjectArea" + key, type: "number", step: "0.01", min: "0", max: "1", placeholder: label });
    areaFields.append(field(label, input));
    return input;
  };
  const areaX = areaInput("X", "x");
  const areaY = areaInput("Y", "y");
  const areaW = areaInput("Width", "width");
  const areaH = areaInput("Height", "height");
  area.append(areaFields);
  form.append(area);

  /**
   * The Subject Area the four fields describe, or null for none.
   *
   * Throws rather than silently dropping a half-filled area: a caller who typed
   * three numbers meant something by them, and a Crop that ignored them would
   * look like the feature is broken rather than the input.
   */
  function readSubjectArea() {
    const raw = [areaX, areaY, areaW, areaH].map((i) => i.value.trim());
    if (raw.every((v) => !v)) return null;
    if (raw.some((v) => !v)) throw new Error("Give all four Subject Area fields, or none.");
    const [x, y, w, h] = raw.map(Number);
    if ([x, y, w, h].some((n) => !Number.isFinite(n) || n < 0 || n > 1)) {
      throw new Error("Every Subject Area field must be a number between 0 and 1.");
    }
    if (w <= 0 || h <= 0) throw new Error("A Subject Area needs a width and a height above 0.");
    if (x + w > 1 || y + h > 1) {
      throw new Error("A Subject Area must lie inside the frame: x + width and y + height must not exceed 1.");
    }
    return { x, y, width: w, height: h };
  }

  // Face Blur, as the one checkbox the option deserves. Unchecked it is not sent
  // at all rather than sent as false, so a Crop nobody asked to anonymise posts
  // the body it always posted. It goes in a checks row like the Placement boxes,
  // which is what keeps a checkbox from being stretched to the form's width.
  const blur = el("input", { name: "blurUnknownFaces", type: "checkbox" });
  const blurLabel = el("label");
  blurLabel.append(blur, document.createTextNode("Blur unknown faces — hide every face meco cannot name"));
  form.append(el("div", { className: "checks" }, blurLabel));

  const go = el("button", { className: "go", type: "submit", textContent: "Crop" });
  // "Preview subjects" is deliberately beside Crop and not inside it: seeing what
  // meco found in the picture is the step before choosing a shape, and it costs
  // no Crop — the Annotation it draws is the same one the Crop is framed from.
  const preview = el("button", { className: "ghost", type: "button", textContent: "Preview subjects" });
  form.append(el("div", { className: "row" }, go, preview));

  /**
   * The Source Image with one box per detected face drawn over it.
   *
   * Absolutely positioned elements in per cent rather than a canvas: the boxes
   * are fractions of the image, so per cent is the unit they are already in, and
   * they stay right at whatever width the picture is shown at. It also means the
   * overlay is real elements — the jsdom test in scripts/ui-test.mjs can count
   * them, which it could not do with pixels painted into a canvas.
   */
  function overlay(url, regions, matches) {
    const named = new Map((matches ?? []).map((m) => [m.regionId, m]));
    const wrap = el("div", { className: "overlay" });
    wrap.append(el("img", { src: url }));
    for (const region of regions) {
      const b = region.RegionBoundary;
      const match = named.get(region.RegionId);
      // Green with a name is a Person meco will keep sharp and may pin on; grey
      // is a stranger, and the one Face Blur hides. The colour is the whole
      // point of the preview — it is where a human checks meco's answer before
      // a picture is published on the strength of it.
      const box = el("div", {
        className: match ? "face" : "face unknown",
        style: "left:" + pc(b.RbX) + ";top:" + pc(b.RbY) + ";"
          + "width:" + pc(b.RbW) + ";height:" + pc(b.RbH),
      });
      box.append(el("b", {
        textContent: match ? match.name + " · " + match.score.toFixed(2) : region.RegionName,
      }));
      wrap.append(box);
    }
    return wrap;
  }

  preview.onclick = async () => {
    preview.disabled = true;
    show([el("p", { className: "note", textContent: "Looking for subjects …" })]);
    try {
      const res = await call("/v1/subjects", {
        source: source.value,
        ...(brand.value ? { brand: brand.value } : {}),
      });
      const regions = res.ImageRegion ?? [];
      const matches = res.matches ?? [];
      show([
        el("p", { className: "note", textContent:
          regions.length + (regions.length === 1 ? " subject found." : " subjects found.")
          + (res.matches
            ? " " + (matches.length
              ? matches.map((m) => m.name).join(", ") + " recognised."
              : "Nobody recognised.")
            : "")
          + (res.warnings ? " " + res.warnings.join(" ") : "") }),
        overlay(source.value, regions, matches),
      ]);
    } catch (err) { fail(err); } finally { preview.disabled = false; }
  };

  form.onsubmit = async (e) => {
    e.preventDefault();
    let subjectArea;
    try {
      subjectArea = readSubjectArea();
    } catch (err) { return fail(err); }
    go.disabled = true;
    show([el("p", { className: "note", textContent: "Cropping …" })]);
    try {
      const pin = pinTo.value;
      const res = await call("/v1/crop", {
        source: source.value,
        width: Number(width.value),
        height: Number(height.value),
        ...(brand.value ? { brand: brand.value } : {}),
        // A named Person is still "pin to a person"; which person rides in
        // "persons", because that is the field that narrows and not a second
        // kind of pinning.
        ...(pin ? { pinTo: pin.startsWith("person:") ? "person" : pin } : {}),
        ...(pin.startsWith("person:") ? { persons: [pin.slice("person:".length)] } : {}),
        ...(anchor.value ? { anchor: anchor.value } : { strategy: "attention" }),
        ...(subjectArea ? { subjectArea } : {}),
        ...(blur.checked ? { blurUnknownFaces: true } : {}),
      });
      const how = res.resolvedBy
        + (res.fallback ? " · fell back: " + res.fallback : "")
        + (res.matches === undefined ? ""
          : res.matches.length
            ? " · " + res.matches.map((m) => m.name + " " + m.score.toFixed(2)).join(", ")
            : " · nobody recognised")
        + (res.subjectAreaSatisfied === undefined ? ""
          : res.subjectAreaSatisfied ? " · Subject Area satisfied" : " · Subject Area missed")
        + (res.blurred === undefined ? ""
          : " · " + res.blurred + (res.blurred === 1 ? " face blurred" : " faces blurred"));
      show([el("div", { className: "cards" }, card(res.url, res.width + "×" + res.height + " · " + how))]);
    } catch (err) { fail(err); } finally { go.disabled = false; }
  };

  /**
   * The Brand's People, fetched when a Brand is chosen and not before.
   *
   * A Person's name is personal data, so the Crop tab asks for none until the
   * operator has said which company they are working for. A failure to load
   * leaves the select with its Brand-independent options rather than an error
   * across the page: the tab still crops, it simply cannot offer a name.
   */
  brand.onchange = async () => {
    cropBrand = brand.value;
    if (!brand.value) return fillPinTo([]);
    try {
      fillPinTo((await call("/v1/people?brand=" + encodeURIComponent(brand.value))).people);
    } catch {
      fillPinTo([]);
    }
  };
  if (brand.value) void brand.onchange();
}

/**
 * The People tab: who a Brand wants recognised, and the photographs it knows
 * them by.
 *
 * Everything here handles personal data, which is why it looks different from
 * the other tabs. Reference Photos are fetched rather than linked, because they
 * have no public address. Deleting takes two clicks, because it takes every
 * photograph and Face Print with it and there is no undo. And consent is a box
 * on the enrol form rather than a rule in a document, so the answer is recorded
 * against the photograph it belongs to.
 */
function peopleForm() {
  const form = $("#form");
  form.replaceChildren();

  const brand = el("select", { name: "peopleBrand", dataset: { role: "control" } });
  for (const b of brands) brand.append(el("option", { value: b.id, textContent: b.name }));
  brand.value = peopleBrand || brands[0]?.id || "";
  peopleBrand = brand.value;
  form.append(field("Company", brand, "a Person belongs to exactly one"));

  const add = el("fieldset");
  add.append(el("legend", { textContent: "Add a Person" }));
  const personName = el("input", { name: "personName", type: "text", placeholder: "Name" });
  add.append(field("Name", personName));
  const addGo = el("button", { className: "go", type: "button", textContent: "Add person" });
  add.append(addGo);
  form.append(add);

  const enrol = el("fieldset");
  enrol.append(el("legend", { textContent: "Add Reference Photos" }));
  const who = el("select", { name: "person" });
  enrol.append(field("Person", who));
  const files = el("input", { name: "files", type: "file", multiple: true, accept: "image/*" });
  enrol.append(field("Photographs", files, "several at once"));

  /**
   * Dropped photographs, kept beside the file input rather than in it.
   *
   * A file input is read-only to script — a browser will not let a page put a
   * File into one — so a drop zone that fed the input is not a thing that can be
   * built. The two lists are joined when the form is sent.
   */
  let dropped = [];
  const dropZone = el("div", {
    className: "drop",
    textContent: "or drop photographs here",
    dataset: { role: "drop" },
  });
  const sayDropped = () => {
    dropZone.textContent = dropped.length === 0
      ? "or drop photographs here"
      : dropped.length + (dropped.length === 1 ? " photograph" : " photographs") + " ready";
  };
  // preventDefault on dragover as well as on drop: without it the browser
  // navigates to the dropped file and the page is simply gone.
  dropZone.ondragover = (e) => { e.preventDefault(); dropZone.classList.add("over"); };
  dropZone.ondragleave = () => { dropZone.classList.remove("over"); };
  dropZone.ondrop = (e) => {
    e.preventDefault();
    dropZone.classList.remove("over");
    dropped = [...(e.dataTransfer?.files ?? [])];
    sayDropped();
  };
  enrol.append(dropZone);

  const photoUrl = el("input", { name: "photoUrl", type: "url", placeholder: "https://" });
  enrol.append(field("or a URL", photoUrl));

  const consentRow = el("div", { className: "checks" });
  const consent = el("input", { name: "consent", type: "checkbox" });
  const consentLabel = el("label");
  consentLabel.append(consent, document.createTextNode("This Person agreed to be enrolled"));
  consentRow.append(consentLabel);
  enrol.append(consentRow);

  const enrolGo = el("button", { className: "go", type: "button", textContent: "Enrol photos" });
  enrol.append(enrolGo);
  form.append(enrol);

  form.append(note(
    "Enrol only people who agreed to it. meco stores the photograph and a Face Print — "
    + "512 numbers a face can be compared against, from which no photograph can be "
    + "recovered. Neither is ever public and neither appears in the Gallery. Deleting a "
    + "Person deletes both."));

  const query = () => "?brand=" + encodeURIComponent(brand.value);

  // --------------------------------------------------------------- the cards

  async function personCard(person) {
    const c = el("div", { className: "card", dataset: { person: person.id } });
    const meta = el("div", { className: "meta" });
    meta.append(
      el("b", { textContent: person.name }),
      document.createTextNode(
        " · " + person.photoCount + (person.photoCount === 1 ? " photo" : " photos")),
    );
    const del = el("button", { className: "ghost", type: "button", textContent: "Delete Person" });
    // Two clicks rather than a dialog: the second one is the confirmation, and
    // the label says what it will do. Deleting a Person cannot be undone.
    del.onclick = async () => {
      if (del.textContent !== "Really delete?") {
        del.textContent = "Really delete?";
        return;
      }
      try {
        await send("/v1/people/" + person.id + query(), "DELETE");
        await load([note("Deleted " + person.name + " and every photograph of them.")]);
      } catch (err) { fail(err); }
    };
    meta.append(el("br"), del);
    c.append(meta);

    const photos = el("div", { className: "photos" });
    for (const photo of person.photos) {
      const wrap = el("div", { className: "overlay" });
      const img = el("img", { alt: person.name });
      wrap.append(img);
      wrap.append(faceBox(photo.face, "enrolled"));
      try {
        img.src = await privateImage(
          "/v1/people/" + person.id + "/photos/" + photo.photoId + query());
      } catch {
        // A picture that will not load must not take the card with it: the
        // Person and their photo count are still worth showing.
        wrap.append(note("photo unavailable"));
      }
      const drop = el("button", {
        className: "ghost", type: "button", textContent: "Remove",
        dataset: { photo: photo.photoId },
      });
      drop.onclick = async () => {
        try {
          await send(
            "/v1/people/" + person.id + "/photos/" + photo.photoId + query(), "DELETE");
          await load([note("Removed one Reference Photo.")]);
        } catch (err) { fail(err); }
      };
      const one = el("div");
      one.append(wrap, el("div", { className: "meta", textContent:
        photo.consentAt ? "consent recorded" : "no consent recorded" }), drop);
      photos.append(one);
    }
    c.append(photos);
    return c;
  }

  async function load(prefix = []) {
    peopleBrand = brand.value;
    show([...prefix, note("Loading People …")]);
    try {
      const res = await call("/v1/people" + query());
      who.replaceChildren(
        ...res.people.map((p) => el("option", { value: p.id, textContent: p.name })));
      if (!res.people.length) {
        return show([...prefix, note("No People yet for this company.")]);
      }
      const cards = [];
      for (const person of res.people) cards.push(await personCard(person));
      show([
        ...prefix,
        note(res.people.length + (res.people.length === 1 ? " Person." : " People.")),
        el("div", { className: "cards" }, ...cards),
      ]);
    } catch (err) { fail(err); }
  }

  // ----------------------------------------------------------- the enrolment

  /**
   * Send one or more photographs at a Person.
   *
   * Always multipart, even for a URL, so the console has one request to build
   * rather than two. A face index is only ever sent with a single photograph —
   * see the picker below for why.
   */
  async function sendPhotos(sources, faceIndex) {
    if (!who.value) return fail(new Error("Add a Person first, then enrol photographs."));
    const body = new FormData();
    body.set("brand", brand.value);
    body.set("consent", consent.checked ? "true" : "false");
    if (faceIndex !== undefined) body.set("faceIndex", String(faceIndex));
    for (const one of sources) {
      if (one.file) body.append("file", one.file);
      else body.set("source", one.url);
    }
    enrolGo.disabled = true;
    show([note("Looking for a face …")]);
    try {
      const res = await send("/v1/people/" + who.value + "/photos", "POST", body);
      dropped = [];
      sayDropped();
      await report(res, sources);
    } catch (err) { fail(err); } finally { enrolGo.disabled = false; }
  }

  /**
   * The photograph with a numbered box on every face, one of which is clicked.
   *
   * The picked face is sent as that photograph on its own, never as part of the
   * batch it arrived in: an index means something different in every picture, so
   * re-sending the whole batch with one index would ask for face 2 of a portrait
   * that has one face.
   */
  function picker(result, source) {
    const wrap = el("div", { className: "overlay pickable" });
    wrap.append(el("img", { src: source.file ? URL.createObjectURL(source.file) : source.url }));
    result.faces.forEach((face, i) => {
      const box = faceBox(face.box, "face " + (i + 1), "pick");
      box.onclick = () => sendPhotos([source], i);
      wrap.append(box);
    });
    return el("div", {},
      note(result.faces.length + " faces in " + result.name + " — click the one to enrol."),
      wrap);
  }

  async function report(res, sources) {
    const nodes = [];
    for (const one of res.results) {
      const source = sources.find((s) => s.name === one.name) ?? sources[0];
      if (one.status === "enrolled") {
        nodes.push(note("Enrolled a face from " + one.name + "."));
      } else if (one.status === "pick-a-face") {
        nodes.push(picker(one, source));
      } else {
        nodes.push(el("p", { className: "err", textContent: one.name + ": " + one.error }));
      }
    }
    await load(nodes);
  }

  addGo.onclick = async () => {
    const name = personName.value.trim();
    if (!name) return fail(new Error("Give the Person a name."));
    addGo.disabled = true;
    try {
      const person = await call("/v1/people", { brand: brand.value, name });
      personName.value = "";
      await load([note("Added " + person.name + ".")]);
      who.value = person.id;
    } catch (err) { fail(err); } finally { addGo.disabled = false; }
  };

  enrolGo.onclick = () => {
    const sources = [...files.files, ...dropped].map((f) => ({ name: f.name, file: f }));
    const link = photoUrl.value.trim();
    if (link) sources.push({ name: link, url: link });
    if (!sources.length) {
      return fail(new Error("Choose at least one photograph, or give a URL."));
    }
    return sendPhotos(sources);
  };

  brand.onchange = () => load();
  form.onsubmit = (e) => { e.preventDefault(); };
  load();
}

function galleryForm() {
  const form = $("#form");
  form.replaceChildren();

  const brand = el("select", { name: "brand", dataset: { role: "control" } });
  brand.append(el("option", { value: "", textContent: "All companies" }));
  for (const b of brands) brand.append(el("option", { value: b.id, textContent: b.name }));
  brand.value = galleryBrand;
  form.append(field("Company", brand, "a Crop belongs to none, so filtering hides Crops"));

  const placement = el("select", { name: "placement", dataset: { role: "control" } });
  placement.append(el("option", { value: "", textContent: "All placements" }));
  for (const p of channels.placements) {
    placement.append(el("option", { value: p.id, textContent: p.id + " " + p.width + "×" + p.height }));
  }
  placement.value = galleryPlacement;
  form.append(field("Placement", placement, "the output size"));

  const go = el("button", { className: "go", type: "submit", textContent: "Reload" });
  form.append(go);

  async function load() {
    galleryBrand = brand.value;
    galleryPlacement = placement.value;
    show([el("p", { className: "note", textContent: "Loading …" })]);
    const query = new URLSearchParams();
    if (galleryBrand) query.set("brand", galleryBrand);
    if (galleryPlacement) query.set("placement", galleryPlacement);
    try {
      const res = await call("/v1/gallery" + (query.toString() ? "?" + query : ""));
      if (!res.items.length) {
        return show([el("p", { className: "note", textContent: "Nothing stored for that filter." })]);
      }
      const cards = res.items.map((i) => card(
        i.url,
        [i.brand ?? "no brand", i.placement ?? i.kind, Math.round(i.bytes / 1024) + " KB", i.createdAt.slice(0, 10)].join(" · "),
        i.key.endsWith(".pdf"),
      ));
      show([
        el("p", { className: "note", textContent: "Showing " + res.items.length + " of " + res.total + "." }),
        el("div", { className: "cards" }, ...cards),
      ]);
    } catch (err) { fail(err); }
  }

  brand.onchange = load;
  placement.onchange = load;
  form.onsubmit = (e) => { e.preventDefault(); load(); };
  load();
}

// ----------------------------------------------------------------------- boot

for (const tab of document.querySelectorAll(".tab")) {
  tab.onclick = () => {
    panel = tab.dataset.panel;
    for (const t of document.querySelectorAll(".tab")) t.setAttribute("aria-selected", String(t === tab));
    draw();
  };
}

function draw() {
  if (panel === "render") renderForm();
  else if (panel === "carousel") carouselForm();
  else if (panel === "people") peopleForm();
  else if (panel === "gallery") galleryForm();
  else cropForm();
}

async function boot() {
  try {
    [templates, channels, brands] = await Promise.all([
      call("/v1/templates"),
      call("/v1/channels"),
      call("/v1/brands"),
    ]);
  } catch (err) {
    const hint = err.status === 401
      ? "Paste MECO_TOKEN above and press Save."
      : "Could not reach the API.";
    $("#form").replaceChildren(el("p", { className: "err", textContent: hint + "\n\n" + err.message }));
    return;
  }
  draw();
  show([el("p", { className: "note", textContent: "Ready. " + templates.length + " templates, " + channels.placements.length + " placements." })]);
}

boot();
</script>
</body>
</html>`;
