/**
 * Hope Family — a blog post card built around the post's own header image.
 *
 * Photo-led and warm: the picture carries the frame, a deep blue scrim keeps
 * the title readable over any photo, and the banana accent is the one warm mark
 * that ties it back to the wordmark.
 */
import { hopefamily } from "../brands.js";
import type { Placement } from "../channels.js";

export interface HopeFamilyPostData {
  title: string;
  /** Absolute URL of the post's header image. */
  headerImage?: string;
  date?: string;
  kicker?: string;
  excerpt?: string;
}

const c = hopefamily.colors;

export function hopeFamilyPost(data: HopeFamilyPostData, placement: Placement) {
  const tall = placement.height / placement.width > 1.2;
  const pad = tall ? 84 : 72;
  const titleSize = tall ? 78 : placement.width > 1300 ? 72 : 64;

  return (
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        flexDirection: "column",
        position: "relative",
        backgroundColor: c.blue,
      }}
    >
      {data.headerImage ? (
        <img
          src={data.headerImage}
          style={{
            position: "absolute",
            top: 0,
            left: 0,
            width: "100%",
            height: "100%",
            objectFit: "cover",
          }}
        />
      ) : null}

      {/* Scrim: keeps the title legible whatever the photo does. */}
      <div
        style={{
          position: "absolute",
          top: 0,
          left: 0,
          width: "100%",
          height: "100%",
          backgroundImage: `linear-gradient(to bottom, rgba(0,80,124,0.15) 0%, rgba(0,80,124,0.55) 45%, rgba(11,18,23,0.92) 100%)`,
        }}
      />

      <div
        style={{
          position: "relative",
          display: "flex",
          flexDirection: "column",
          width: "100%",
          height: "100%",
          justifyContent: "space-between",
          padding: pad,
        }}
      >
        <div style={{ display: "flex", alignItems: "flex-start" }}>
          {hopefamily.logo ? (
            <img
              src={hopefamily.logo as unknown as string}
              width={tall ? 300 : 250}
              height={tall ? 169 : 141}
            />
          ) : null}
        </div>

        <div style={{ display: "flex", flexDirection: "column" }}>
          <div style={{ display: "flex", alignItems: "center", marginBottom: 26 }}>
            <div
              style={{
                width: 52,
                height: 6,
                backgroundColor: c.banana,
                marginRight: 18,
              }}
            />
            <div
              style={{
                fontFamily: hopefamily.bodyFamily,
                fontSize: 26,
                fontWeight: 600,
                color: c.banana,
                letterSpacing: 2,
              }}
            >
              {(data.kicker ?? "NEUER BLOG POST").toUpperCase()}
            </div>
          </div>

          <div
            style={{
              fontFamily: hopefamily.headingFamily,
              fontSize: titleSize,
              fontWeight: 600,
              lineHeight: 1.12,
              color: c.white,
            }}
          >
            {data.title}
          </div>

          {data.excerpt ? (
            <div
              style={{
                fontFamily: hopefamily.bodyFamily,
                fontSize: tall ? 30 : 26,
                fontWeight: 400,
                lineHeight: 1.45,
                color: c.latte,
                marginTop: 24,
              }}
            >
              {data.excerpt}
            </div>
          ) : null}

          <div
            style={{
              display: "flex",
              alignItems: "center",
              marginTop: 34,
            }}
          >
            {data.date ? (
              <div
                style={{
                  fontFamily: hopefamily.bodyFamily,
                  fontSize: 24,
                  color: c.banana,
                  marginRight: 20,
                }}
              >
                {data.date}
              </div>
            ) : null}
            <div
              style={{
                fontFamily: hopefamily.bodyFamily,
                fontSize: 24,
                color: c.white,
                opacity: 0.75,
              }}
            >
              hope-family.com
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export function hopeFamilyPostImages(data: HopeFamilyPostData): string[] {
  return data.headerImage ? [data.headerImage] : [];
}
