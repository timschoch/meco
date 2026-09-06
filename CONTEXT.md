# meco

meco turns code-authored templates and JSON data into social media images and PDFs, so other tools can produce finished visuals through an API call instead of a design editor.

## Language

### Templates and rendering

**Brand**:
One consumer of meco as the owner of its data: its People, Reference Photos, Templates and Look. The unit of ownership and the privacy wall; a caller may hold several, and a Template belongs to exactly one. How a Brand's output looks is its Look, defined under compose.
_Avoid_: theme, skin, style, client, tenant, account

**Template**:
A design authored as code, with no pixel size of its own. It declares the Fields it needs and the Placements it supports, and lays itself out for whichever of those it is rendered for; any other Placement is refused.
_Avoid_: layout, design, banner, creative

**Channel**:
A place a Render is published — LinkedIn, Instagram, X, Facebook. A Channel offers one or more Placements.
_Avoid_: platform, network, target

**Placement**:
A way of posting within a Channel, which fixes one output size — a post, a story. Written as `<channel>/<placement>`, for example `instagram/story`.
_Avoid_: preset, size, format, variant, aspect ratio

**Render**:
A stored image or PDF produced from one Template, its Fields and one Placement, plus one Source Image under one window when the Template has an Image Slot, reachable at a stable URL. The same inputs always yield the same Render.
_Avoid_: output, generation, asset, artifact

**Gallery**:
Every stored output — every Render, Carousel and Crop — listed newest first, optionally narrowed to one Brand and one Placement. A view of what exists, never a thing that is published. Not everything meco stores is an output: storage also holds records, and a record is never in the Gallery.
_Avoid_: library, archive, history, feed

### Carousels

**Carousel**:
An ordered set of Slides published as a single multi-page document. Never a Gallery — a Carousel is one document, a Gallery is a listing.
_Avoid_: deck, slideshow, sequence

**Slide**:
One page of a Carousel. Each Slide names its own Template and data, so a cover, a body page and a closing page can differ.
_Avoid_: page, frame, card

### Photos and cropping

**Source Image**:
A photograph supplied by the caller, before any cropping.
_Avoid_: input image, original, upload, asset

**Subject**:
The part of a Source Image that must survive a Crop — a face, a person, a product.
_Avoid_: foreground, region of interest, focal subject

**Subject Box**:
One rectangle in a Source Image, in fractions 0..1, that frame composes from Regions and then solves over. Internal to frame: a Subject Box never crosses a seam, and what crosses is the Region it was composed from. A composer that knows a point rather than a region — a Crop Anchor — yields a box of zero extent.
_Avoid_: region, bbox, focal point

**Crop**:
A stored image cut from a Source Image to a required shape, reachable at a stable URL. A sibling of a Render: both are stored outputs, but a Crop involves no Template.
_Avoid_: resize, thumbnail, transform, variant

**Face Blur**:
The Redaction Mask `redact` paints over every Unknown Face when the FramingRequest's Redaction says `blurUnknownFaces`. It is applied to the Source Image's pixels before the cut, so every Unknown Face is hidden whether or not the window later keeps it; which hidden faces landed in the finished frame is the gateway's arithmetic. See Unknown Face and Redaction Mask under `## redact`.
_Avoid_: anonymise, pixelate, censor

**Crop Anchor**:
Which of the nine regions of a Source Image a Crop keeps when the required shape is narrower or shorter than the original. Defaults to the centre.
_Avoid_: gravity, focal point, position, alignment

**Image Slot**:
A place in a Template where a Source Image appears.
_Avoid_: image field, photo placeholder, media area

**Annotation**:
Everything true of one Source Image's bytes: its Content Hash, size and type, the Regions found in it, and the Models that looked. Keyed by the Content Hash alone, shared by every Brand, cached forever. Nothing Brand- or Template-dependent may enter it. A record, never a stored output, so the Gallery does not list it. Defined in the contracts section below.
_Avoid_: metadata, tags, detection result, analysis

**Kart Producer**:
How frame composes one Subject from a kart and its driver together. It takes the largest `vehicle` Region, unions it with every Region overlapping it, and yields one Subject Box — falling back to the largest `person` Region when no vehicle was found. That fallback is what lets a driver be framed without their kart, and it is also its known limit: on a photograph that is not of a kart at all it frames the largest person and still calls itself `kart`. It selects on Region Kind and never on a Label, so replacing the Model that draws the boxes moves nothing here.

