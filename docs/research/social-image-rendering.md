# Automated social media image generation via API — options & recommended stack

_Research date: 19 Aug 2026. All prices/licenses read from vendor pricing pages, GitHub LICENSE files and official docs — sources at the bottom._

> **This is a point-in-time research snapshot, not the spec.** It records the options that existed and why one was picked. For what meco actually is, read [`CONTEXT.md`](../../CONTEXT.md) and [`docs/adr/`](../adr/). Known divergences since this was written: brands are out of scope; deployment is Vercel Functions running a container image, so the local-Docker and Hetzner notes below no longer apply; output sizing is modelled as Channel + Placement rather than brand size presets.

---

## TL;DR

1. **Yes, the category exists** — ~12 mature SaaS vendors. But almost all are **visual-editor-first**: you design in their canvas, templates are proprietary layer-JSON. That conflicts head-on with your requirement "_have Claude Code create templates for me_".
2. **Only three vendors accept HTML+CSS as the template**: **HTMLCSStoImage** ($14/mo, full support, versioned templates), **Urlbox** ($49/mo tier required), **RenderForm** (HTML editor, but templates must be stored server-side).
3. **There is no mature open-source Bannerbear.** That product category is empty in OSS. What _does_ exist is excellent commodity **rendering infrastructure** — Gotenberg (MIT), Playwright (Apache-2.0), Takumi (MIT/Apache-2.0), sharp (Apache-2.0).
4. **Therefore: build it, but build it thin.** The renderer is a solved commodity you `docker run`. Your actual product is the **brand + template registry** and the **typed API contract** your existing agents call. That's maybe 400 lines of TypeScript.
5. **Important correction to your roadmap: PDF is not v3, it's v1.** LinkedIn carousels _are_ PDFs (LinkedIn's Documents API accepts PDF, max 100 MB / 300 pages). Chromium gives you PNG and PDF from the same template for free, so ship both on day one.
6. **Watch Remotion's license before you plan v2**: for-profit orgs with >3 people need a paid Company License; automated render pipelines fall under "Automators" = **$0.01/render with a $100/mo minimum** + mandatory license key + telemetry. MIT alternative: **Revideo**.

---

## Q1 — Are there services that do just this?

Yes. Ranked by fit for _your_ constraint (templates authored as code, not in a canvas):

| Vendor             | Templates as HTML+CSS?                                                                            | PNG | PDF          | Video  | Smart crop                              | Entry price                        |
| ------------------ | ------------------------------------------------------------------------------------------------- | --- | ------------ | ------ | --------------------------------------- | ---------------------------------- |
| **HTMLCSStoImage** | ✅ **native** — POST `html`+`css` inline, or versioned server-side templates with Handlebars vars | ✅  | ✅           | ✗      | CSS only                                | **$14/mo** (1k imgs)               |
| **Urlbox**         | ✅ inline `html`+`css`+`js` (no template storage)                                                 | ✅  | ✅           | ✅ mp4 | `clip` only                             | **$49/mo** (HTML needs Hi‑Fi tier) |
| **RenderForm**     | ⚠️ HTML+CSS+Handlebars, but stored server-side only                                               | ✅  | ✅           | ✗      | CSS only                                | $9 / 250 renders (PAYG)            |
| **Creatomate**     | ⚠️ JSON "RenderScript" as code (not HTML), POST-able inline                                       | ✅  | ✗            | ✅     | ✗                                       | ~$45/mo annual                     |
| Bannerbear         | ✗ canvas editor                                                                                   | ✅  | ✅           | ✅     | ✅ **best** (`ai-detect: face/subject`) | $49/mo                             |
| Placid             | ✗ canvas editor                                                                                   | ✅  | ✅ CMYK      | ✅     | ✗                                       | $19/mo                             |
| Templated.io       | ✗ canvas + AI gen                                                                                 | ✅  | ✅           | ✅     | ✗                                       | $29/mo annual                      |
| DynaPictures       | ✗ canvas editor                                                                                   | ✅  | ✅ multipage | ✗      | ✅ face-aware                           | $29/mo                             |
| Abyssale           | ✗ canvas (+ Figma import)                                                                         | ✅  | ✅           | ✅     | ✗                                       | $36/**seat**/mo for API            |
| APITemplate.io     | ⚠️ HTML only on the **PDF** endpoints; images are canvas-only                                     | ✅  | ✅           | ✗      | ✗                                       | $29/mo annual                      |
| Shotstack          | ⚠️ `HtmlAsset`, restricted CSS subset                                                             | ✅  | ✗            | ✅     | ✗                                       | $39/mo                             |
| Cloudinary / imgix | ✗ URL transform DSL, not templates                                                                | ✅  | ✗            | ✅     | ✅ `g_auto` / `crop=faces`              | $89 / $25 per mo                   |

