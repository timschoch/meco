/**
 * Build a Template registry, refusing any Template whose Brand has no Look.
 *
 * A Template and the Look it renders in are both code, so a Template naming a
 * Brand nothing draws for is a build mistake and not something a caller can
 * cause. Refused as the map is built — at module load for the Templates that
 * ship, and at registration time for a loader that brings its own (#65) —
 * rather than at the first `plan` that names it. The message carries the
 * Template id, because that is the file the author has to edit.
 *
 * Structurally typed rather than typed to `Template` and `Look`: those live in
 * `template.ts`, which exports this function, and importing them back would
 * close a cycle. Everything this needs is the id and the Brand.
 */
export function registerTemplates<T extends { id: string; brand: string }>(
  templates: readonly T[],
  looks: ReadonlyMap<string, unknown>
): ReadonlyMap<string, T> {
  return new Map(
    templates.map((template) => {
      if (!looks.has(template.brand)) {
        throw new Error(
          `Template "${template.id}" names Brand "${template.brand}", which has no Look.`
        );
      }
      return [template.id, template];
    })
  );
}