Named for what it frames, not for what detects it. The Subject of a karting photograph is neither the kart nor the driver but both — a frame on the driver's head loses the livery the photograph was taken for, and a frame on the kart cuts the helmet off. A helmet is also not a face, which is the reason this producer exists at all: measured on 32 on-track photographs, the face detector puts a box on the leading driver's head in 9 of them.
_Avoid_: vehicle producer, motorbike producer, kart detector

**Subject Area**:
The part of an Image Slot that a Template requires the Subject to fill, given as fractions of the output. A Template declares it and a caller may name one for a single Crop; either way the Crop must satisfy it, and the answer says whether it did.
_Avoid_: safe area, focus region, subject box

### Faces

**Person**:
A named individual a Brand wants meco to recognise, owned by exactly one Brand and known by their Reference Photos. Personal data throughout: a Person is a record, never a stored output, and deleting one takes every Reference Photo and Face Print with it.
_Avoid_: identity, user, contact, profile

**Reference Photo**:
A photograph enrolled for one Person, showing that Person's face. Several per Person. Private in the store and never in the Gallery — meco serves the bytes only to a caller carrying the token, so a Reference Photo has no URL that hands it over on its own.
_Avoid_: training image, sample, example, headshot

**Face Print**:
The 512 floats meco-faces returns for one face, on the unit sphere, from which two faces can be compared but no photograph can be recovered. A Person has one per Reference Photo. Still a biometric template of a real person. meco-faces computes them and stores nothing.
_Avoid_: embedding, descriptor, template, vector, encoding

**Match**:
A detected face meco is willing to name: its best Face Print similarity within one Brand clears an absolute threshold and beats the second-best Person by a margin. Open-set — "nobody" is a valid answer and the common one, so a face that fails either test is unknown rather than assigned to whoever was closest. Never a property of a face on its own: the same face is a Match for the Brand that enrolled that Person and unknown to every other. Only an Identifiable Face can be one.
_Avoid_: recognition hit, identification, confidence, hit

**Not-a-Face Print**:
A Face Print meco keeps of something that is not a face — the back of a crash helmet. The face model maps such things close to one another, so any print near one of them carries no identity whoever is behind it. Committed in code and measured, never a record in the store and never about a person.
_Avoid_: negative sample, decoy, blocklist, impostor

**Identifiable Face**:
A detected face meco is willing to compare against a Person at all: large enough to print, and with a Face Print unlike every Not-a-Face Print. A face that is not one is still detected, still a Subject Box and still hidden by Face Blur — it simply can never be a Match. The property is of the face and the model, not of any Brand.
_Avoid_: valid face, real face, good face, quality

**Uncompared Face**:
A detected face meco never asked about, because no Face Print could be made of it — the alignment refused it, or the face service did not answer. Not the same as an unknown face, which _was_ compared and matched nobody: one is a gap in the question, the other an answer to it. Counted in a Crop's answer so the two can be told apart, and hidden by Face Blur exactly like any other face meco cannot name.
_Avoid_: failed face, error, skipped, dropped

## contracts

The shared language every module speaks. Three types cross the seams: the Annotation (true of the bytes), the FramingRequest (true of one output) and the Match (true for one Brand, on one call). The boundary rule: if two outputs cut from the same bytes could disagree about it, it belongs to the FramingRequest; otherwise to the Annotation.

**Content Hash**:
The SHA-256 of a Source Image's bytes, in hex. The only key an Annotation is filed under, so the same photograph re-uploaded is analysed once.
_Avoid_: id, fingerprint, checksum, digest

