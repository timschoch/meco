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
  .cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: 16px; }
  .card { border: 1px solid var(--line); border-radius: 10px; overflow: hidden; background: var(--panel); }
  .card img { display: block; width: 100%; background: #000; }
  .meta { padding: 8px 10px; font-size: 12px; color: var(--dim); word-break: break-all; }
  .meta b { color: var(--ink); font-weight: 600; }
  .meta a { color: var(--accent); }
  .note { color: var(--dim); font-size: 13px; }
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

<script type="module">
const $ = (s) => document.querySelector(s);
const out = $("#out");
let templates = [];
let channels = { placements: [] };
let panel = "render";

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
  if (!res.ok) throw new Error(JSON.stringify(json, null, 2));
  return json;
}

function el(tag, attrs = {}, ...kids) {
  const n = Object.assign(document.createElement(tag), attrs);
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

  const anchor = el("select", { name: "anchor" });
  anchor.append(el("option", { value: "", textContent: "let the image decide (attention)" }));
  for (const a of ["center", "top", "bottom", "left", "right", "top-left", "top-right", "bottom-left", "bottom-right"]) {
    anchor.append(el("option", { value: a, textContent: a }));
  }
  form.append(field("Crop Anchor", anchor));

  const go = el("button", { className: "go", type: "submit", textContent: "Crop" });
  form.append(go);

  form.onsubmit = async (e) => {
    e.preventDefault();
    go.disabled = true;
    show([el("p", { className: "note", textContent: "Cropping …" })]);
    try {
      const res = await call("/v1/crop", {
        source: source.value,
        width: Number(width.value),
        height: Number(height.value),
        ...(anchor.value ? { anchor: anchor.value } : { strategy: "attention" }),
      });
      show([el("div", { className: "cards" }, card(res.url, res.width + "×" + res.height + " · " + res.resolvedBy))]);
    } catch (err) { fail(err); } finally { go.disabled = false; }
  };
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
  else cropForm();
}

async function boot() {
  try {
    [templates, channels] = await Promise.all([call("/v1/templates"), call("/v1/channels")]);
    draw();
    show([el("p", { className: "note", textContent: "Ready. " + templates.length + " templates, " + channels.placements.length + " placements." })]);
  } catch (err) {
    $("#form").replaceChildren(el("p", { className: "err", textContent: "Could not load templates. Paste MECO_TOKEN above and press Save.\n\n" + err.message }));
  }
}

boot();
</script>
</body>
</html>`;
