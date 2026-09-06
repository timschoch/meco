/**
 * A fraction as a CSS per cent.
 *
 * Per cent and not pixels, because that is what makes the Overlay hold at any
 * display width without a script: the browser resolves it against the box the
 * Source Thumbnail actually got.
 *
 * Rounded to four decimals, which at 4 000 px is a hundredth of a pixel, and
 * printed without trailing zeros so a test can name the value it expects.
 */
export const percent = (fraction: number): string =>
  `${Number((fraction * 100).toFixed(4))}%`;
