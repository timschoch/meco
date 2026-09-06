/**
 * The sub-app the gateway mounts. One function, one seam: everything a caller
 * must know is in {@link WebuiOptions}, and every check in this package's
 * suite is `app.request()` against what this returns.
 *
 * webui reads and never writes. Every route is `GET`, no route touches bytes,
 * and the only thing it asks of `@meco/store` is a URL.
 */
import type { Caller, Records } from "@meco/records";
import type { Store } from "@meco/store";
import { type Context, Hono } from "hono";
import { CallView } from "./call";
import { readCall, sourceUrl, viewOf } from "./call-page";
import { Calls } from "./calls";
import { callsPage } from "./calls-page";
import { Gallery } from "./gallery";
import { galleryPage } from "./gallery-page";
import { Refusal } from "./layout";
import { NotACursor } from "./merge";
import { NotAValue, callsQuery, galleryQuery } from "./query";

export interface WebuiOptions {
  /** The only data source. webui never builds one and never writes a row. */
  readonly records: Records;
  /** URLs only, never bytes: a module that read one would touch pixels. */
  readonly store: Pick<Store, "publicUrl" | "signedUrl">;
  /**
   * The gateway's own Caller lookup. webui never calls `callers.byKey` and
   * never sees a key, so there is one door and it is the gateway's.
   */
  caller(request: Request): Promise<Caller | null>;
  /** Where the gateway mounts this, so no link bakes the mount point in. */
  readonly basePath?: string;
  /**
   * Rows per page, on both lists. Twelve, because the Gallery loads whole
   * Renders: Blob has no transform on the read path and webui may not resize,
   * and a Render measures 0.7 to 2.5 MB PNG (compose goldens,
   * `packages/compose/tests/goldens`, seven files, 6 Sep 2026). Twelve of the
   * largest is about 30 MB, every image deferred. The Calls list carries no
   * image and could take more, but a second number would have to be explained
   * and no page is waiting for one.
   */
  readonly pageSize?: number;
}

/** The gateway's own code for a Brand the Caller does not hold. One wall, one word. */
const BRAND_NOT_HELD = "brand_not_held";

/**
 * Basic and not Bearer: a browser cannot put an `Authorization: Bearer` on a
 * navigation, and this challenge is what makes it prompt. The key goes in the
 * password field and the user name is ignored.
 */
const unauthorized = (c: Context) =>
  c.html(
    <Refusal
      title="Sign in"
      code="unauthorized"
      detail="Put your meco API key in the password field. Any user name will do."
    />,
    401,
    { "WWW-Authenticate": 'Basic realm="meco"' }
  );

/**
 * The same refusal and the same code the API gives, so the wall reads the same
 * from a browser as from a client.
 */
const notYourBrand = (c: Context, brand: string) =>
  c.html(
    <Refusal
      title="Not your Brand"
      code={BRAND_NOT_HELD}
      detail={`Your key does not hold the brand ${brand}.`}
    />,
    403
  );

/**
 * The one page for "no such Call", built from constants so that a Call of a
 * Brand the Caller does not hold and an id that names nothing are the same
 * bytes. Anything read off the request would say the id exists.
 */
const notFound = (c: Context) =>
  c.html(
    <Refusal
      title="Not found"
      code="not_found"
      detail="No such Call, or not one of your Brands."
    />,
    404
  );

const badRequest = (c: Context, title: string, detail: string) =>
  c.html(<Refusal title={title} code="bad_request" detail={detail} />, 400);

/** Records unreachable is a page that says so. The API stays the API. */
const noAnswer = (c: Context) =>
  c.html(
    <Refusal
      title="No answer"
      code="records_unreachable"
      detail="The database did not answer. The API is unaffected."
    />,
    503
  );

