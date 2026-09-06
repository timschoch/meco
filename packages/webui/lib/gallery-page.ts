/**
 * The Gallery's page of Outputs: `outputs.list` per Brand, merged.
 *
 * `outputs.list` narrows to one Brand and no more, so everything hard about
 * this lives in `merge.ts`. All that is here is which records method answers
 * and what the merge orders on.
 */
import type { Output, OutputKind, Records } from "@meco/records";
import { type Merged, mergedPage } from "./merge";

/** What the Gallery was asked to narrow by, beyond the Caller's own Brands. */
export interface GalleryFilter {
  readonly placement?: string;
  readonly kind?: OutputKind;
}

export const galleryPage = (
  records: Records,
  brands: readonly string[],
  filter: GalleryFilter,
  pageSize: number,
  cursor: string | undefined
): Promise<Merged<Output>> =>
  mergedPage(
    brands,
    pageSize,
    cursor,
    (brand, from, limit) =>
      records.outputs.list({
        brand,
        ...filter,
        ...(from === undefined ? {} : { cursor: from }),
        limit,
      }),
    { brandOf: (output) => output.brand, at: (output) => output.createdAt }
  );
