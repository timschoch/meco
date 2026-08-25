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

Settings → Connectors → Add custom connector, with the token in the URL and no
header at all:

```
https://meco-teal.vercel.app/mcp/<MECO_TOKEN>
```

A custom connector answers a 401 by hunting for an OAuth server rather than by
sending its configured header, so the plain `/mcp` URL ends in "Registrierung
beim Anmeldedienst fehlgeschlagen". The token in the path authorises the request
on arrival, so no 401 is ever produced. That URL is as secret as the token in
it.

## Checking

`list_templates` returning five Templates means the connection is live. A 401
means the token is wrong; a hang on the first call means the container was
scaled to zero and is starting — the second call answers.
