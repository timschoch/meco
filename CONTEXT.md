# meco

meco turns code-authored templates and JSON data into social media images and PDFs, so other tools can produce finished visuals through an API call instead of a design editor.

## Language

### Templates and rendering

**Template**:
A design authored as code, with no pixel size of its own. It declares the data it needs and adapts to whatever Channel it is rendered for.
_Avoid_: layout, design, banner, creative

**Channel**:
A place a Render is published, which fixes one output size — LinkedIn, Instagram, X, Facebook. A channel needing a second shape, such as an Instagram story, is its own Channel rather than a variant of an existing one.
_Avoid_: platform, network, target, preset, size, placement

**Render**:
A stored image or PDF produced from one Template, one set of data and one Channel, reachable at a stable URL. The same three inputs always yield the same Render.
_Avoid_: output, generation, asset, artifact

### Carousels

**Carousel**:
An ordered set of Slides published as a single multi-page document.
_Avoid_: deck, slideshow, gallery, sequence

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

**Crop**:
A stored image cut from a Source Image to a required shape, reachable at a stable URL. A sibling of a Render: both are stored outputs, but a Crop involves no Template.
_Avoid_: resize, thumbnail, transform, variant

**Crop Anchor**:
Which of the nine regions of a Source Image a Crop keeps when the required shape is narrower or shorter than the original. Defaults to the centre.
_Avoid_: gravity, focal point, position, alignment

**Image Slot**:
A place in a Template where a Source Image appears.
_Avoid_: image field, photo placeholder, media area

**Subject Area**:
The part of an Image Slot that a Template requires the Subject to fill. A Template declares it; a Crop must satisfy it.
_Avoid_: safe area, focus region, subject box
