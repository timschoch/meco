import { Renderer } from "@takumi-rs/core";
import { LOGO_SRC, type Look } from "../template";
import { LOOKS } from "./looks/registry";

let ready: Promise<Renderer> | undefined;

/**
 * The one Renderer in the process, with every Look's fonts registered.
 *
 * Registration happens once and covers all Looks rather than the one Brand in
 * hand: takumi resolves families globally, so registering per call would make
 * the picture depend on call order. This is also where every Look's font files
 * are read: `fonts()` opens them on the first call and holds them, so the disk
 * is touched once per process and never at import (#209).
 *
 * A build that threw is **not** held. Reading the fonts here is what made this
 * able to fail at all, and a rejected promise left in `ready` would turn one
 * missing file into a container that refuses every later Call until it is
 * restarted — far more than the one refusal the file is worth.
 */
export function sharedRenderer(): Promise<Renderer> {
  ready ??= buildRenderer().catch((reason: unknown) => {
    ready = undefined;
    throw reason;
  });
  return ready;
}

async function buildRenderer(): Promise<Renderer> {
  const created = new Renderer();
  for (const look of LOOKS.values()) {
    for (const font of look.fonts()) {
      await created.registerFont({
        name: font.family,
        data: font.data,
        weight: font.weight,
      });
    }
  }
  return created;
}

/**
 * The image table takumi resolves a Template's wordmark `src` against.
 *
 * `logo()` reads the file on its first call and holds it, so this runs once per
 * process however many Renders follow.
 */
export function lookImages(look: Look): { src: string; data: Uint8Array }[] {
  return [{ src: LOGO_SRC, data: look.logo() }];
}
