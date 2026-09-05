/**
 * Raw RGB pixels, row-major, `data.length === width * height * 3`. The models
 * host decodes a Source Image once and hands the same one to everybody.
 *
 * Declared here structurally until `@meco/contracts` exports it (#95). The
 * shape is the one `docs/specs/contracts.md` fixes, so adopting the real type
 * is a one-line import and no call site changes.
 */
export interface DecodedImage {
  readonly width: number;
  readonly height: number;
  readonly channels: 3;
  readonly data: Uint8Array;
}
