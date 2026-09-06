/**
 * The factory. Everything a caller can do with identify is one of these two
 * methods, and both of them cross `packages/identify/index.ts`.
 */
import { enrolRule } from "./enrol";
import { matchRule } from "./match";
import type { Identify, IdentifyDeps } from "./types";

export function identify(deps: IdentifyDeps): Identify {
  const { records } = deps;

  return {
    async match({ annotation, brand }) {
      // One read, every Person of the Brand with every Face Print. The privacy
      // wall is which rows were read: a Person of another Brand is not filtered
      // out downstream, they were never fetched.
      const people = await records.people.list(brand);
      return matchRule(annotation, brand, people);
    },

    async enrol(input) {
      return enrolRule(deps, input);
    },
  };
}
