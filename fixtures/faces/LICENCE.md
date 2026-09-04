# Fixture photos — provenance and licence

Three photographs the face detector is tested against. All three are in the
**public domain**: works of the U.S. government, produced by NASA staff
photographers in the course of their official duties, and published by NASA for
public use. None carries a copyright that this repository has to honour, and
none was taken privately — every subject is a NASA astronaut photographed for an
official portrait meant to be published.

Each file here is the Wikimedia Commons original **downscaled to a 1400 px long
side and re-encoded as JPEG at quality 88**, so that a repository about image
rendering does not carry 60 MB of fixtures. Nothing was cropped, rotated or
retouched. Go to the source page below for the untouched original.

| File | Source page | Photographer | Licence |
|---|---|---|---|
| `artemis-2-crew.jpg` | <https://commons.wikimedia.org/wiki/File:Artemis_2_Crew_Portrait.jpg> | Josh Valcarcel, NASA | Public domain (PD-USGov-NASA) |
| `astronaut-portrait.jpg` | <https://commons.wikimedia.org/wiki/File:Jonny_Kim_official_portrait.jpg> | Bill Stafford, NASA | Public domain (PD-USGov-NASA) |
| `jezero-crater.jpg` | <https://commons.wikimedia.org/wiki/File:Jezero_crater_on_Mars,_sol_4_of_Perseverance_mission.png> | NASA/JPL-Caltech/ASU | Public domain (PD-USGov-NASA) |

`jezero-crater.jpg` is the fixture with no face in it. It is a rocky, high-
contrast, shadowed surface rather than a blank wall, because an empty result is
only worth asserting on an image where a detector might plausibly have invented
something.

## Not a substitute for consent

These photographs prove the detector works. They do **not** stand in for the
consent rule that governs People and Reference Photos: a public-domain licence
says a photograph may be republished, not that its subject agreed to be enrolled
for face recognition. Nobody in these files is enrolled, and no Face Print is
derived from them.

The hand-marked boxes for these photos are in `expected.json` beside them.
