/** Where the golden images live. One place, so the writer and the check cannot drift. */
export const GOLDENS = new URL("./goldens/", import.meta.url);

/**
 * How far a fresh render may sit from its golden, in mean absolute 8-bit levels
 * per channel.
 *
 * Measured, not guessed. Every number below is a golden check's own output on
 * the committed pictures.
 *
 * - darwin-arm64 (Apple M4, Node 22.22, takumi 2.13.6, sharp 0.35.4): 0.0000.
 *   takumi is byte-deterministic within a process (ADR-0009) and, as the
 *   determinism check in `render.test.ts` shows, across calls too.
 * - linux-x64 (GitHub Actions ubuntu-latest, Node 22): 0.0000, runs 33998908844
 *   (`swisshutless-story`) and 34004148270 (`laica-post`).
 *
 * The threshold has to sit under what a wrong Look makes, and that difference
 * is small because a wordmark is 0.5 % of a story's area: swapping in the Hope
 * Family logo scores 0.3558, and `fit: "cover"` for `fit: "fill"` scores
 * 0.5592. At 0.02 the check clears both platforms by their full margin and
 * still catches the weaker of those two mutations by 18x. `laica-post`'s
 * weakest Look mutation — the Swiss Hutless wordmark in laica's place — scores
 * 0.3695 at `linkedin/post` and 0.7072 at `linkedin/wide`, so 0.02 clears it by
 * 18x too. Should the two platforms ever stop agreeing exactly, a whole-image
 * mean can no longer tell drift from a wrong Look and this has to become a
 * per-tile comparison.
 *
 * The bare Crop golden has no Look to get wrong, so the mutation it must catch
 * is a wrong resampler. `nearest` for `lanczos3` on that exact cut — the kart
 * fixture's 563x1000 window into 1080x1920 — scores 1.6234 on darwin-arm64,
 * which 0.02 clears by 81x. It scores 0.0000 against its own golden on the same
 * machine.
 */
export const GOLDEN_THRESHOLD = 0.02;
