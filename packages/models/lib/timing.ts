/**
 * Per-stage timing for one request: `fetch` where the bytes came over a URL,
 * `decode`, then one lap per Model, in the order they ran. Rendered as a
 * `Server-Timing` header and as one log line, never inside the Annotation,
 * which holds only what is true of the bytes.
 */
export class Laps {
  private readonly laps: [name: string, ms: number, note?: string][] = [];
  private last = performance.now();

  /** Open the first stage now, so reading the body is not charged to it. */
  start(): void {
    this.last = performance.now();
  }

  /**
   * Close the stage that just finished. A `note` is an extra `Server-Timing`
   * parameter for facts a duration cannot carry — the fetch's hop count is
   * the one, and it is a parameter rather than a lap of its own because it is
   * not a stage and must never be read as milliseconds.
   */
  lap(name: string, note?: string): void {
    const now = performance.now();
    this.laps.push([name, now - this.last, note]);
    this.last = now;
  }

  /** `fetch;dur=93.8;hops=1, decode;dur=12.3, yunet;dur=28.1` */
  serverTiming(): string {
    return this.laps
      .map(
        ([name, ms, note]) =>
          `${name};dur=${ms.toFixed(1)}${note === undefined ? "" : `;${note}`}`
      )
      .join(", ");
  }

  /** `fetch=94ms(hops=1) decode=12ms yunet=28ms` */
  summary(): string {
    return this.laps
      .map(
        ([name, ms, note]) =>
          `${name}=${ms.toFixed(0)}ms${note === undefined ? "" : `(${note})`}`
      )
      .join(" ");
  }
}