**Verdict:** if you want to be live this afternoon with zero infra, **HTMLCSStoImage at $14/mo** is the only vendor whose native workflow is "templates live in git, CI pushes them, Claude Code edits the HTML". Everything else makes you hand-author proprietary layer trees with no local preview — strictly worse than writing HTML.

Two notes:

- **Bannerbear** is the only single vendor that does both AI face-aware cropping _and_ good compositing, with a 100-image batch endpoint. If you'd tolerate the canvas editor, it's the strongest all-in-one at $49/mo.
- **Nobody offers self-hosting** except Browserless (Enterprise, and see the license warning below).

---

## Q2 — Open source / self-hosted?

**The honest answer: there is no self-hostable Bannerbear.** Everything credible in OSS is a _library_ or a _headless-browser service_, not a product.

What I checked and rejected:

|                                                 | Status                                                                                                                                                           |
| ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `vercel/og-image`                               | **Archived Jan 2023.** Dead.                                                                                                                                     |
| `microlinkhq/cards`                             | **Archived 6 Aug 2026.** Dead.                                                                                                                                   |
| `beeroniza` (self-hosted Bannerbear clone)      | 0 stars, source-available license, author states the codebase is entirely AI-generated with "no warranty of any kind". Useful as an architecture reference only. |
| Polotno                                         | Not OSS — **$249–899/mo** proprietary SDK.                                                                                                                       |
| Penpot (MPL-2.0, 58k★)                          | Real OSS, self-hostable, has an API — but it's a _design tool_, not a data-merge render API. Wrong shape.                                                        |
| RendrKit ("open-source Bannerbear alternative") | No GitHub URL, no license, has a hosted paid tier. Treat as SaaS.                                                                                                |

### What IS worth self-hosting — the render engines

| Engine                                  | License                    | Ships an HTTP API?                                 | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| --------------------------------------- | -------------------------- | -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Gotenberg**                           | **MIT** ✅                 | ✅ `docker run -p 3000:3000 gotenberg/gotenberg:8` | Chromium in a box. `POST /forms/chromium/screenshot/html` → png/jpeg/webp, `POST /forms/chromium/convert/html` → PDF (incl. PDF/A, PDF/UA), plus merge/split. **100% CSS fidelity.** ~1 vCPU + 1–2 GB RAM per concurrent render.                                                                                                                                                                                                                                  |
| **Playwright / Puppeteer**              | Apache-2.0 ✅              | ✗ library                                          | Same fidelity, you wrap it yourself. More control over fonts/viewport.                                                                                                                                                                                                                                                                                                                                                                                            |
| **Takumi**                              | **MIT / Apache-2.0** ✅    | ✗ library                                          | The 2026 newcomer and the interesting one. Rust engine, **no browser**. Supports flexbox **+ CSS grid**, block/inline/float, `calc()`, media queries, **Tailwind v4**, WOFF2, variable fonts, RTL, emoji. Outputs PNG/JPEG/WebP/GIF/APNG **and paged PDF** (`takumi-pdf`). Drop-in compatible with `next/og`'s `ImageResponse`. ~**26 ms warm / 176 ms cold** vs Chromium's ~198 ms / 0.7–2.8 s. Caveat: young, one primary maintainer, no official Docker image. |
| Satori + resvg                          | MPL-2.0                    | ✗ library                                          | The old default (what `@vercel/og` uses). **Flexbox only — `display:grid` does not work**, no `calc()`, TTF/OTF/WOFF only (no WOFF2), no kerning/ligatures. `resvg-js`'s last stable is Mar 2024 — stale. Don't pick this greenfield in 2026.                                                                                                                                                                                                                     |
| **sharp** (libvips)                     | Apache-2.0 ✅              | ✗ library                                          | Not a template renderer — this is your **photo crop/resize/optimize** layer. Handles the entire family-blog use case on its own.                                                                                                                                                                                                                                                                                                                                  |
| ⚠️ **browserless**                      | **SSPL-1.0 or commercial** | ✅                                                 | README claims closed-source commercial use requires a paid license. **Skip it — Gotenberg gives you the same thing under MIT.**                                                                                                                                                                                                                                                                                                                                   |
| ⚠️ flyimg                               | AGPL-3.0                   | ✅                                                 | AGPL. Avoid for a hosted service.                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| thumbor / imgproxy / imaginary / picfit | MIT / Apache-2.0           | ✅                                                 | Resize+smartcrop proxies. Optional CDN layer, no compositing.                                                                                                                                                                                                                                                                                                                                                                                                     |

