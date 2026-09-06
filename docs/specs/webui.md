# Spec: the webui module

Parent: [Module: webui (#89)](https://github.com/timschoch/meco/issues/89). Reasons: [ADR-0013](../adr/0013-webui-server-rendered-html-inside-the-gateway.md). Vocabulary: [`CONTEXT.md`, webui](../../CONTEXT.md#webui). Records: [`records.md`](records.md). Store: [`store.md`](store.md). Package layout: [`packages/README.md`](../../packages/README.md).

## Problem statement

meco answers over HTTP and MCP with a URL and a JSON body. A person who wants to know what meco made for a Brand this week, why a Crop landed where it did, which Model took the time, or why a Call failed has to read rows. Nothing shows the Gallery, and a failed Call is a row nobody sees.

## Solution

One package, `@meco/webui`, a Hono sub-app the gateway mounts at `/ui`. It renders HTML on the server and ships no client script. Three pages: the Gallery, the Call View, and the Calls list. It reads `@meco/records` through its interface and asks `@meco/store` for URLs only. It is second-class: it changes nothing, and if it were deleted the API would not notice.

## User stories

1. As a Brand's editor, I want a grid of my Outputs newest first, so that I see what meco made without an API client.
2. As a Brand's editor, I want to narrow the Gallery to one Brand, one Placement or one kind, so that I find the story I made yesterday among the posts.
3. As a Brand's editor, I want an "older" link that never repeats or skips an Output, so that I can page through everything.
4. As a Brand's editor, I want to open an Output and see the Source Image beside it, so that I can judge the Crop against the photograph.
5. As a Brand's editor, I want the Crop Window and every Region drawn over the Source Image, so that I see what frame saw and what it chose.
6. As a Brand's editor, I want the Matches named, so that I know which Person frame pinned to and which faces were strangers.
7. As a Brand's editor, I want every hidden face listed by Region, so that I know what Face Blur did.
8. As the owner, I want every Step of a Call with its duration, so that I see which module or Model took the time.
9. As the owner, I want a Call's cost shown when the gateway priced it, so that pricing has a place to land.
10. As the owner, I want failed Calls listed with their module, code and message, so that a failure is a page and not a gap in the Gallery.
11. As the owner, I want a retry to show as a Call whose only Step is `records.replay`, so that "why is there one Output and two Calls" answers itself.
12. As a caller, I want to open `/ui` with the key I already use for the API, so that I hold one secret.
13. As a caller, I want to see only the Brands my key holds, so that the Brand wall holds on the page as it does on the API.
14. As the owner, I want a Source Image never to appear at a URL that outlives the request, so that a saved page does not leak a photograph.
15. As a developer, I want the whole suite to run on pglite and the in-memory store in the gate, so that a webui test never reaches Neon or Blob.
16. As a developer, I want the page proved on the preview by hand, so that what a person sees is what was tested.
17. As a gateway author, I want one function that returns a sub-app, so that mounting the webui is one line.

## Implementation decisions

### The exported surface

```ts
// packages/webui/index.ts
export function webui(options: WebuiOptions): Hono;

export interface WebuiOptions {
  records: Records; // @meco/records; the only data source
  store: Pick<Store, "publicUrl" | "signedUrl">; // URLs only, never bytes
  caller(request: Request): Promise<Caller | null>; // the gateway's own lookup
  basePath?: string; // where the gateway mounts it, default "/ui"
  pageSize?: number; // rows per page on both lists, default 12
}
```

One root file, one function. The gateway calls `app.route("/ui", webui({ records, store, caller }))`. Everything under `lib/` is private: the pages, the layout, the overlay arithmetic, the query parsing.

`caller` is the gateway's function, passed in. The gateway parses `Authorization` and looks the Caller up once; webui never calls `callers.byKey` and never sees a key. One door.

### Rendering

`hono/jsx`, server-side, rendered to a string per request with `c.html()`. No client script, no bundle, no framework outside `hono`, which the gateway already carries. Filters are links, paging is a link, there is no form that writes. The page is a document: it works with images off and in `curl`.

Why not React or Next: a second deploy shape and a client runtime for pages that list rows. The reasons are in ADR-0013.

Styling is one `<style>` block in the layout, system fonts, no CSS framework. Dark on light; the colours are not a Look.

### The pages

| Path                   | Page       | Shows                                                                                                                                                                                                                                                                                     |
| ---------------------- | ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/ui`                  | Gallery    | Outputs newest first as a grid: the image at its Public URL, kind, Placement, Brand, when, the Call's status. Query `brand`, `placement`, `kind`, `cursor`. An "older" link carries the next cursor.                                                                                      |
| `/ui/calls`            | Calls list | Calls newest first: when, Brand, kind, status, duration, error code. Query `brand`, `status`, `cursor`.                                                                                                                                                                                   |
| `/ui/calls/:id`        | Call View  | One Call: the Source Thumbnail under the Overlay, the request as sent, the Framing with the Variant it chose read out on its own line, the Matches with Person names, the Redaction Records, the Steps as bars, the cost, the error, and the Outputs this Call made at their Public URLs. |
| `/ui/calls/:id/source` | redirect   | `302` to a Signed URL for the Call's Source Image, 60 seconds, after `sources.heldBy(call.brand, call.sourceHash)`.                                                                                                                                                                       |

Every Gallery card links to its Call View. There is no Output page: an Output is keyed `(brand, request_hash)` (#224, ADR-0011, Decision 3) and its story is its Call. A Replay records no Output of its own, because that key already names the one the first Call made; the Call View reads it back by Request Hash.

### Who may see what

- No cookie, no session, no login page. `/ui/*` without a Caller answers `401` with `WWW-Authenticate: Basic realm="meco"`. The browser prompts; the key goes in the password field, the user name is ignored. The gateway's auth accepts `Bearer <key>` and `Basic <base64(user:key)>` on every route, so the same key opens both doors.
- The Gallery and the Calls list show the Caller's Brands and no other. `?brand=` naming a Brand the Caller does not hold is `403`, body naming `brand_not_held`, the API's code.
- A Call of a Brand the Caller does not hold is `404`, identical to an unknown id, so the page does not say the id exists.
- The Source Thumbnail is `<img src="/ui/calls/:id/source">`. The redirect route runs inside the gateway behind its auth, checks the Source Hold, and mints a Signed URL for 60 seconds. The HTML never holds the Signed URL, so a saved page holds nothing. A Call whose Brand holds no Source Hold on that hash answers `404`.
- Public URLs for Outputs are `store.publicUrl(storeKey)`, arithmetic, no I/O.

### What webui reads

| Records method    | Used for                                                   |
| ----------------- | ---------------------------------------------------------- |
| `outputs.list`    | the Gallery, and the Outputs of one Call (`callId` filter) |
| `calls.list`      | the Calls list, one Brand at a time, `status` in SQL       |
| `calls.get`       | the Call View                                              |
| `files.get`       | the Source Image's Store Key and size for the Overlay      |
| `annotations.get` | the Regions drawn in the Overlay                           |
| `sources.heldBy`  | whether the Source Thumbnail may be shown                  |
| `brands.list`     | Brand names for the filter links                           |
| `people.get`      | a Person's name beside a Match                             |

Never SQL, never `store.list`, never `store.get`, never a module that touches pixels. `outputs.list({ callId })` is one optional filter records adds on [records: Calls, Outputs, the Request Hash and the counted delete (#162)](https://github.com/timschoch/meco/issues/162).

### The Overlay

Regions and the Crop Window are drawn as positioned elements over the Source Thumbnail, in per cent of the image box. A Region's box is already in fractions; the Crop Window is in Source Image pixels and is divided by the File's `width` and `height`. No script: the elements hold at any display width because per cent does. A Region with a Match shows the Person's name; a Region in the Redaction Records shows `hidden`; every other face shows its Region id. A Call with no Framing (a failed or `annotate` Call) draws the Regions alone.

### Page weight

A Render measures 0.7 to 2.5 MB PNG (compose goldens, `packages/compose/tests/goldens`, seven files, 6 Sep 2026). The Gallery loads full Renders because Blob has no transform on the read path and webui may not resize. So `pageSize` defaults to 12, every `<img>` carries `loading="lazy"` and `decoding="async"`, and a page is at most about 30 MB when every card is a story. A thumbnail Output is compose's or the gateway's to add, never webui's.

### Times, cost, error

- Times are absolute UTC in a `<time datetime>`; no script means no relative times.
- `cost` is rendered as the key/value pairs it holds; `null` shows "not priced". The gateway defines the shape later; webui reads none of it.
- `error` shows `module`, `code`, `message` verbatim. A failed Call's Call View has everything the Call has and says which module stopped.
- Records unreachable is a `503` page. The API stays the API; the page says the database did not answer.

### Configuration

None. Everything reaches webui through `WebuiOptions`. The gateway owns `RECORDS_*` and `BLOB_*`.

## Testing decisions

Hono `app.request()` against `webui({ records, store, caller })` with `records({ database: pgliteDatabase(), store: memoryStore() })`, `memoryStore()` for URLs, and a `caller` stub returning a fixed Caller. Assertions on the HTML string: hrefs, text, attributes. No browser, no DOM library in v1; a parser becomes a devDependency the day a selector is needed. Prior art `packages/gateway/tests/health.test.ts` for `app.request()`.

| Check                                                                                                             | Mutation that must turn it red                 |
| ----------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| no Caller answers `401` with `WWW-Authenticate: Basic`                                                            | render the Gallery for every request           |
| the Gallery lists the Caller's Outputs newest first, each card linking its Call View and its Public URL           | order by store key                             |
| an Output of a Brand the Caller does not hold is not on the page                                                  | list without a Brand filter                    |
| `?brand=` for a Brand not held is `403` naming `brand_not_held`                                                   | fall back to every Brand                       |
| the "older" link's cursor continues without repeating or skipping                                                 | paginate by offset                             |
| a Brand name holding `<script>` renders escaped                                                                   | interpolate raw                                |
| the Call View shows every Step with its duration and the error of a failed Call                                   | drop Steps with a zero duration                |
| the Call View lists the Outputs this Call made                                                                    | list every Output of the Brand                 |
| the Source Thumbnail's `src` is the redirect route and the HTML holds no `.private.blob` or `.invalid` Signed URL | inline `signedUrl` at render                   |
| the redirect route answers `302` to a Signed URL after a Source Hold and `404` without one                        | skip `heldBy`                                  |
| the Overlay places a Region at its box in per cent and the Crop Window divided by the File's size                 | divide the window by the Target instead        |
| a Call of a Brand not held is `404`, byte-identical to an unknown id                                              | answer `403` for the held-by-someone-else case |
| the Calls list is the Caller's Calls newest first, each row linking its Call View                                 | order by id                                    |
| a Call of a Brand the Caller does not hold is not on the Calls list                                               | list without a Brand filter                    |
| `?status=failed` keeps only failed Calls and names the module and the code                                        | drop the `status` filter                       |
| records unreachable is `503` on the Calls list as on the Gallery                                                  | answer `500`                                   |

Every check is proved able to fail by the mutation beside it before it ships. Commit the green state first, then mutate, then `git restore`.

Live proof, per ticket: open the preview's `/ui` in a browser with the bootstrap key, and post the `curl -u :$KEY` of the page and a screenshot on the ticket. The live pages need rows: the records live suite and the gateway's routes write them.

## Out of scope

- Any write: deleting an Output, erasing a Person, re-running a Call. Every route is `GET`.
- A People or Brand page. People are personal data and the brief is outputs and what happened.
- Search, live updates, relative times, thumbnails, a dark theme toggle, any client script.
- Accounts and a login page. Basic auth with the API key is the whole answer until accounts arrive ([Brand owns the data; accounts come later (#63)](https://github.com/timschoch/meco/issues/63)).
- Health. `/health` is the gateway's and stays JSON.

## Further notes

`Gallery`, `Call`, `Step`, `Output`, `Caller`, `Source Hold`, `Signed URL`, `Public URL` are other modules' terms and are not redefined here. The webui section of `CONTEXT.md` adds `Call View`, `Calls list`, `Source Thumbnail` and `Overlay`.
