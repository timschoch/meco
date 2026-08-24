/**
 * laica — a LinkedIn image announcing one Logbuch post.
 *
 * The look follows the laica design system: paper-white field, Pine Ink text,
 * one green that only ever marks orientation, and 400-weight headings where
 * hierarchy comes from size and rhythm rather than boldness.
 */
import { laica } from "../brands.js";
import type { Placement } from "../channels.js";

export interface LaicaPostData {
  title: string;
  excerpt?: string;
  /** Publication date, already formatted for display. */
  date?: string;
  /** Absolute URL of the post's hero image. */
  heroImage?: string;
  /** Small label above the title. */
  kicker?: string;
}

const c = laica.colors;

export function laicaPost(data: LaicaPostData, placement: Placement) {
  const wide = placement.width / placement.height > 1.3;
  const pad = wide ? 64 : 88;
  const titleSize = wide ? 62 : 84;
  const heroHeight = wide ? placement.height : Math.round(placement.height * 0.42);

  const textBlock = (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        flexGrow: 1,
        justifyContent: "space-between",
        padding: pad,
        width: wide ? "58%" : "100%",
      }}
    >
      <div style={{ display: "flex", flexDirection: "column" }}>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            marginBottom: 28,
          }}
        >
          <div
            style={{
              width: 44,
              height: 4,
              backgroundColor: c.green,
              marginRight: 16,
            }}
          />
          <div
            style={{
              fontFamily: laica.bodyFamily,
              fontSize: 24,
              fontWeight: 500,
              color: c.green,
              letterSpacing: 1.5,
            }}
          >
            {(data.kicker ?? "LOGBUCH").toUpperCase()}
          </div>
        </div>

        <div
          style={{
            fontFamily: laica.headingFamily,
            fontSize: titleSize,
            fontWeight: 400,
            lineHeight: 1.12,
            color: c.black,
          }}
        >
          {data.title}
        </div>

        {data.excerpt ? (
          <div
            style={{
              fontFamily: laica.bodyFamily,
              fontSize: wide ? 26 : 32,
              fontWeight: 400,
              lineHeight: 1.45,
              color: c.grayDark,
              marginTop: 28,
            }}
          >
            {data.excerpt}
          </div>
        ) : null}
      </div>

      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          marginTop: 40,
        }}
      >
        {laica.logo ? (
          <img src={laica.logo as unknown as string} width={200} height={50} />
        ) : (
          <div style={{ fontFamily: laica.headingFamily, fontSize: 32, color: c.black }}>
            laica
          </div>
        )}
        {data.date ? (
          <div
            style={{
              fontFamily: laica.bodyFamily,
              fontSize: 22,
              color: c.grayMedium,
            }}
          >
            {data.date}
          </div>
        ) : null}
      </div>
    </div>
  );

  const hero = data.heroImage ? (
    <div
      style={{
        display: "flex",
        width: wide ? "42%" : "100%",
        height: wide ? "100%" : heroHeight,
        overflow: "hidden",
        backgroundColor: c.greenLight,
      }}
    >
      <img
        src={data.heroImage}
        style={{ width: "100%", height: "100%", objectFit: "cover" }}
      />
    </div>
  ) : null;

  return (
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        flexDirection: wide ? "row" : "column",
        backgroundColor: c.white,
      }}
    >
      {wide ? (
        <>
          {textBlock}
          {hero}
        </>
      ) : (
        <>
          {hero}
          {textBlock}
        </>
      )}
    </div>
  );
}

/** Remote images this Template needs fetched before rendering. */
export function laicaPostImages(data: LaicaPostData): string[] {
  return data.heroImage ? [data.heroImage] : [];
}
