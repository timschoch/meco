/**
 * Raw RGB pixels, row-major, decoded once by the host.
 *
 * The shape `docs/specs/contracts.md` fixes for `@meco/contracts`. It is
 * declared here only because contracts has not shipped it yet — it lands with
 * the adapter edge (#95). When it does, this file becomes a re-export and every
 * caller is unaffected, because the two are structurally identical.
 */
export interface DecodedImage {
  readonly width: number;
  readonly height: number;
  readonly channels: 3;
  /** `width * height * 3` bytes. */
  readonly data: Uint8Array;
}
