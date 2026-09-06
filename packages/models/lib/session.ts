import { availableParallelism } from "node:os";
import * as ort from "onnxruntime-node";
import { HostError } from "./errors";

/**
 * The ONNX Runtime major every adapter version was bumped against. A runtime
 * major is one of the things a Model's version covers (contracts' rule), so a
 * host on another major must not start: it would answer for versions it does
 * not run.
 */
export const ORT_MAJOR = 1;

/** The runtime's own version string, for `/health` and the start-up guard. */
export const runtimeVersion = (): string => ort.env.versions.common;

export function assertRuntimeMajor(version: string = runtimeVersion()): void {
  const major = Number(version.split(".")[0]);
  if (major !== ORT_MAJOR) {
    throw new Error(
      `onnxruntime ${version} is not major ${ORT_MAJOR}: bump every adapter version and ORT_MAJOR together before running on it`
    );
  }
}

/**
 * One inference session for the life of the process, created on first use.
 *
 * Memoised as the promise, not the session: two requests arriving before the
 * first create settles wait on the same create. A create that fails drops the
 * memo, so a transient failure at boot does not poison every later request —
 * the next one retries and, until it succeeds, the Model is `model_unavailable`.
 */
export class ModelSession {
  private pending: Promise<ort.InferenceSession> | undefined;
  private created = false;

  constructor(private readonly path: string) {}

  /** Whether the session exists on this instance: contracts' Warm. */
  isWarm(): boolean {
    return this.created;
  }

  get(): Promise<ort.InferenceSession> {
    this.pending ??= ort.InferenceSession.create(this.path, {
      intraOpNumThreads: availableParallelism(),
    })
      .then((session) => {
        this.created = true;
        return session;
      })
      .catch((cause: unknown) => {
        this.pending = undefined;
        throw new HostError(
          "model_unavailable",
          `could not create a session for ${this.path}`,
          { cause }
        );
      });
    return this.pending;
  }
}
