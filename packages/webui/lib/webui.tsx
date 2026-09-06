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
import { Hono } from "hono";
import { Gallery } from "./gallery";
import { NotACursor, galleryPage } from "./gallery-page";
import { Refusal } from "./layout";
import { NotAKind, galleryQuery } from "./query";

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
   * Outputs per Gallery page. Twelve, because the Gallery loads whole Renders:
   * Blob has no transform on the read path and webui may not resize, and a
   * Render measures 0.7 to 2.5 MB PNG (compose goldens,
   * `packages/compose/tests/goldens`, seven files, 6 Sep 2026). Twelve of the
   * largest is about 30 MB, every image deferred.
   */
  readonly pageSize?: number;
}

/** The gateway's own code for a Brand the Caller does not hold. One wall, one word. */
const BRAND_NOT_HELD = "brand_not_held";

export function webui(options: WebuiOptions): Hono {
  const app = new Hono();
  const basePath = options.basePath ?? "/ui";
  const pageSize = options.pageSize ?? 12;

  app.get("/", async (c) => {
    const caller = await options.caller(c.req.raw);
    if (caller === null) {
      // Basic and not Bearer: a browser cannot put an `Authorization: Bearer`
      // on a navigation, and this challenge is what makes it prompt. The key
      // goes in the password field and the user name is ignored.
      return c.html(
        <Refusal
          title="Sign in"
          code="unauthorized"
          detail="Put your meco API key in the password field. Any user name will do."
        />,
        401,
        { "WWW-Authenticate": 'Basic realm="meco"' }
      );
    }

    let query;
    try {
      query = galleryQuery(new URL(c.req.url));
    } catch (error) {
      if (error instanceof NotAKind) {
        return c.html(
          <Refusal
            title="Not a filter"
            code="bad_request"
            detail={error.message}
          />,
          400
        );
      }
      throw error;
    }

    if (query.brand !== undefined && !caller.brands.includes(query.brand)) {
      // The same refusal and the same code the API gives, so the wall reads
      // the same from a browser as from a client.
      return c.html(
        <Refusal
          title="Not your Brand"
          code={BRAND_NOT_HELD}
          detail={`Your key does not hold the brand ${query.brand}.`}
        />,
        403
      );
    }

    const held =
      query.brand === undefined ? caller.brands : ([query.brand] as const);

    // Only what records is asked for is inside the guard. A fault in the page
    // itself is a fault and must not be reported as a database that did not
    // answer.
    let page;
    let brands;
    try {
      page = await galleryPage(
        options.records,
        held,
        {
          ...(query.placement === undefined
            ? {}
            : { placement: query.placement }),
          ...(query.kind === undefined ? {} : { kind: query.kind }),
        },
        pageSize,
        query.cursor
      );
      // Only the Brands the Caller holds reach the filter links, so the page
      // never names a Brand its refusal would then hide.
      brands = (await options.records.brands.list()).filter((brand) =>
        caller.brands.includes(brand.id)
      );
    } catch (error) {
      if (error instanceof NotACursor) {
        return c.html(
          <Refusal
            title="Not a page"
            code="bad_request"
            detail={error.message}
          />,
          400
        );
      }
      // Records unreachable is a page that says so. The API stays the API.
      return c.html(
        <Refusal
          title="No answer"
          code="records_unreachable"
          detail="The database did not answer. The API is unaffected."
        />,
        503
      );
    }

    return c.html(
      <Gallery
        basePath={basePath}
        query={query}
        outputs={page.outputs}
        brands={brands}
        store={options.store}
        cursor={page.cursor}
      />
    );
  });

  return app;
}
