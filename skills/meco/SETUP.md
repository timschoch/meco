# Connecting the meco MCP server

Reached from [SKILL.md](SKILL.md) when the `meco` tools are missing. Ask the user
to run the step for the client they are in, then stop — the connection only
takes effect once the client reloads it.

The endpoint is `https://meco-teal.vercel.app/mcp` and it needs a bearer token.
Read the token with `vercel env pull` in a checkout of `timschoch/meco`, or ask
the user for it. Never paste it into a file that gets committed.

## Claude Code

```bash
claude mcp add --transport http meco https://meco-teal.vercel.app/mcp \
  --header "Authorization: Bearer <MECO_TOKEN>"
```

Add `--scope user` to reach it from every project instead of this one.

## Claude Desktop

Settings → Connectors → Add custom connector, with the URL above and this header:

| Field | Value |
|---|---|
| Name | `x-auth-token` |
| Value | the token on its own, with no `Bearer` prefix |

Claude Desktop reserves `Authorization` for its own OAuth flow and greys it out,
so `x-auth-token` is the name to pick from the dropdown. meco accepts either.

## Checking

`list_templates` returning five Templates means the connection is live. A 401
means the token is wrong; a hang on the first call means the container was
scaled to zero and is starting — the second call answers.
