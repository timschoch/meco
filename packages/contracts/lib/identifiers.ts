import { z } from "zod";

/**
 * Bare sha256 of a Source Image's bytes. No algorithm prefix: the schema fixes
 * it. Its own file because both the Annotation and the FramingRequest name the
 * bytes, and neither of those two should have to import the other to do it.
 */
export const ContentHash = z.string().regex(/^[0-9a-f]{64}$/);

/** Whose output this is. A plain string; contracts fixes no id scheme. */
export const Brand = z.string().min(1);

/** A named Person, by the id the identify module filed them under. */
export const PersonId = z.string().min(1);
