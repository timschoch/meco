/**
 * The MCP Door: `createMcpHandler` from `@modelcontextprotocol/server`,
 * stateless, one `McpServer` per request built from the Operation table
 * (ADR-0014, Decision 2). A tool's `inputSchema` is the Operation's own zod
 * object; its result is the same JSON the HTTP route answers, as text and as
 * `structuredContent`; its error is `toWire`'s body as text with `isError`.
 *
 * The handler is made per request so the Caller reaches the factory as a
 * closure: no token is faked into the SDK's `authInfo`, and the Brand Wall
 * inside a tool is the same `run` as inside a route.
 */
import { McpServer, createMcpHandler } from "@modelcontextprotocol/server";
import type { Caller } from "@meco/records";
import { toWire } from "./errors";
import { type Operation, type OperationDeps, run } from "./operations";

export function mcpDoor(
  operations: readonly Operation[],
  deps: OperationDeps,
  version: string
): (request: Request, caller: Caller) => Promise<Response> {
  const serverFor = (caller: Caller): McpServer => {
    const server = new McpServer({ name: "meco", version });
    for (const operation of operations) {
      server.registerTool(
        operation.name,
        { description: operation.description, inputSchema: operation.input },
        async (args) => {
          try {
            const result = await run(operation, deps, caller, args);
            return {
              content: [{ type: "text", text: JSON.stringify(result) }],
              structuredContent: result,
            };
          } catch (error) {
            const { body } = toWire(error);
            return {
              isError: true,
              content: [{ type: "text", text: JSON.stringify(body) }],
            };
          }
        }
      );
    }
    return server;
  };

  return (request, caller) =>
    createMcpHandler(() => serverFor(caller), { legacy: "stateless" }).fetch(
      request
    );
}
