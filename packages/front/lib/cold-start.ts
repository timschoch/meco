/**
 * The one case the front does not merely forward: a `tools/call` that arrives
 * while the gateway container is scaled to zero. A cold start takes seconds,
 * and an agent that hears nothing for that long gives up or guesses. So the
 * call is forwarded at once and a probe races it: when the probe hears
 * nothing inside its timeout, the front opens the Streamable HTTP stream and
 * says what is happening as JSON-RPC notifications — which the spec lets a
 * server send on the request's own stream before the final response — then
 * confirms the moment the gateway answers the forwarded call and pipes the
 * real result through unchanged. The platform holds a request to a container
 * that is starting, so the forwarded call itself is the wait; nothing is
 * sent twice and nothing polls.
 */

export interface ColdStart {
  /**
   * What the first notice promises: "about N seconds". The last measured
   * gateway cold start, from `DEPLOY.md`; a constant, so it is never a guess.
   */
  readonly seconds: number;
  /**
   * How long the probe waits for any answer before the gateway counts as
   * cold. A warm container answers `GET /mcp` from its middleware, with no
   * database or store behind it, in a few milliseconds over the binding.
   */
  readonly probeTimeoutMs: number;
}

export const COLD_START: ColdStart = {
  seconds: 7,
  probeTimeoutMs: 500,
};

/** What a `tools/call` carries that its notifications have to name. */
export interface ToolCall {
  readonly id: string | number | null;
  readonly progressToken?: string | number;
}

/**
 * The `tools/call` in a POST body, or `null` for any other message — a body
 * that is not JSON included, which is forwarded for the gateway to refuse.
 */
export function toolCall(body: string): ToolCall | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  const messages: unknown[] = Array.isArray(parsed) ? parsed : [parsed];
  for (const message of messages) {
    if (typeof message !== "object" || message === null) continue;
    const { method, id, params } = message as {
      method?: unknown;
      id?: unknown;
      params?: { _meta?: { progressToken?: unknown } };
    };
    if (method !== "tools/call") continue;
    const token = params?._meta?.progressToken;
    return {
      id: typeof id === "string" || typeof id === "number" ? id : null,
      ...(typeof token === "string" || typeof token === "number"
        ? { progressToken: token }
        : {}),
    };
  }
  return null;
}

const frame = (message: unknown): string =>
  `event: message\ndata: ${JSON.stringify(message)}\n\n`;

/**
 * The news as `notifications/message` (level info), which every client may
 * receive, and as `notifications/progress` too when the call asked for
 * progress — the SDK client drops a progress notification whose token it
 * never issued, so that one is sent only when it will be heard.
 */
function notices(call: ToolCall, text: string, progress: number): unknown[] {
  const out: unknown[] = [
    {
      jsonrpc: "2.0",
      method: "notifications/message",
      params: { level: "info", logger: "meco", data: text },
    },
  ];
  if (call.progressToken !== undefined) {
    out.push({
      jsonrpc: "2.0",
      method: "notifications/progress",
      params: { progressToken: call.progressToken, progress, message: text },
    });
  }
  return out;
}

const rpcError = (call: ToolCall, message: string, data?: unknown) => ({
  jsonrpc: "2.0",
  id: call.id,
  error: { code: -32000, message, ...(data === undefined ? {} : { data }) },
});

export interface ColdStartStream {
  readonly call: ToolCall;
  readonly config: ColdStart;
  /** The call, already on its way to the gateway. */
  readonly forwarded: Promise<Response>;
}

/**
 * The response for a cold `tools/call`: the stream opens at once with the
 * first notice, the confirmation follows when the gateway answers the call
 * that is already in flight, then whatever it answered. An SSE answer is
 * piped byte for byte; a JSON one becomes the stream's final frame; a refusal
 * or a failure becomes a JSON-RPC error with the call's id, because the
 * status line has already been sent.
 */
export function coldStartStream(deps: ColdStartStream): Response {
  const { call, config } = deps;
  const encoder = new TextEncoder();
  const run = async (
    controller: ReadableStreamDefaultController<Uint8Array>
  ): Promise<void> => {
    const send = (message: unknown): void => {
      controller.enqueue(encoder.encode(frame(message)));
    };
    for (const notice of notices(
      call,
      `meco is starting, about ${config.seconds} seconds`,
      0
    )) {
      send(notice);
    }
    let response: Response;
    try {
      response = await deps.forwarded;
    } catch (error) {
      send(
        rpcError(
          call,
          `meco did not answer, send the call again: ${String(error)}`
        )
      );
      return;
    }
    for (const notice of notices(
      call,
      "meco is up, your request is now being processed",
      1
    )) {
      send(notice);
    }
    if (!response.ok) {
      send(
        rpcError(
          call,
          `meco answered ${response.status}`,
          await response.text()
        )
      );
      return;
    }
    if (response.headers.get("content-type")?.includes("text/event-stream")) {
      if (response.body !== null) {
        for await (const chunk of response.body) controller.enqueue(chunk);
      }
      return;
    }
    controller.enqueue(
      encoder.encode(`event: message\ndata: ${await response.text()}\n\n`)
    );
  };
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      void run(controller)
        .catch((error: unknown) => {
          controller.enqueue(
            encoder.encode(frame(rpcError(call, String(error))))
          );
        })
        .finally(() => controller.close());
    },
  });
  return new Response(stream, {
    status: 200,
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
    },
  });
}
