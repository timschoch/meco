# ADR-0013 — webui: server-rendered HTML inside the gateway, the API key at the door, and a Source Image seen only through a redirect

Status: **accepted, 6 Sep 2026**. Parent: [Module: webui (#89)](https://github.com/timschoch/meco/issues/89), under the modular rebuild map [#60](https://github.com/timschoch/meco/issues/60). Spec: [`../specs/webui.md`](../specs/webui.md). Vocabulary: [`CONTEXT.md`, webui](../../CONTEXT.md#webui). Builds on [Two services: gateway and models (#61)](https://github.com/timschoch/meco/issues/61) (webui is a library inside the gateway container), [How the gateway knows the caller (#77)](https://github.com/timschoch/meco/issues/77), [ADR-0010](0010-store-vercel-blob-in-the-eu-two-stores.md) (a Source Image is private; a Signed URL is minted only by the gateway) and [ADR-0011](0011-records-postgres-rows-counted-deletes-and-a-sweep.md) (the Gallery is `outputs.list`; a failed Call is a row). Decided by the orchestrator with the webui agent, the owner away; the grilling is ledgered on #89.

## Context

The map names the webui second-class: it shows the Gallery and what happened, and reads records and nothing else. The prototype was one 1002-line HTML string with the bearer token in `localStorage` and every fact fetched by client script from `/v1/*`; its Gallery was a store listing. The greenfield rule gives none of that a vote. Three choices below are the ones a later reader will want to reopen, and each has a reason that is not taste.

## Decision 1 — HTML rendered on the server by Hono, no client script, no second service

`hono/jsx` components rendered to a string per request inside the gateway container. The gateway already carries `hono@4.13.3`, and `hono/jsx` is in it, so the webui adds no dependency, no bundle step and no runtime in the browser. Filters and paging are links. Every page is a document that `curl` can read, which is also how the tests read it.

Rejected: React or Next as a third service or a static build. A second deploy shape (`DEPLOY.md` measures what each one costs to get right), a client runtime and a hydration step, for pages whose whole job is to list rows and show one Call. Nothing in the brief needs a page to change without a reload. If live updates ever earn their place, they are a fetch from a page that already exists, not a reason to start with a framework.

Rejected: the prototype's shape, one page plus client fetches of the API. It made the browser hold the key in `localStorage` and made every page a second client of the API that had to be kept in step with it.

## Decision 2 — the API key opens the door, over HTTP Basic

A browser cannot set `Authorization: Bearer` on a navigation. `/ui/*` without a Caller answers `401` with `WWW-Authenticate: Basic realm="meco"`; the browser prompts and the key goes in the password field. The gateway's auth accepts `Basic` beside `Bearer` on every route and looks the Caller up the same way. webui receives the gateway's lookup as a function and never sees a key, so there is one door and one secret.

Rejected: a login form and an HttpOnly cookie. It is a session with none of the things a session needs, a form, a POST, a logout, cookie parsing, for a UI whose every route is `GET`. It also duplicates the one lookup the gateway already does. The day accounts arrive ([#63](https://github.com/timschoch/meco/issues/63)), the door is the gateway's to change and webui does not move.

Rejected: the key in a query string. It lands in logs and in browser history.

Cost accepted: logging out means closing the browser, and the browser dialog is plain. Both are fine for a second-class UI with three Brands and one Caller.

## Decision 3 — a Source Image is seen through a redirect, never through a URL in the page

The Call View shows the Source Image, which is private (ADR-0010). Its `<img>` points at `/ui/calls/:id/source`, a route inside the webui that runs behind the gateway's auth, checks `sources.heldBy(call.brand, call.sourceHash)`, and answers `302` to a Signed URL valid for 60 seconds. The HTML holds no Signed URL, so a saved or forwarded page holds nothing, and the mint happens inside the gateway on a records row, which is what `CONTEXT.md`'s Signed URL entry asks for.

Rejected: minting the Signed URL while rendering and inlining it in the `src`. The page is then a five-minute key to a photograph of people who consented to nothing, and pages get saved.

Rejected: a gateway API route `GET /v1/sources/:hash`. The right shape the day an API client wants to see a source; nothing asks for it today, and the webui route can move onto it then.

## Consequences

- The webui depends on `hono`, `@meco/records` and `@meco/store` and on nothing else. It is deletable: removing the mount line in the gateway removes the module with no other change.
- A Render is 0.7 to 2.5 MB PNG (compose goldens, 6 Sep 2026) and Blob does not transform on read, so a Gallery page of twelve stories weighs up to about 30 MB. The page size is 12 for that reason. A thumbnail Output belongs to compose or the gateway; a module that resizes touches pixels, and this one may not.
- Every page is testable with `app.request()` against pglite and the in-memory store, with assertions on the HTML string. No browser is in the gate.
- Accepting `Basic` is a one-line change in the gateway's auth parser and is recorded on [Module: gateway (#88)](https://github.com/timschoch/meco/issues/88).
