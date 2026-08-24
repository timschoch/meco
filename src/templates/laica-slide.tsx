/**
 * laica — Slide templates for a LinkedIn Carousel.
 *
 * Each Slide names its own Template, so a Carousel is a cover, some points and
 * a closing card rather than one layout repeated. See CONTEXT.md.
 */
import { laica } from "../brands.js";
import type { Placement } from "../channels.js";

const c = laica.colors;

export type LaicaSlideKind = "cover" | "point" | "quote" | "outro";

export interface LaicaSlideData {
  kind: LaicaSlideKind;
  title?: string;
  body?: string;
  /** Shown on point slides as "3 / 5". */
  index?: number;
  total?: number;
  kicker?: string;
  heroImage?: string;
  cta?: string;
}

function Wordmark({ light }: { light?: boolean }) {
  if (!laica.logo) {
    return (
      <div
        style={{
          fontFamily: laica.headingFamily,
          fontSize: 34,
          color: light ? c.white : c.black,
        }}
      >
        laica
      </div>
    );
  }
  return <img src={laica.logo as unknown as string} width={176} height={44} />;
}

function Frame({
  children,
  background,
}: {
  children: unknown;
  background: string;
}) {
  return (
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        flexDirection: "column",
        backgroundColor: background,
        padding: 90,
      }}
    >
      {children as never}
    </div>
  );
}

export function laicaSlide(data: LaicaSlideData, _placement: Placement) {
  if (data.kind === "cover") {
    return (
      <Frame background={c.white}>
        <div style={{ display: "flex", flexDirection: "column", flexGrow: 1 }}>
          <div style={{ display: "flex", alignItems: "center", marginBottom: 40 }}>
            <div style={{ width: 56, height: 5, backgroundColor: c.green, marginRight: 18 }} />
            <div
              style={{
                fontFamily: laica.bodyFamily,
                fontSize: 26,
                color: c.green,
                letterSpacing: 2,
              }}
            >
              {(data.kicker ?? "LOGBUCH").toUpperCase()}
            </div>
          </div>
          <div
            style={{
              fontFamily: laica.headingFamily,
              fontSize: 96,
              fontWeight: 400,
              lineHeight: 1.08,
              color: c.black,
            }}
          >
            {data.title}
          </div>
          {data.body ? (
            <div
              style={{
                fontFamily: laica.bodyFamily,
                fontSize: 34,
                lineHeight: 1.45,
                color: c.grayDark,
                marginTop: 36,
              }}
            >
              {data.body}
            </div>
          ) : null}
        </div>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
          }}
        >
          <Wordmark />
          <div style={{ fontFamily: laica.bodyFamily, fontSize: 24, color: c.grayMedium }}>
            Weiterwischen →
          </div>
        </div>
      </Frame>
    );
  }

  if (data.kind === "quote") {
    return (
      <Frame background={c.green}>
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            flexGrow: 1,
            justifyContent: "center",
          }}
        >
          <div
            style={{
              fontFamily: laica.headingFamily,
              fontSize: 76,
              fontWeight: 400,
              lineHeight: 1.2,
              color: c.white,
            }}
          >
            {data.title}
          </div>
          {data.body ? (
            <div
              style={{
                fontFamily: laica.bodyFamily,
                fontSize: 30,
                lineHeight: 1.5,
                color: c.greenLight,
                marginTop: 36,
              }}
            >
              {data.body}
            </div>
          ) : null}
        </div>
        <div style={{ display: "flex" }}>
          <Wordmark light />
        </div>
      </Frame>
    );
  }

  if (data.kind === "outro") {
    return (
      <Frame background={c.black}>
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            flexGrow: 1,
            justifyContent: "center",
          }}
        >
          <div
            style={{
              fontFamily: laica.headingFamily,
              fontSize: 82,
              fontWeight: 400,
              lineHeight: 1.12,
              color: c.white,
            }}
          >
            {data.title}
          </div>
          {data.cta ? (
            <div
              style={{
                display: "flex",
                marginTop: 48,
                backgroundColor: c.green,
                color: c.white,
                fontFamily: laica.bodyFamily,
                fontSize: 30,
                padding: "20px 40px",
                borderRadius: 3,
              }}
            >
              {data.cta}
            </div>
          ) : null}
        </div>
        <div style={{ display: "flex" }}>
          <Wordmark light />
        </div>
      </Frame>
    );
  }

  // point
  return (
    <Frame background={c.white}>
      <div style={{ display: "flex", flexDirection: "column", flexGrow: 1 }}>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            width: 84,
            height: 84,
            borderRadius: 42,
            backgroundColor: c.greenLight,
            color: c.greenDark,
            fontFamily: laica.headingFamily,
            fontSize: 40,
            marginBottom: 44,
          }}
        >
          {data.index ?? 1}
        </div>
        <div
          style={{
            fontFamily: laica.headingFamily,
            fontSize: 68,
            fontWeight: 400,
            lineHeight: 1.15,
            color: c.black,
          }}
        >
          {data.title}
        </div>
        {data.body ? (
          <div
            style={{
              fontFamily: laica.bodyFamily,
              fontSize: 32,
              lineHeight: 1.5,
              color: c.grayDark,
              marginTop: 32,
            }}
          >
            {data.body}
          </div>
        ) : null}
      </div>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
        }}
      >
        <Wordmark />
        {data.index && data.total ? (
          <div style={{ fontFamily: laica.bodyFamily, fontSize: 24, color: c.grayMedium }}>
            {data.index} / {data.total}
          </div>
        ) : null}
      </div>
    </Frame>
  );
}

export function laicaSlideImages(data: LaicaSlideData): string[] {
  return data.heroImage ? [data.heroImage] : [];
}
