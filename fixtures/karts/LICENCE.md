# Kart fixture photos — provenance and licence

Seven karting photographs the kart-and-driver research measured against, kept so
that the next person can reproduce the numbers in
[`docs/research/kart-and-driver-subjects.md`](../../docs/research/kart-and-driver-subjects.md)
without going back to Wikimedia.

All seven are **CC0 or public domain**. That is a deliberately narrower bar than
Commons allows: a CC BY-SA photograph would put a share-alike obligation on
anything derived from it, and a fixture is a thing other code derives from. The
wider study these were drawn from used 60 photographs under mixed CC licences;
only the unencumbered ones are committed here.

| File | Source page | Photographer | Licence |
|---|---|---|---|
| `on-track-rear-helmet.jpg` | <https://commons.wikimedia.org/wiki/File:Albert2010.jpg> | Lordnoxy | CC0 |
| `on-track-visor-open.jpg` | <https://commons.wikimedia.org/wiki/File:Danny_Buntschu,_d%C3%A9but_en_karting_(2012).jpg> | Iva Buntschu | CC0 |
| `on-track-dark-visor.jpg` | <https://commons.wikimedia.org/wiki/File:Giuseppe_Gnazzo_-_Kart_driver.jpg> | Andrea D'Amico | CC0 |
| `podium-trophy.jpg` | <https://commons.wikimedia.org/wiki/File:Leonardo_Gorski_Italian_Champion_ACI,_2023_holding_trophy_in_Val_Vibrata_circuit,_July_2023.jpg> | Racinglifestories | CC0 |
| `podium-trophy-2.jpg` | <https://commons.wikimedia.org/wiki/File:Leonardo_Gorski_WSK_Super_Master_Series_U10_Champion,_2023_on_the_podium_holding_the_winner%C2%B4s_trophy_at_7_Laghi_Kart_of_Castelletto_track_in_Italy.jpg> | Racinglifestories | CC0 |
| `paddock-mixed.jpg` | <https://commons.wikimedia.org/wiki/File:2.DM_Lauf_MSC_Berlin.22.4.07_(3).jpg> | Ottospe | Public domain |
| `street-karting-crowd.jpg` | <https://commons.wikimedia.org/wiki/File:Challenge_kart.JPG> | Leffe60 | Public domain (PD-self) |

## The size rule, and why it is a rule

**A fixture must not be smaller than the bound production applies, or it tests a
regime that does not exist.**

`src/faces.ts` bounds every Source Image to a `LONG_EDGE` of 1600 px before
either model sees it, and `withoutEnlargement` means that bound only ever
shrinks. So a fixture committed *below* it is not a smaller copy of the
production input — it is a different input, one no caller can produce, and every
number derived from it describes faces production never sees.

That is not a hypothetical. These files were committed at 1400 px until issue
#42. At that size four of `paddock-mixed.jpg`'s faces fell under `MIN_FACE_PX`
and never reached the print comparison at all; at 1600 px every one of them
clears it. The suite passed either way, and at the smaller size it credited the
size floor for a separation the Not-a-Face rule was making.

So each file here is now **exactly the bytes `boundedSource` in `src/faces.ts`
returns for the Commons original** — a resize to the 1600 px bound and JPEG at
quality 90 where the original is larger, and the original bytes untouched where
it is not. Nothing was cropped, rotated or retouched. Three files are smaller
than 1600 px because the photograph is: `on-track-rear-helmet.jpg` is 600 × 400,
`on-track-visor-open.jpg` is 1015 × 1015, and `podium-trophy-2.jpg` is
1272 × 1577. They were not enlarged, because production would not enlarge them
either.

`scripts/match-calibration.ts` enforces both halves on every run: that
`boundedSource` returns each file unchanged, and that each file's long edge is
`min(LONG_EDGE, natural)` — the second checked against the `sources` block in
`expected.json`, which records how big each Commons original is. Pass-through
alone is not enough; a 1400 px file passes it too. If `LONG_EDGE` ever changes,
those checks fail and name the files to re-derive.

## What each one is for

`on-track-dark-visor.jpg` is the fixture the whole study turns on. Two karts,
two drivers, both wearing full-face helmets with the visor down, both large in
frame, sharp, well lit. `POST /faces/detect` returns **zero faces**. It is the
photograph a karting brand posts every weekend and the one meco cannot see.

`on-track-visor-open.jpg` (0.81) and `on-track-rear-helmet.jpg` (0.65) are the
other half of the finding: YuNet *does* sometimes fire on a helmet. The second
is the interesting one — the driver is facing away and the box lands on the
**back** of the helmet, over the number panel. There is no face there at all.

`podium-trophy.jpg` and `podium-trophy-2.jpg` are the same driver, helmet off,
photographed at two different events. They are what makes a same-person cosine
measurable in the karting domain, exactly as the astronaut portraits do in
`fixtures/faces/`. Measured Face Print similarity between them: **0.7838**.

`paddock-mixed.jpg` is the paddock case: nine faces detected, scores 0.62 to
0.92, helmets off, ordinary group photography. It is the fixture that shows the
merged pipeline already works when the visor is not in the way. It also holds a
kart with a driver in it, which makes it the only photograph here where a face,
a stranger and a kart are all in one frame.

`street-karting-crowd.jpg` is the closest thing to an end-to-end demonstration
image: a street event with **two karts in the foreground, each with a driver**,
and a crowd of spectators behind the barriers. Measured on the file as committed:
**12 faces** at 0.62–0.88, and **15 `motorbike` boxes** with the two foreground
karts at **0.85 and 0.74**. What it exercises that nothing else here does is a
wide range of face sizes in one frame — 22 × 28 px to 58 × 69 px — which is the
band where `MIN_FACE_PX` and the Not-a-Face rule in `src/people.ts` decide
whether a face may carry an identity at all. Ten of its twelve faces are refused
by those rules and two are enrollable, and that is the correct answer rather than
a shortcoming.

## Consent, and why these are not Persons

Nobody in these photographs is enrolled, no Person record exists for any of
them, and no Face Print computed from them outlives a test run. The rule in
[ADR-0003](../../docs/adr/0003-face-recognition-licence-consent-and-threshold.md)
stands: a fixture is not a precedent for enrolling a third party. These are
published photographs of competitors at public events, released by their
photographers into the public domain — which settles the copyright and settles
nothing about biometrics.
