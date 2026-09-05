import { Renderer } from "@takumi-rs/core";
import { LOGO_ALT_SRC, LOGO_SRC, type Look } from "../template";
import { LOOKS } from "./looks/registry";

let ready: Promise<Renderer> | undefined;

/**
 * The one Renderer in the process, with every Look's fonts registered.
 *
 * Registration happens once and covers all Looks rather than the one Brand in
 * hand: takumi resolves families globally, so registering per call would make
 * the picture depend on call order. The bytes are already in memory — a Look
 * reads its fonts when its module loads — so the whole set costs nothing here.
 */
export function sharedRenderer(): Promise<Renderer> {
  ready ??= (async () => {
    const created = new Renderer();
    for (const look of LOOKS.values()) {
      for (const font of look.fonts) {
        await created.registerFont({
          name: font.family,
          data: font.data,
          weight: font.weight,
        });
      }
    }
    return created;
  })();
  return ready;
}

/** The image table takumi resolves a Template's wordmark `src` against. */
export function lookImages(look: Look): { src: string; data: Uint8Array }[] {
  const images = [{ src: LOGO_SRC, data: look.logo }];
  if (look.logoAlt) images.push({ src: LOGO_ALT_SRC, data: look.logoAlt });
  return images;
}