**Region**:
One rectangle in a Source Image that a Model drew, with its Region Kind, its Label, its score and the Model that drew it. A face Region also carries its five landmarks and may carry a Face Print. Numbered `<kind>-<n>` within its Annotation after sorting on where it sits — `kind`, then `box.y`, `box.x`, `box.width` — so two runs of the same Model give the same ids whatever order the Model Adapters answered in.
_Avoid_: detection, bbox, detected object, box (a Box is the rectangle alone), subject box (that is frame's)

**Region Kind**:
meco's closed word for what a Region is: `face`, `person`, `vehicle`, growing by PR. Never a framing conclusion: a kart is a Subject frame composes from a vehicle and the person on it, not a Region Kind.
_Avoid_: class, type, category, kart

**Label**:
The Model's own word for a Region, unaltered: COCO's `motorbike` for a kart. Open vocabulary, never selected on by name outside the module that knows the Model.
_Avoid_: class name, tag, kind

**Model**:
A named network in the models catalogue, with a version. The version changes whenever anything that can change its output changes: weights, preprocessing, class list, thresholds, runtime major. An Annotation names every Model that looked, so a photograph seen before a Model existed is a cache miss, not a wrong answer.
_Avoid_: detector, producer, service, network

**Face Print**:
Already defined above under Faces. In an Annotation it rides on a face Region together with the Model that made it, because the Model that drew the box is not the one that made the print.

**FramingRequest**:
Everything true of one output and of nothing else: the Brand, the Source Image's Content Hash, the target size and format, what to pin to, the Occlusion Zones, the Subject Area, and the redaction policy. Never cached, never a key; kept only in the call record so what was asked can be shown.
_Avoid_: crop request, render options, job, parameters

**Occlusion Zone**:
A rectangle of the Image Slot, in fractions, that a Template will cover, so the Subject must not land there. A Template with a non-rectangular overlay declares several. The inverse of the Subject Area, which says where the Subject must land.
_Avoid_: safe area, overlay, mask, exclusion, no-go zone

**Match**:
Already defined above under Faces. Crossing a seam it is the Region id, the Person id, the Brand and the similarity, per call, beside the Annotation and never inside it.

**Decoded Image**:
A Source Image as raw pixels, decoded once by the models host and handed to every Model Adapter unchanged. Decoding costs more than inference, so it happens once per photograph, not once per Model.
_Avoid_: bitmap, buffer, tensor, input image

**Adapter Region**:
A Region as a Model Adapter answers it: everything a Region has except its id. An adapter cannot know an id, because the number depends on every other adapter's Regions; the models host passes the union of them to contracts, which sorts and numbers them.
_Avoid_: raw region, unnumbered region, partial region, detection

**Model Adapter**:
The hand-written code that runs one Model over a Decoded Image and answers in Regions. It declares its Model, the Region Kinds it can emit, and its licence text, so a Model cannot be added without one. Every Model Adapter passes the same Conformance Checks.
_Avoid_: plugin, driver, wrapper, backend

**Conformance Check**:
One named test contracts ships and a module runs in its own suite to prove it speaks the shared language. Each check names the mutation that must make it fail.
_Avoid_: contract test, integration test, validation, lint

**Target**:
The output's size in pixels, `width` and `height`, with an optional format and quality. On the FramingRequest, so two outputs from the same bytes can differ.
_Avoid_: size, dimensions, output

**Redaction**:
The per-output redaction policy on the FramingRequest, today only `blurUnknownFaces`. Never a Brand default: it is true of this output and of nothing else.
_Avoid_: privacy, blur settings

## frame

Where the Crop Window comes from. frame is given an Annotation, the Matches for
this Brand and a FramingRequest, and answers with one rectangle and the reasons
it is that one. It never touches a pixel: no pixel crosses its seam, which is
why the whole module is arithmetic.

**Crop Window**:
The rectangle of a Source Image a Crop is cut from, in whole pixels. frame's
answer; the only thing downstream of it that has to be exact, because rounding
it twice would cut a different picture.
_Avoid_: viewport, rect, crop box, region, frame

**Framing**:
Everything frame answers with: the Crop Window, which Subject it was composed
on, which Subjects survived, and every claim it can and cannot make about the
result. A Framing is a decision with its reasons attached, never a bare
rectangle.
_Avoid_: result, solution, answer, crop (a Crop is the stored image)

**Pin To**:
The caller's ordered list of what to compose the Subject from — `match`, `face`,
`kart` — walked in order until one of them yields. The caller's ladder, not
frame's: frame's own last resorts are the Crop Anchor and the centre, and they
are not in the caller's vocabulary.
_Avoid_: gravity, strategy, priority, focus, target

**Leading Subject**:
The one Subject a Framing is composed on. Every other Subject is kept in frame
when the geometry allows and is what the Drop Rung sacrifices first, cheapest
first. A photograph has exactly one however many faces are in it.
_Avoid_: primary, main subject, hero, focal subject

**Free Area**:
The largest rectangle of the Image Slot that no Occlusion Zone touches. Where
the Subject is aimed when a Template will cover part of the frame. Derived, never
declared: a Template declares Occlusion Zones and frame works out what is left.
_Avoid_: safe area, clear zone, free space, negative space

**Golden Line**:
One of the two lines at `1/φ` and `1 − 1/φ` across a frame. Where frame puts the
Subject when nobody named a Subject Area, choosing the line nearest to where the
photographer already had it so the composition moves as little as possible.
_Avoid_: rule of thirds, grid line, guide, third

**Eye Line**:
The midpoint between the Leading Subject's two eyes, as a fraction of the Source
Image height. Aimed at the upper Golden Line, which is the one place a portrait
must not be framed on its centre. Read off a face Region's landmarks, so only a
face has one.
_Avoid_: eye level, horizon, gaze, sight line

**Fallback Rung**:
One step of the ladder that rescues a Crop Window which cannot hold every
Subject: zoom out, relax the target towards the middle, drop the cheapest
Subject, or accept the clipping. Always named in the Framing — a Crop that
silently gave up on a Subject is worse than one that says it did.
_Avoid_: retry, degradation, strategy, recovery, fallback on its own

## compose

The module that lays a Template over a picture and produces the finished Render. It answers twice per output: first what the Template will cover (the Plan), later the picture itself. It is the last stage that touches pixels and the only one that encodes.

**Look**:
The colours, fonts and wordmark a Brand's Templates render in. Code inside compose, keyed by the Brand id, with the font files and logo bytes beside it. The Brand stays the unit of ownership and the privacy wall; the Look is only how its output looks. A Brand without a Look cannot be rendered for.
_Avoid_: theme, skin, brand (when the look is meant), design tokens, style guide

**Fields**:
The data a Template asks the caller for, such as a title, a kicker or a date, declared by the Template as a schema, so a caller can read what is required before rendering. Never pixels: the picture reaches a Template through its Image Slot, not through a Field.
_Avoid_: data, props, variables, content, payload

**Plan**:
What a Template will do at one Placement with these Fields, before any picture exists: the Image Slot in pixels, the Occlusion Zones and the Subject Area in Image Slot fractions. Measured from the Template's layout, so a longer title gives a taller zone. Needs no Source Image; the same Template, Placement and Fields always give the same Plan.
_Avoid_: layout, dry run, preflight, manifest, preview

**Marker**:
One of the two components a Template uses to name what compose must find in its layout: `ImageSlot`, exactly one, where the picture goes; `Occludes`, any number, around what will cover the picture. A Marker draws nothing of its own.
_Avoid_: annotation, tag, hint, decorator, region

## models

The catalogue of vision Models and the one container that runs them. In: a Source Image's bytes. Out: its Annotation. It knows nothing of Brands, Persons, templates or crops.

**Catalogue**:
The fixed list of Models the models service holds, each behind its own Model Adapter with its licence text beside its weights. A request names Catalogue entries; an entry not in the Catalogue is refused, never fetched.
_Avoid_: registry, model zoo, model list, plugins

**Detector**:
A Model Adapter that draws Regions from the Decoded Image alone. YuNet draws faces, D-FINE draws people and vehicles.
_Avoid_: model, first stage, finder

A `vehicle` is a road vehicle a person rides or drives. D-FINE's COCO Labels become Region Kinds by this table and no other; frame composes the kart Subject on it, so a change here is a change frame sees.

| COCO Label                                                 | Region Kind |
| ---------------------------------------------------------- | ----------- |
| `person`                                                   | `person`    |
| `motorbike`, `bicycle`, `car`, `bus`, `truck`              | `vehicle`   |
| every other Label, `boat`, `aeroplane`, `train` among them | no Region   |

**Enricher**:
A Model Adapter that draws no Region of its own: it takes the Regions the Detectors found and hands them back with more on them. EdgeFace puts a Face Print on each face Region whose landmarks it can align. A Region an Enricher could not serve is returned unchanged, never dropped.
_Avoid_: embedder, second stage, post-processor, plugin

**Decode Bound**:
The longest edge a Decoded Image may have, 1600 px. A larger Source Image is decoded smaller, never larger, and every Region is still a fraction of the Source Image, so the Annotation's size is the photograph's and not the copy's.
_Avoid_: max size, downscale, thumbnail, resize, working size

**Warm**:
A Model whose session exists on the instance answering, so a request pays inference and not the load. True per instance, never per deployment: a scale-to-zero fleet has cold and warm instances at once.
_Avoid_: loaded, ready, hot, cached

## store

Bytes filed under a name, handed back on request. The store knows what a key is and which of the two stores it belongs to, and nothing else: not what the bytes depict, not who may see them, not whether anything still points at them.

**Stored Object**:
The bytes at one Store Key, with their size and content type. Wider than a stored output: every Render, Crop, Source Image and Reference Photo is a Stored Object, but only the outputs are in the Gallery.
_Avoid_: file, blob, asset, entry

**Store Key**:
The name a Stored Object is filed under: a Namespace, an optional caller-chosen middle, and the Content Hash of the bytes as the last segment. Immutable — the same key always names the same bytes, so a write is never an overwrite and a retry costs nothing. The only thing that crosses a seam to name a Stored Object: a URL is derived from a key, never stored beside it.
_Avoid_: path, id, filename, url

**Namespace**:
The first segment of a Store Key, saying what kind of thing is filed under it: `sources`, `renders`, `crops`, `people`, `health`, `health-public`. It is also what decides public from private, so no call site can choose the wrong store by forgetting. A first segment naming none of the six is refused, because an unknown Namespace is not private and would otherwise land in the Public Store without saying so. A Namespace maps to exactly one store, which is why the two health probes need one each.
_Avoid_: bucket, folder, directory, prefix (a prefix is any leading part of a key)

**Public Store**:
The store whose objects are served to anyone who has their URL, at an address that does not expire. Holds what a caller asked meco to make and expects to publish: Renders and Crops.
_Avoid_: bucket, CDN, public bucket

**Private Store**:
The store whose objects no URL hands over on its own. Holds the photographs meco was given rather than asked to publish — Source Images, and every Reference Photo. Reads happen inside the deployment, or through a Signed URL the gateway minted; there is no third way, and a missing Private Store is an error rather than a quiet fall back to the Public Store.
_Avoid_: secure bucket, vault, protected store

**Signed URL**:
A URL that hands over one Private Store object to whoever holds it, until it expires minutes later. Minted only by the gateway, only for a caller it has already authorised, and short-lived because the reason it was minted does not outlive the request.
_Avoid_: presigned URL, temporary link, token URL, share link

**Deduped**:
What a write reports when the bytes were already filed under that key, so nothing was written. Not a cache hit and not a failure — it is the ordinary outcome of a Store Key ending in the Content Hash of its own bytes, which is what makes a retry free and an overwrite impossible.
_Avoid_: cached, skipped, exists, duplicate, no-op

**Credential Source**:
Which credential carried one call to one store: the platform's OIDC token, or that store's read-write token. Resolved per store and per call in that order, and reported rather than assumed, because the two rungs are available in different runtimes — a container gets no OIDC token, and only a measurement says so.
_Avoid_: rung (a Fallback Rung is frame's), auth mode, strategy, provider

**Store Reach**:
What one of the two stores looks like from inside the deployment: whether it is configured, which store it is, the Credential Source that reached it, whether bytes written came back identical, and how long that took. A measurement of the round trip, never a reading of whether an environment variable happens to be set.
_Avoid_: status, connection, ping, availability

**Store Health**:
Both Store Reaches together, as `GET /health` reports them. A store that cannot be reached is reported here rather than by failing the endpoint: the service answering is up, and saying which store is not is the whole point of the block.
_Avoid_: store status, healthcheck, diagnostics

## redact

Hiding what a Brand may not show. It happens on the Source Image, before anything is cut out of it, so the module is never told where the output will be framed and cannot be wrong about it. The policy is one boolean on the FramingRequest ([#67](https://github.com/timschoch/meco/issues/67)).

**Unknown Face**:
A face Region with no Match in this call. The thing redact hides. Never a property of the face alone — the same face is known to the Brand that enrolled the Person and unknown to every other. An Uncompared Face and a face that is not an Identifiable Face are both Unknown Faces, because neither produced a Match, and a similarity under identify's threshold arrives here as no Match at all.
_Avoid_: stranger, unmatched face, anonymous face, non-person

**Redaction Mask**:
The feathered elliptical coverage map redact paints one Unknown Face through, inscribed in that Region's box in Source Image pixels. Its blur strength scales with the face's width, so a face 600 pixels wide and one 60 pixels wide are hidden equally. The feather is load-bearing rather than decorative: it is what stops the mask announcing itself once compose resamples the frame.
_Avoid_: overlay, stencil, alpha, blur box, censor

**Redaction Record**:
What redact reports for one face it hid: the Region id and why. Kept in the call record so the webui can say which face, not how many. Never says whether that face survived the crop — redact does not know the window, and frame answers that question.
_Avoid_: blur log, count, blurred, audit entry
