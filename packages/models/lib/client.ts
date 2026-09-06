// The Models Client: `models` over HTTP, typed against the wire.
import { z } from "zod";
import { Annotation } from "@meco/contracts";
import type { ErrorCode } from "./errors";
import {
  type AnnotateOptions,
  CatalogueEntry,
  ModelsHealth,
  WireError,
} from "./wire";

/**
 * Why a call failed: every code the host puts on the wire, plus the four the
 * client raises on its own. The two sets share no word, so one `code` always
 * says which side refused.
 */
export type ModelsErrorCode =
  | ErrorCode
  /** The call never reached models. */
  | "unreachable"
  /** models did not answer within `timeoutMs`. */
  | "timeout"
  /** models answered something this client cannot vouch for. */
  | "bad_response"
  /** The Annotation names a hash other than the one the caller filed. */
  | "hash_mismatch";

/** Every failure of a `ModelsClient` call, with the code the caller branches on. */
export class ModelsError extends Error {
  constructor(
    readonly code: ModelsErrorCode,
    message: string,
    /** The status that carried it, or `undefined` when no response arrived. */
    readonly status: number | undefined,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = "ModelsError";
  }
}

/**
 * How the client reaches models. The global `fetch` in production; in a test,
 * `createApp(catalogue).fetch`, which is the same pair without a socket.
 */
export type FetchLike = (request: Request) => Response | Promise<Response>;

/**
 * One entry of the `Server-Timing` header on one `/annotate`: the host's own
 * clock, `decode` then one per Model in the order they ran. Never inside the
 * Annotation; the gateway files each as a Step.
 */
export interface ServerTimingEntry {
  readonly name: string;
  readonly durMs: number;
}

export interface Annotated {
  readonly annotation: Annotation;
  readonly serverTiming: readonly ServerTimingEntry[];
}

export interface ModelsClient {
  /** Annotate the bytes. The Annotation is parsed before it is returned. */
  annotate(bytes: Uint8Array, options?: AnnotateOptions): Promise<Annotation>;
  /** The same call, with the host's `Server-Timing` beside the Annotation. */
  annotateTimed(bytes: Uint8Array, options?: AnnotateOptions): Promise<Annotated>;
  /** The Catalogue this deployment holds. */
  catalogue(): Promise<CatalogueEntry[]>;
  /** The answering instance's liveness, warmth and memory. */
  health(): Promise<ModelsHealth>;
}

export interface ModelsClientOptions {
  /** Where models answers, e.g. the service binding's URL. */
  baseUrl: string;
  fetch?: FetchLike;
  /**
   * How long one call may take. The default fits a cold instance creating
   * every session in the Catalogue one after another.
   */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * `decode;dur=12.3, yunet;dur=28.1` as stages, in the header's order. An
 * entry without a `dur` is not a stage of the host's clock and is skipped.
 */
function serverTiming(header: string | null): ServerTimingEntry[] {
  if (header === null) return [];
  const found: ServerTimingEntry[] = [];
  for (const entry of header.split(",")) {
    const [name, ...params] = entry.trim().split(";");
    const dur = params
      .map((p) => p.trim())
      .find((p) => p.startsWith("dur="))
      ?.slice(4);
    if (!name || dur === undefined) continue;
    const durMs = Number(dur);
    if (Number.isFinite(durMs)) found.push({ name, durMs });
  }
  return found;
}

export function createModelsClient(options: ModelsClientOptions): ModelsClient {
  const base = options.baseUrl.replace(/\/+$/, "");
  const call = options.fetch ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  /**
   * One call: send it, refuse anything that is not a 200 carrying a body this
   * schema parses. Every exit is a `ModelsError`, so a caller never has to
   * tell a `TypeError` from a refusal.
   */
  async function send<T>(
    path: string,
    schema: z.ZodType<T>,
    init: RequestInit = {}
  ): Promise<{ body: T; status: number; headers: Headers }> {
    const signal = AbortSignal.timeout(timeoutMs);
    let response: Response;
    try {
      // The clock can run out before the call is even made, on a busy process
      // or behind a queue. Ask the signal first, so that case ends as a
      // `timeout` rather than waiting on a fetch that will never be answered.
      signal.throwIfAborted();
      const request = new Request(`${base}${path}`, { ...init, signal });
      // Raced, not merely passed: `timeoutMs` is this client's promise to its
      // caller, and a fetch it was handed is free to ignore a signal.
      response = await Promise.race([
        call(request),
        new Promise<never>((_, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          });
        }),
      ]);
    } catch (cause) {
      // The signal, not the thrown value: an injected fetch is free to reject
      // with whatever it likes, and only the signal knows why it was cut off.
      if (signal.aborted) {
        throw new ModelsError(
          "timeout",
          `models did not answer ${path} within ${timeoutMs}ms`,
          undefined,
          { cause }
        );
      }
      throw new ModelsError(
        "unreachable",
        `models could not be reached at ${base}${path}`,
        undefined,
        { cause }
      );
    }

    const text = await response.text();
    if (!response.ok) throw refusal(path, response.status, text);

    let body: unknown;
    try {
      body = JSON.parse(text) as unknown;
    } catch (cause) {
      throw new ModelsError(
        "bad_response",
        `models answered ${path} with a body that is not JSON`,
        response.status,
        { cause }
      );
    }

    const parsed = schema.safeParse(body);
    if (!parsed.success) {
      throw new ModelsError(
        "bad_response",
        `models answered ${path} with a body this client cannot parse: ${parsed.error.message}`,
        response.status,
        { cause: parsed.error }
      );
    }
    return { body: parsed.data, status: response.status, headers: response.headers };
  }

  /**
   * A failure status, as the caller's error. The host's own code is kept when
   * the body carries one; anything else is `bad_response`, because a status
   * without the wire's body did not come from models' own hand.
   */
  function refusal(path: string, status: number, text: string): ModelsError {
    let body: unknown;
    try {
      body = JSON.parse(text) as unknown;
    } catch {
      body = undefined;
    }
    const wire = WireError.safeParse(body);
    if (wire.success) {
      return new ModelsError(
        wire.data.error.code,
        wire.data.error.message,
        status
      );
    }
    return new ModelsError(
      "bad_response",
      `models answered ${path} with ${status} and no error body: ${text.slice(0, 200)}`,
      status
    );
  }

  const annotateTimed = async (
    bytes: Uint8Array,
    annotateOptions: AnnotateOptions = {}
  ): Promise<Annotated> => {
    const query = annotateOptions.models
      ? `?models=${encodeURIComponent(annotateOptions.models.join(","))}`
      : "";
    const {
      body: annotation,
      status,
      headers,
    } = await send(`/annotate${query}`, Annotation, {
      method: "POST",
      // A copy, so a caller that reuses its buffer cannot change the body
      // out from under an in-flight request.
      body: new Uint8Array(bytes),
    });

    const { hash } = annotateOptions;
    if (hash !== undefined && annotation.hash !== hash) {
      throw new ModelsError(
        "hash_mismatch",
        `models annotated ${annotation.hash}, not the ${hash} it was sent`,
        status
      );
    }
    return {
      annotation,
      serverTiming: serverTiming(headers.get("server-timing")),
    };
  };

  return {
    annotate: async (bytes, annotateOptions) =>
      (await annotateTimed(bytes, annotateOptions)).annotation,

    annotateTimed,

    catalogue: async () =>
      (await send("/models", z.array(CatalogueEntry))).body,

    health: async () => (await send("/health", ModelsHealth)).body,
  };
}
