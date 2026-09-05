import { deepStrictEqual } from "node:assert/strict";
import type { ZodType } from "zod";

/**
 * One conformance check, named for the rule it holds. A package runs the whole
 * array from its own Vitest file: `for (const c of checks) it(c.name, c.run)`.
 * A check reports failure by throwing; returning is a pass.
 */
export interface Check {
  name: string;
  run(): Promise<void>;
}

/** A sample under its own name. The name is what a red run prints. */
export interface Sample<T> {
  name: string;
  value: T;
}

/** What a caller hands {@link schemaConformance}. */
export interface SchemaSamples<T> {
  /** Values the schema must accept and return unchanged after a JSON round trip. */
  valid: Sample<T>[];
  /** Values the schema must refuse, each named for the rule it breaks. */
  invalid: Sample<unknown>[];
}

/**
 * Checks that a schema accepts what it must and refuses what it must, one
 * Check per sample.
 *
 * Serialisation is part of the contract, so a valid sample is asserted through
 * `JSON.parse(JSON.stringify(x))`: a schema that quietly defaults, transforms
 * or drops a field fails here, not at the seam between two modules.
 */
export function schemaConformance<T>(
  schema: ZodType<T>,
  samples: SchemaSamples<T>
): Check[] {
  const valid: Check[] = samples.valid.map((sample) => ({
    name: `accepts and round-trips ${sample.name}`,
    async run() {
      const result = schema.safeParse(JSON.parse(JSON.stringify(sample.value)));
      if (!result.success) {
        throw new Error(
          `refused a valid sample, ${sample.name}: ${result.error.message}`
        );
      }
      deepStrictEqual(
        result.data,
        sample.value,
        `a valid sample did not survive a JSON round trip: ${sample.name}`
      );
    },
  }));

  const invalid: Check[] = samples.invalid.map((sample) => ({
    name: `refuses ${sample.name}`,
    async run() {
      if (schema.safeParse(sample.value).success) {
        throw new Error(`accepted an invalid sample, ${sample.name}`);
      }
    },
  }));

  return [...valid, ...invalid];
}
