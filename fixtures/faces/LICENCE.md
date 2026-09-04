# Fixture photos — provenance and licence

Four photographs the face detector and the face embedder are tested against.
All four are in the **public domain**: works of the U.S. government, produced by
NASA staff photographers in the course of their official duties, and published
by NASA for public use. None carries a copyright that this repository has to
honour, and none was taken privately — every subject is a NASA astronaut
photographed for an official portrait meant to be published.

Each file here is the Wikimedia Commons original **downscaled to a 1400 px long
side and re-encoded as JPEG at quality 88**, so that a repository about image
rendering does not carry 60 MB of fixtures. Nothing was cropped, rotated or
retouched. Go to the source page below for the untouched original.

| File | Source page | Photographer | Licence |
|---|---|---|---|
| `artemis-2-crew.jpg` | <https://commons.wikimedia.org/wiki/File:Artemis_2_Crew_Portrait.jpg> | Josh Valcarcel, NASA | Public domain (PD-USGov-NASA) |
| `astronaut-portrait.jpg` | <https://commons.wikimedia.org/wiki/File:Jonny_Kim_official_portrait.jpg> | Bill Stafford, NASA | Public domain (PD-USGov-NASA) |
| `astronaut-portrait-2.jpg` | <https://commons.wikimedia.org/wiki/File:Jonny_Kim_portrait.jpg> | Robert Markowitz, NASA (jsc2017e067117) | Public domain (PD-USGov-NASA) |
| `jezero-crater.jpg` | <https://commons.wikimedia.org/wiki/File:Jezero_crater_on_Mars,_sol_4_of_Perseverance_mission.png> | NASA/JPL-Caltech/ASU | Public domain (PD-USGov-NASA) |

`jezero-crater.jpg` is the fixture with no face in it. It is a rocky, high-
contrast, shadowed surface rather than a blank wall, because an empty result is
only worth asserting on an image where a detector might plausibly have invented
something.

`astronaut-portrait.jpg` and `astronaut-portrait-2.jpg` are the same person, and
they are the only pair here that is. That is what makes a same-person cosine
similarity measurable at all: the two were taken four years apart by different
photographers, one an official studio portrait and one on an airfield in a
flight suit, at very different scales. Every other pairing across these files is
two different people. `expected.json` records which is which as a letter.

## `aligned/`

The 112×112 squares the ArcFace warp produces from the faces above, written by
`packages/faces/scripts/align-dump.ts` and committed. They are the exact input
the PyTorch reference embeddings in `edgeface-reference.json` were computed on,
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
