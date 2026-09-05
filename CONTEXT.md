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
One rectangle in a Source Image, in fractions 0..1, with a priority and a `keep` flag. Every producer of framing — the Crop Anchor, saliency, a face, a Person, a kart — yields Subject Boxes, and the solver consumes them. A producer that knows a point rather than a region yields a box of zero extent.
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
What meco found in one Source Image, stored under the hash of its bytes and shaped as IPTC Image Regions. One machine region per detected face and one per Detected Object. A record, never a stored output, so the Gallery does not list it. The same photograph is analysed once however many Crops are cut from it, and it names which detectors have run so a photograph seen before a detector existed is looked at again rather than trusted.
_Avoid_: metadata, tags, detection result

**Detected Object**:
Something meco-faces saw that is not a face, carrying the word its model was trained with. The vocabulary is COCO's and it is not meco's: COCO has no kart, so a kart comes back as `motorbike` — the nearest thing that vocabulary holds, and measured the class that finds one on 29 of 32 on-track photographs. A Detected Object is never a Subject on its own; the Kart Producer is what turns some of them into one.
_Avoid_: detection, object box, thing, entity

**Kart Producer**:
The producer that frames a Crop on a kart and its driver together. It takes the largest `motorbike` Detected Object, unions it with everything overlapping it, and yields one Subject Box — falling back to the largest `person` when no kart was found. It sits between the face and saliency in the ladder: a photograph with a visible face is a photograph of that person, and a photograph with neither is still framed by saliency.

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