export function webui(options: WebuiOptions): Hono {
  const app = new Hono();
  const basePath = options.basePath ?? "/ui";
  const pageSize = options.pageSize ?? 12;

  /**
   * The Caller, or the challenge that asks for one. Every route starts here:
   * a request without a Caller is answered before its query is even read.
   */
  async function seen(c: Context): Promise<Caller | Response> {
    const caller = await options.caller(c.req.raw);
    return caller === null ? unauthorized(c) : caller;
  }

  /**
   * Which Brands a list reads: the one asked for when the Caller holds it,
   * every Brand held when none was asked for, and the wall otherwise.
   *
   * `async` because `c.html` of a tree holding an async component answers with
   * a promise, and a caller testing `instanceof Response` would walk straight
   * past one.
   */
  const wall = async (
    c: Context,
    caller: Caller,
    brand: string | undefined
  ): Promise<readonly string[] | Response> => {
    if (brand === undefined) return caller.brands;
    if (!caller.brands.includes(brand)) return notYourBrand(c, brand);
    return [brand];
  };

  /**
   * Only the Brands the Caller holds reach the filter links, so a page never
   * names a Brand its own refusal would then hide.
   */
  const brandsOf = async (brands: readonly string[]) =>
    (await options.records.brands.list()).filter((brand) =>
      brands.includes(brand.id)
    );

  app.get("/", async (c) => {
    const caller = await seen(c);
    if (caller instanceof Response) return caller;

    let query;
    try {
      query = galleryQuery(new URL(c.req.url));
    } catch (error) {
      if (error instanceof NotAValue) {
        return badRequest(c, "Not a filter", error.message);
      }
      throw error;
    }

    const brands = await wall(c, caller, query.brand);
    if (brands instanceof Response) return brands;

    // Only what records is asked for is inside the guard. A fault in the page
    // itself is a fault and must not be reported as a database that did not
    // answer.
    let page;
    let named;
    try {
      page = await galleryPage(
        options.records,
        brands,
        {
          ...(query.placement === undefined
            ? {}
            : { placement: query.placement }),
          ...(query.kind === undefined ? {} : { kind: query.kind }),
        },
        pageSize,
        query.cursor
      );
      named = await brandsOf(brands);
    } catch (error) {
      if (error instanceof NotACursor) {
        return badRequest(c, "Not a page", error.message);
      }
      return noAnswer(c);
    }

    return c.html(
      <Gallery
        basePath={basePath}
        query={query}
        outputs={page.rows}
        brands={named}
        store={options.store}
        cursor={page.cursor}
      />
    );
  });

  app.get("/calls", async (c) => {
    const caller = await seen(c);
    if (caller instanceof Response) return caller;

    let query;
    try {
      query = callsQuery(new URL(c.req.url));
    } catch (error) {
      if (error instanceof NotAValue) {
        return badRequest(c, "Not a filter", error.message);
      }
      throw error;
    }

    const brands = await wall(c, caller, query.brand);
    if (brands instanceof Response) return brands;

    let page;
    let named;
    try {
      page = await callsPage(
        options.records,
        brands,
        query.status,
        pageSize,
        query.cursor
      );
      named = await brandsOf(brands);
    } catch (error) {
      if (error instanceof NotACursor) {
        return badRequest(c, "Not a page", error.message);
      }
      return noAnswer(c);
    }

    return c.html(
      <Calls
        basePath={basePath}
        query={query}
        calls={page.rows}
        brands={named}
        cursor={page.cursor}
      />
    );
  });

  /**
   * The Source Thumbnail. The mint runs here, inside the gateway's container
   * and behind its door, with a records row as the authorisation — so the page
   * itself never holds a URL that hands over a photograph.
   */
  app.get("/calls/:id/source", async (c) => {
    const caller = await seen(c);
    if (caller instanceof Response) return caller;

    let url;
    try {
      url = await sourceUrl(
        options.records,
        options.store,
        caller,
        c.req.param("id")
      );
    } catch {
      return noAnswer(c);
    }
    if (url === null) return notFound(c);

    return c.redirect(url, 302);
  });

  app.get("/calls/:id", async (c) => {
    const caller = await seen(c);
    if (caller instanceof Response) return caller;

    // Only what records is asked for is inside the guard. A fault in the page
    // itself is a fault and must not be reported as a database that did not
    // answer.
    let read;
    try {
      read = await readCall(
        options.records,
        caller,
        c.req.param("id"),
        pageSize
      );
    } catch {
      return noAnswer(c);
    }
    if (read === null) return notFound(c);

    return c.html(
      <CallView basePath={basePath} view={viewOf(read)} store={options.store} />
    );
  });

  return app;
}