**Video (for v2):**

|               | License    | Verdict                                                                                                                                                                                                                                                                                               |
| ------------- | ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Remotion**  | ⚠️ Custom  | Free only for individuals, non-profits, or for-profits **≤3 employees**. Above that: **Creators $25/seat/mo**, or **Automators $0.01/render with $100/mo minimum** — an automated social pipeline is squarely "Automator". Requires a license key + **mandatory telemetry**. Enterprise from $500/mo. |
| **Revideo**   | **MIT** ✅ | Motion-Canvas lineage, has headless `renderVideo()` + an HTTP render endpoint + parallel rendering. The closest MIT substitute for Remotion.                                                                                                                                                          |
| editly        | MIT        | ffmpeg-based declarative NLE. Last release Jan 2025 — stalled but fine for slideshow/Ken-Burns/titles.                                                                                                                                                                                                |
| Motion Canvas | MIT        | **Dormant** (~18 months, no stable release) and no headless render path. Not a pipeline component.                                                                                                                                                                                                    |

**PDF (needed in v1, not v3):**

- **Chromium print-to-PDF** (Gotenberg/Playwright) — full CSS fidelity, same template as your PNG. Gotcha: defaults to `print` media, so call `emulateMedia({media:'screen'})`, and set `-webkit-print-color-adjust: exact`.
- **takumi-pdf** — same JSX/HTML/Tailwind → paged PDF, selectable text, subset fonts. Doesn't support `filter: blur()`, `drop-shadow()`, `backdrop-filter` in PDF output.
- **WeasyPrint** (BSD-3) — great for invoices, **wrong for social**: no `box-shadow`, no `text-shadow`, partial grid.
- **Typst** — superb typesetting, but a bespoke language, no HTML/CSS, no HTTP API. Wrong fit.

**LinkedIn carousels (verified for 2026):** still PDF-based. LinkedIn's Documents API accepts PDF/PPT/PPTX/DOC/DOCX, max **100 MB and 300 pages**; LinkedIn's own ad specs recommend **under 10 pages**. So: _N slides of HTML → one multi-page PDF._

---

## Q3 — If you build it yourself: the stack

### Guiding principle

Don't build a render engine. `docker run gotenberg` is your render engine. Build the two things no vendor gives you:

1. a **brand registry** (guidelines, colours, fonts, logos, illustrations, size presets) that templates read from, and
2. a **typed, self-describing API** your existing agents can discover and call without you hand-holding each new template.

### Recommended stack

| Layer                 | Pick                                                                             | Why                                                                                                                                                                                     |
| --------------------- | -------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Language              | **TypeScript / Node 22**                                                         | Same language as the templates. One toolchain.                                                                                                                                          |
| HTTP                  | **Hono** (or Fastify)                                                            | Tiny, fast, good OpenAPI story.                                                                                                                                                         |
| Templates             | **React + Tailwind v4**, one `.tsx` per template                                 | Best possible authoring format for Claude Code: typed props, component reuse, Tailwind means brand tokens are one config file.                                                          |
| Prop validation       | **Zod** → auto-derived **JSON Schema**                                           | Every template _publishes its own input contract_. Your agents call `GET /v1/templates` and know exactly what to send. This is the highest-leverage design decision in the whole thing. |
| Renderer A (default)  | **Takumi**                                                                       | 26 ms warm, no browser, grid + Tailwind v4 + WOFF2, PNG **and** PDF.                                                                                                                    |
| Renderer B (fallback) | **Gotenberg** container                                                          | 100% CSS fidelity for anything Takumi can't do; also PDF/A and Office→PDF. Set per-template via a `renderer: 'chromium'` flag.                                                          |
| Photos                | **sharp**                                                                        | `resize({ fit:'cover', position: sharp.strategy.attention })` = smart crop. Also AVIF/WebP output, EXIF rotation, colour profiles.                                                      |
| Storage               | **Cloudflare R2** or S3                                                          | Return a signed/CDN URL, not bytes. Zero egress on R2.                                                                                                                                  |
| Queue                 | **none in v1**                                                                   | Renders are sub-second. Go synchronous. Add pg-boss/BullMQ only when a video render makes you.                                                                                          |
| Deploy                | **one Docker container on a Hetzner CX22 (~€4/mo)** via Coolify/Dokku, or Fly.io | Gotenberg as a sidecar container.                                                                                                                                                       |
| Auth                  | bearer token per brand                                                           | Token scopes which brand's assets you can render.                                                                                                                                       |

