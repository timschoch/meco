# A Channel fixes exactly one output size

Social platforms each accept several image shapes — LinkedIn has a square and a wide feed image, Instagram has a square, a portrait and a story. The obvious model is a two-level `channel/placement` pair. We chose instead to let a Channel carry exactly one size, and to make any second shape its own Channel (`instagram-story` rather than `instagram/story`).

## Considered Options

- **Channel with named Placements.** Matches how the platforms describe themselves, and groups related sizes. Rejected because it adds a second level of naming to every call, every template contract and every discovery response, to serve a need we do not have yet.
- **Channel fixes one size.** Chosen. Callers name one flat string and get one Render. Adding a shape is a new entry in a list, not a new concept.

## Consequences

Callers asking for "everything for LinkedIn" must name each Channel explicitly; there is no channel-level fan-out to all its shapes. If that request becomes common, the fix is a named group of Channels, not a Placement level — grouping stays outside the core model.
