# Fixture photos — provenance and licence

Five photographs the face detector, the face embedder and Person matching are
tested against. All five are in the **public domain**: works of the U.S.
government, produced by NASA staff photographers in the course of their official
duties, and published by NASA for public use. None carries a copyright that this
repository has to honour, and none was taken privately — every subject is an
astronaut or cosmonaut photographed at an official event meant to be published.

Each file here is the Wikimedia Commons original **downscaled to a 1400 px long
side and re-encoded as JPEG at quality 88**, so that a repository about image
rendering does not carry 60 MB of fixtures. Nothing was cropped, rotated or
retouched. Go to the source page below for the untouched original.

`artemis-2-crew-original.jpg` is the one exception: 5878x7348 and 5 424 279
bytes, byte for byte the Commons original. It is here because a photograph that
size is the thing under test — a Vercel Function refuses a request body over
4.5 MB, so before issue #30 this exact file could not reach the face service at
all. A downscaled copy of it could not stand in: it is the bytes, the pixels and
the native-resolution detail that the bound in `src/faces.ts` is measured
against. It is the same photograph as `artemis-2-crew.jpg`, so the hand-marked
boxes in `expected.json` are its boxes too — fractions do not change with
resolution.

| File | Source page | Photographer | Licence |
|---|---|---|---|
| `artemis-2-crew.jpg` | <https://commons.wikimedia.org/wiki/File:Artemis_2_Crew_Portrait.jpg> | Josh Valcarcel, NASA | Public domain (PD-USGov-NASA) |
| `artemis-2-crew-original.jpg` | <https://commons.wikimedia.org/wiki/File:Artemis_2_Crew_Portrait.jpg> | Josh Valcarcel, NASA | Public domain (PD-USGov-NASA) |
| `astronaut-portrait.jpg` | <https://commons.wikimedia.org/wiki/File:Jonny_Kim_official_portrait.jpg> | Bill Stafford, NASA | Public domain (PD-USGov-NASA) |
| `astronaut-portrait-2.jpg` | <https://commons.wikimedia.org/wiki/File:Jonny_Kim_portrait.jpg> | Robert Markowitz, NASA (jsc2017e067117) | Public domain (PD-USGov-NASA) |
| `soyuz-crew.jpg` | <https://commons.wikimedia.org/wiki/File:Soyuz_MS-27_crew.jpg> | Bill Ingalls, NASA | Public domain (PD-USGov-NASA) |
| `jezero-crater.jpg` | <https://commons.wikimedia.org/wiki/File:Jezero_crater_on_Mars,_sol_4_of_Perseverance_mission.png> | NASA/JPL-Caltech/ASU | Public domain (PD-USGov-NASA) |

`jezero-crater.jpg` is the fixture with no face in it. It is a rocky, high-
contrast, shadowed surface rather than a blank wall, because an empty result is
only worth asserting on an image where a detector might plausibly have invented
something.

`astronaut-portrait.jpg`, `astronaut-portrait-2.jpg` and the left-hand face in
`soyuz-crew.jpg` are the same person, and they are the only faces here that are.
That is what makes a same-person cosine similarity measurable at all: the three
were taken years apart by different photographers, one an official studio
portrait, one on an airfield and one at a launch pad, at very different scales.
Every other pairing across these files is two different people. `expected.json`
records which is which as a letter.

`soyuz-crew.jpg` is the fixture Person matching needs and the portraits cannot
be: an enrolled face standing among strangers. Its Commons title says MS-27,
while the photographer's own caption in the file's EXIF says something narrower
and is what this repository goes by:

> Expedition 72 backup crewmembers Jonny Kim of NASA, left, Sergey Ryzhikov and
> Alexey Zubritskiy of Roscosmos, right, pose for a photograph as the Soyuz
> rocket is rolled out by train to the launch pad at Site 31, Sunday, Sept. 8,
> 2024, at the Baikonur Cosmodrome in Kazakhstan.

The three crewmembers later flew Soyuz MS-27 together, which is presumably how
the file came by its name; nothing in this repository depends on which mission
it is. What it does depend on is who is on the left, and that is legible in the
photograph itself — the name tape on the flight suit reads JONNY KIM — rather
than only in a caption.

## `aligned/`

The 112×112 squares the ArcFace warp produces from the faces above, written by
`packages/faces/scripts/align-dump.ts` and committed. They are the exact input
the PyTorch reference Face Prints in `edgeface-reference.json` were computed on,
which is what lets the embed test compare an ONNX output against a PyTorch one
without a Python interpreter in the loop. Same provenance and licence as the
photographs they were cut from.

## Not a substitute for consent

These photographs prove the detector and the embedder work. They do **not**
stand in for the consent rule that governs People and Reference Photos: a
public-domain licence says a photograph may be republished, not that its subject
agreed to be enrolled for face recognition. Nobody in these files is enrolled,
no Person record exists for any of them, and the Face Prints computed here live
for the length of a test run.

The hand-marked boxes for these photos are in `expected.json` beside them.
