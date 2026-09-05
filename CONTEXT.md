# meco

meco turns code-authored templates and JSON data into social media images and PDFs, so other tools can produce finished visuals through an API call instead of a design editor.

## Language

### Templates and rendering

**Brand**:
The look a Template renders in — colours, fonts and wordmark, owned by one consumer of meco. A Template belongs to exactly one Brand.
_Avoid_: theme, skin, style, client

**Template**:
A design authored as code, with no pixel size of its own. It declares the data it needs and adapts to whatever Placement it is rendered for.
_Avoid_: layout, design, banner, creative

**Channel**:
A place a Render is published — LinkedIn, Instagram, X, Facebook. A Channel offers one or more Placements.
_Avoid_: platform, network, target

**Placement**:
A way of posting within a Channel, which fixes one output size — a post, a story. Written as `<channel>/<placement>`, for example `instagram/story`.
_Avoid_: preset, size, format, variant, aspect ratio

**Render**:
A stored image or PDF produced from one Template, one set of data and one Placement, reachable at a stable URL. The same three inputs always yield the same Render.
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
An option on a Crop: every face showing in the finished frame that meco cannot name is hidden behind an elliptical mask. A face the crop window left out is not in the picture and so is neither hidden nor counted. Never a property of a Source Image — the Source Image is untouched, and only the Crop carries the blur.
_Avoid_: anonymise, redact, pixelate, censor

**Crop Anchor**:
Which of the nine regions of a Source Image a Crop keeps when the required shape is narrower or shorter than the original. Defaults to the centre.
_Avoid_: gravity, focal point, position, alignment

**Image Slot**:
A place in a Template where a Source Image appears.
_Avoid_: image field, photo placeholder, media area

**Annotation**:
Everything true of one Source Image's bytes: its Content Hash, size and type, the Regions found in it, and the Models that looked. Keyed by the Content Hash alone, shared by every Brand, cached forever. Nothing Brand- or Template-dependent may enter it. A record, never a stored output, so the Gallery does not list it. Defined in the contracts section below.
_Avoid_: metadata, tags, detection result, analysis

**Detected Object**:
The prototype's word for a non-face Region. Superseded by Region with a Label; do not use.

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
A detected face meco never asked about, because no Face Print could be made of it — the alignment refused it, or the face service did not answer. Not the same as an unknown face, which *was* compared and matched nobody: one is a gap in the question, the other an answer to it. Counted in a Crop's answer so the two can be told apart, and hidden by Face Blur exactly like any other face meco cannot name.
_Avoid_: failed face, error, skipped, dropped

## contracts

The shared language every module speaks. Three types cross the seams: the Annotation (true of the bytes), the FramingRequest (true of one output) and the Match (true for one Brand, on one call). The boundary rule: if two outputs cut from the same bytes could disagree about it, it belongs to the FramingRequest; otherwise to the Annotation.

**Content Hash**:
The SHA-256 of a Source Image's bytes, in hex. The only key an Annotation is filed under, so the same photograph re-uploaded is analysed once.
_Avoid_: id, fingerprint, checksum, digest

**Region**:
One rectangle in a Source Image that a Model drew, with its Region Kind, its Label, its score and the Model that drew it. A face Region also carries its five landmarks and may carry a Face Print. Numbered within its Annotation by position, so two runs of the same Model give the same ids.
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

**Model Adapter**:
The hand-written code that runs one Model over a Decoded Image and answers in Regions. It declares its Model, the Region Kinds it can emit, and its licence text, so a Model cannot be added without one. Every Model Adapter passes the same Conformance Checks.
_Avoid_: plugin, driver, wrapper, backend

**Conformance Check**:
One named test contracts ships and a module runs in its own suite to prove it speaks the shared language. Each check names the mutation that must make it fail.
_Avoid_: contract test, integration test, validation, lint

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
