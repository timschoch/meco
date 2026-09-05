/**
 * Per-stage timing for one request: `decode`, then one lap per Model, in the
 * order they ran. Rendered as a `Server-Timing` header and as one log line,
 * never inside the Annotation, which holds only what is true of the bytes.
 */
export class Laps {
  private readonly laps: [name: string, ms: number][] = [];
  private last = performance.now();

  /** Close the stage that just finished. */
  lap(name: string): void {
    const now = performance.now();
    this.laps.push([name, now - this.last]);
    this.last = now;
  }

  /** `decode;dur=12.3, yunet;dur=28.1` */
  serverTiming(): string {
    return this.laps
      .map(([name, ms]) => `${name};dur=${ms.toFixed(1)}`)
      .join(", ");
  }

  /** `decode=12ms yunet=28ms` */
  summary(): string {
    return this.laps
      .map(([name, ms]) => `${name}=${ms.toFixed(0)}ms`)
      .join(" ");
  }
}