**Total license footprint: MIT / Apache-2.0 / BSD throughout.** No SSPL, no AGPL, no Remotion fee (until v2).

### Repo layout

```
/brands
  /laica
    brand.json          # colors, type scale, logo paths, tone, size presets
    fonts/*.woff2
    assets/logo.svg, illustrations/*
  /kart-racing
  /family-blog
/templates
  /linkedin-quote
    index.tsx           # React component
    schema.ts           # Zod schema -> published as JSON Schema
    preview.json        # sample data for the dev gallery
  /linkedin-carousel
  /race-announcement
  /product-launch
/src
  server.ts
  render.ts
  backends/takumi.ts
  backends/chromium.ts
  crop.ts               # sharp pipeline
```

### API contract

```http
POST /v1/render
{
  "brand":    "kart-racing",
  "template": "race-announcement",
  "size":     "ig-portrait",        // named preset from brand.json -> 1080x1350
  "format":   "png",                // png | jpg | webp | pdf
  "data": {
    "circuit": "Zuera",
    "date":    "2026-09-14",
    "class":   "OK-Junior",
    "photo":   "https://.../hero.jpg"
  }
}
→ 200 { "url": "https://cdn.../a1b2c3.png", "width": 1080, "height": 1350 }
```

```http
POST /v1/render/carousel      # N slides -> one multi-page PDF (LinkedIn) or N PNGs (Instagram)
{ "brand":"laica", "template":"linkedin-carousel", "format":"pdf",
  "slides":[ {...}, {...}, {...} ] }

POST /v1/crop                 # family blog: photo in, aspect ratio out, no template
{ "source":"https://.../DSC_0042.jpg", "ratio":"4:5", "strategy":"attention" }

GET  /v1/templates?brand=laica
→ [ { "id":"linkedin-quote", "sizes":["li-square","li-portrait"],
      "schema": { ...JSON Schema... } } ]     # agents self-discover
```

### The dev loop that makes this work with Claude Code

Add a Vite dev page that renders **every template × every size preset** using `preview.json`, at real pixel dimensions, hot-reloading. Claude Code edits `index.tsx`, screenshots the gallery, sees the result, iterates. This is what turns "have Claude Code create templates for me" from a wish into a working loop — without it you're rendering blind through an API.

### Effort estimate

- Skeleton + one renderer + one template + R2 upload: **~1 day**
- Brand registry, Zod→JSON-Schema discovery endpoint, dev gallery: **~1 day**
- Per additional template afterwards: **30–60 min**, mostly design decisions

---

## Roadmap

|        | Scope                                           | Stack additions                                                                                                                                  |
| ------ | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| **v1** | PNG/JPG/WebP + **PDF** (carousels) + smart crop | Hono, Takumi, Gotenberg, sharp, R2                                                                                                               |
| **v2** | Video                                           | **Revideo (MIT)** — or Remotion if you accept $100/mo + telemetry. Add a real queue (pg-boss) here; video renders are minutes, not milliseconds. |
| **v3** | Print/CMYK, one-pagers, lead magnets            | Gotenberg's PDF/A + `pdfcpu`; CMYK conversion via Ghostscript                                                                                    |

---

## Per-brand recommendation

