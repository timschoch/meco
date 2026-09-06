/**
 * The Decode Bound: the longest edge a Decoded Image may have. Measured in the
 * prototype on the 5878x7348 group fixture (`docs/specs/models.md`, "Why
 * 1600"): no box moves 0.002 between full size and any cap down to 640, and
 * the identity threshold was calibrated at this size.
 *
 * Alone in this file because the client exports it and the client may not
 * reach sharp: identify judges whether a face was large enough to identify in
 * the pixels EdgeFace saw, and holds no copy of the number.
 */
export const DECODE_BOUND = 1600;
