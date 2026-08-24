---
name: meco
description: Render branded images through the meco MCP server — Instagram posts and stories, LinkedIn post images and carousels, race infographics, shop product posts, blog cards — for laica, Hope Family and Swiss Hutless. Also crops a source image to an exact size.
---

# meco

meco renders a **Template** plus data into a **Render** at one or more **Placements**, and hands back a public URL.

The tools come from the `meco` MCP server. When `list_templates` is absent, follow [SETUP.md](SETUP.md) and stop.

## Steps

1. **Read the contract.** Call `list_templates` and work from the JSON Schema it returns. It is the only place a Template's fields are written down, and a Template renders whatever it is given — a field you guessed wrong comes back as a finished image with a hole in it, not as an error.
2. **Source every fact.** Take each date, price, name and image URL from the shop, the CMS, the official calendar or the user, and say where each came from. Fetch every image URL first and confirm it returns image bytes; meco fails the whole Render on a dead one.
3. **Pick the Placements.** One Template adapts to any Placement, so name the ones the post is actually for — see the table below. Naming a bare Channel (`instagram`) renders every Placement it offers.
4. **Render.** `render_image` for one card, `render_carousel` for a sequence of Slides.
5. **Hand back every URL.** The Render is a link, not something you can see. Say which Placement each URL is, and paste the URLs in full.

## Brands

| Brand | Is | Posts to |
|---|---|---|
| `laica` | AI consulting, laica.dev | `linkedin` |
| `hopefamily` | family blog, hope-family.com | `instagram` |
| `swisshutless` | kart racing team and shop | `instagram` |

All three publish in German. Write the image text in German even when the conversation runs in English.

## Repeat renders are free

A Render is content-addressed: identical input returns the identical URL without re-rendering. Re-run a Render to check it rather than working around it.