| Brand                              | Need                                                                               | Answer                                                                                                                                                                              |
| ---------------------------------- | ---------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Consulting (knowledge content)** | LinkedIn post images + carousels                                                   | Template-driven. Carousel = multi-page PDF from N slide components. Highest value, build first.                                                                                     |
| **Family blog (Instagram)**        | Crop photos to aspect ratio                                                        | **Doesn't need a template engine at all.** `POST /v1/crop` → sharp with `strategy.attention`. ~40 lines. If you want face-aware specifically, `smartcrop.js` or imgix `crop=faces`. |
| **Racing brand**                   | Conditional posts: new product / new kart feature / race announcement with overlay | Three templates + a thin router on `event_type`. The race-overlay case ("Next Race — {Circuit} on {Date}") is the clearest template win: pure data merge over a branded background. |

---

## Decision

**If you want it working today:** HTMLCSStoImage, $14/mo, templates as HTML in your repo. Zero infra, and the migration path to self-hosted is trivial because your templates are already HTML.

**If you want to own it (my recommendation given three brands and existing agents feeding it):** build the thin service above. The renderer is free and commoditised; the brand registry and the typed template contract are the part that's actually yours, and they're the part that makes the whole thing usable by your agents rather than by you clicking around a canvas.

A reasonable hedge: build the service with a **pluggable backend interface** from day one, ship v1 pointing at HTMLCSStoImage's API, and swap in Gotenberg/Takumi when volume or fidelity justifies it. Same templates, same API, one file changes.

---

## Sources

**Vendors:** [HTMLCSStoImage pricing](https://htmlcsstoimage.com/pricing) · [HCTI templates docs](https://docs.htmlcsstoimage.com/guides/templates/) · [Urlbox pricing](https://urlbox.com/pricing) · [Urlbox options](https://urlbox.com/docs/options) · [RenderForm HTML editor](https://renderform.io/docs/general/html-template-editor) · [RenderForm pricing](https://renderform.io/pricing) · [Bannerbear pricing](https://www.bannerbear.com/pricing/) · [Bannerbear API docs](https://developers.bannerbear.com/) · [Placid pricing](https://placid.app/pricing) · [Placid images API](https://placid.app/docs/2.0/rest/images) · [Templated pricing](https://templated.io/pricing) · [APITemplate REST API](https://apitemplate.io/docs/integrations/rest-api/) · [Abyssale pricing](https://www.abyssale.com/pricing) · [DynaPictures pricing](https://dynapictures.com/p/pricing) · [Creatomate pricing](https://creatomate.com/pricing) · [Shotstack API](https://shotstack.io/docs/api/) · [Cloudinary transformations](https://cloudinary.com/documentation/transformation_reference) · [imgix rendering API](https://docs.imgix.com/apis/rendering)

**Open source:** [Gotenberg](https://github.com/gotenberg/gotenberg) · [Gotenberg routes](https://gotenberg.dev/docs/routes) · [Takumi](https://github.com/kane50613/takumi) · [takumi-pdf docs](https://takumi.kane.tw/docs/pdf) · [Satori](https://github.com/vercel/satori) · [@vercel/og limits](https://vercel.com/docs/og-image-generation) · [resvg-js](https://github.com/yisibl/resvg-js) · [Playwright page.pdf()](https://playwright.dev/docs/api/class-page#page-pdf) · [sharp](https://github.com/lovell/sharp) · [browserless LICENSE](https://github.com/browserless/browserless/blob/main/LICENSE) · [browserless relicense issue #3850](https://github.com/browserless/browserless/issues/3850) · [Penpot](https://github.com/penpot/penpot) · [Polotno pricing](https://polotno.com/pricing) · [thumbor](https://github.com/thumbor/thumbor) · [imgproxy](https://github.com/imgproxy/imgproxy) · [smartcrop.js](https://github.com/jwagner/smartcrop.js) · [WeasyPrint CSS support](https://doc.courtbouillon.org/weasyprint/stable/api_reference.html#css-features) · [Typst](https://github.com/typst/typst)

**Video:** [Remotion LICENSE.md](https://github.com/remotion-dev/remotion/blob/main/LICENSE.md) · [Remotion license terms v5.0](https://www.remotion.dev/docs/license/terms) · [remotion.pro/license](https://www.remotion.pro/license) · [Revideo](https://github.com/midrender/revideo) · [editly](https://github.com/mifi/editly) · [Motion Canvas](https://github.com/motion-canvas/motion-canvas)

**LinkedIn:** [Documents API](https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/documents-api) · [Document Ads specs](https://business.linkedin.com/marketing-solutions/success/ads-guide/document-ads)
