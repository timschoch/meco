import { area } from "./boxes";
import { frameCrop } from "./frame-crop";
import { freeArea } from "./free-area";
import type { Framing, VariantRequest, VariantsInput } from "./framing";

/**
 * A candidate reduced to what the choice reads, in the order it reads it.
 *
 * `occlusionClear` before `satisfied`, and the reason is the defect that
 * earned Variants at all (#228): a 3:2 photograph into a 9:16 story is a
 * full-height column, so a Subject at the bottom sits under a bottom caption
 * whatever the aim does, and the only remedy is a caption somewhere else. On
 * that photograph every Variant clips — no layout widens a 300 px window
 * around a 411 px Subject — and every Variant leaves the same Free Area, so
 * the flag that says whether the Leading Subject is under the type is the
 * one number that separates them. The larger Free Area, then the smaller
 * Subject Area shortfall, break the ties that remain.
 *
 * A field a Framing does not carry is neutral: nothing composed, nothing to
 * keep off a zone, so every Variant is as good as the next and the Template's
 * order decides.
 */
interface Score {
  readonly clear: number;
  readonly satisfied: number;
  readonly free: number;
  readonly shortfall: number;
}

/** True beats false; absent is neutral and ranks between the two. */
const rank = (flag: boolean | undefined): number =>
  flag === undefined ? 0.5 : flag ? 1 : 0;

const scoreOf = (candidate: VariantRequest, framing: Framing): Score => ({
  clear: rank(framing.occlusionClear),
  satisfied: rank(framing.satisfied),
  free:
    candidate.request.occlusion.length === 0
      ? 1
      : area(
          freeArea(candidate.request.occlusion, candidate.request.subjectArea)
        ),
  // Absent when no area was named, and 1 is the value that means "nothing
  // fell short", so it is the neutral one too.
  shortfall: framing.subjectAreaShortfall ?? 1,
});

/**
 * How near two areas or two ratios have to be to count as the same. Two
 * Variants that mirror one layout leave Free Areas equal by construction and
 * arrive at them by different sums of the same coordinates, so without this
 * the Template's preference would be decided by the last bit of a float —
 * the same reason `lib/free-area.ts` keeps one.
 */
const TIE = 1e-9;

/**
 * Whether one candidate beats another. Strictly: an equal score leaves the
 * incumbent, which is the earlier Variant, which is the Template's preference.
 */
const beats = (candidate: Score, best: Score): boolean => {
  if (candidate.clear !== best.clear) return candidate.clear > best.clear;
  if (candidate.satisfied !== best.satisfied) {
    return candidate.satisfied > best.satisfied;
  }
  if (Math.abs(candidate.free - best.free) > TIE) {
    return candidate.free > best.free;
  }
  return best.shortfall - candidate.shortfall > TIE;
};

/**
 * `frameCrop` over every Variant a Template offers, answering the Framing
 * that keeps the Subject clearest and naming the Variant it was framed for.
 *
 * Each candidate is framed on its own request, so a Variant's own Occlusion
 * Zones and Subject Area are what its window is aimed by; nothing about one
 * layout leaks into another's answer. One unnamed candidate is `frameCrop`
 * itself, with no `variant` on the Framing.
 */
export function frameVariants(input: VariantsInput): Framing {
  const [first, ...rest] = input.variants;
  if (first === undefined) {
    throw new RangeError("frameVariants needs at least one Variant to frame");
  }

  const framed = (candidate: VariantRequest) => {
    const framing = frameCrop({
      annotation: input.annotation,
      ...(input.matches === undefined ? {} : { matches: input.matches }),
      request: candidate.request,
    });
    return {
      score: scoreOf(candidate, framing),
      framing:
        candidate.variant === undefined
          ? framing
          : { ...framing, variant: candidate.variant },
    };
  };

  let best = framed(first);
  for (const candidate of rest) {
    const contender = framed(candidate);
    if (beats(contender.score, best.score)) best = contender;
  }
  return best.framing;
}
