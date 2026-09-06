import { describe, expect, it } from "vitest";
import { Annotation, isComplete, type ModelId } from "@meco/contracts";
import {
  FACE_FIXTURES,
  KART_FIXTURES,
  PODIUM_FIXTURES,
  RECORDED_MODELS,
} from "./samples";

/**
 * Every fixture under `fixtures/` is a recording of one photograph through the
 * shipped `models` Catalogue, written by `tests/record.ts` (#109). Before that
 * they were conversions of the prototype's `detected.json` and `objects.json`,
 * made by a Model nobody could re-run, and the boxes underneath frame's whole
 * suite were inherited rather than reproducible.
 *
 * These checks are what stops that happening again. They say nothing about
 * geometry — the rung tests do that — only that the numbers the rung tests
 * stand on came from the Models this build actually ships.
 */
const RECORDINGS = [...FACE_FIXTURES, ...PODIUM_FIXTURES, ...KART_FIXTURES];

/** One string per `{ name, version }`, so two Models compare as a whole. */
const modelKey = (model: ModelId) => `${model.name}@${model.version}`;

describe("the fixtures are recordings of the shipped Catalogue", () => {
  for (const { name, raw } of RECORDINGS) {
    it(`names every Model that ran, version and all: ${name}`, () => {
      const annotation = Annotation.parse(raw);

      expect(annotation.producedBy).toEqual(RECORDED_MODELS);
      // The consumer's own question, asked the way a cache asks it: an
      // Annotation that answers `false` here is a cache miss and would be
      // re-annotated in production rather than used.
      expect(isComplete(annotation, RECORDED_MODELS)).toBe(true);
    });

    it(`draws every Region with a Model that ran: ${name}`, () => {
      const { regions } = Annotation.parse(raw);
      const ran = RECORDED_MODELS.map(modelKey);

      const drawnBy = regions.map((r) => modelKey(r.model));
      const printedBy = regions
        .filter((r) => r.facePrint !== undefined)
        .map((r) => modelKey(r.facePrint!.model));

      expect(
        [...drawnBy, ...printedBy].filter((k) => !ran.includes(k))
      ).toEqual([]);
    });
  }
});
