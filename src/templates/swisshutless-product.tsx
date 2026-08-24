/**
 * Swiss Hutless — a product post for the shop.
 *
 * The kart is the subject, so it sits on a light panel that lifts it off the
 * dark frame; specs run as a short stack under the name and the price is the
 * one red element besides the stripe.
 */
import { swisshutless } from "../brands.js";
import type { Placement } from "../channels.js";

export interface ProductData {
  name: string;
  /** Price exactly as the shop shows it, e.g. "CHF 3'450.00". */
  price?: string;
  /** Absolute URL of the main product image. */
  productImage?: string;
  /** Three to five short facts. */
  specs?: string[];
  category?: string;
  /** Small line at the bottom, e.g. "shop.swisshutless.com". */
  shop?: string;
  /** Optional flash, e.g. "NEU" or "READY TO DRIVE". */
  badge?: string;
}

const c = swisshutless.colors;

export function swissHutlessProduct(data: ProductData, placement: Placement) {
  const tall = placement.height / placement.width > 1.5;
  const pad = tall ? 72 : 64;
  const nameSize = tall ? 72 : 62;
  const imageHeight = tall ? "44%" : "40%";

  return (
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        flexDirection: "column",
        backgroundColor: c.black,
        padding: pad,
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          marginBottom: 28,
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
          }}
        >
          <div
            style={{
              width: 40,
              height: 6,
              backgroundColor: c.red,
              marginRight: 14,
            }}
          />
          <div
            style={{
              fontFamily: swisshutless.headingFamily,
              fontSize: 28,
              fontWeight: 700,
              color: c.white,
              letterSpacing: 3,
            }}
          >
            SWISS HUTLESS
          </div>
        </div>
        {data.badge ? (
          <div
            style={{
              display: "flex",
              backgroundColor: c.red,
              color: c.white,
              fontFamily: swisshutless.headingFamily,
              fontSize: 24,
              fontWeight: 700,
              letterSpacing: 2,
              padding: "8px 18px",
            }}
          >
            {data.badge.toUpperCase()}
          </div>
        ) : null}
      </div>

      {/* Light panel so a photo shot on white does not vanish into the frame. */}
      <div
        style={{
          display: "flex",
          width: "100%",
          height: imageHeight,
          backgroundColor: c.white,
          alignItems: "center",
          justifyContent: "center",
          overflow: "hidden",
        }}
      >
        {data.productImage ? (
          <img
            src={data.productImage}
            style={{ width: "100%", height: "100%", objectFit: "contain" }}
          />
        ) : null}
      </div>

      <div
        style={{
          display: "flex",
          flexDirection: "column",
          flexGrow: 1,
          justifyContent: "space-between",
          paddingTop: 34,
        }}
      >
        <div style={{ display: "flex", flexDirection: "column" }}>
          {data.category ? (
            <div
              style={{
                fontFamily: swisshutless.bodyFamily,
                fontSize: 24,
                fontWeight: 600,
                color: c.red,
                letterSpacing: 3,
                marginBottom: 14,
              }}
            >
              {data.category.toUpperCase()}
            </div>
          ) : null}

          <div
            style={{
              fontFamily: swisshutless.headingFamily,
              fontSize: nameSize,
              fontWeight: 700,
              lineHeight: 1.05,
              color: c.white,
              textTransform: "uppercase",
            }}
          >
            {data.name}
          </div>

          {data.specs && data.specs.length > 0 ? (
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                marginTop: 26,
              }}
            >
              {data.specs.slice(0, 5).map((spec, i) => (
                <div
                  key={i}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    marginBottom: 12,
                  }}
                >
                  <div
                    style={{
                      width: 8,
                      height: 8,
                      backgroundColor: c.red,
                      marginRight: 14,
                    }}
                  />
                  <div
                    style={{
                      fontFamily: swisshutless.bodyFamily,
                      fontSize: tall ? 28 : 25,
                      color: c.silver,
                    }}
                  >
                    {spec}
                  </div>
                </div>
              ))}
            </div>
          ) : null}
        </div>

        <div
          style={{
            display: "flex",
            alignItems: "flex-end",
            justifyContent: "space-between",
            marginTop: 28,
          }}
        >
          {data.price ? (
            <div
              style={{
                fontFamily: swisshutless.headingFamily,
                fontSize: tall ? 62 : 54,
                fontWeight: 700,
                color: c.red,
              }}
            >
              {data.price}
            </div>
          ) : (
            <div />
          )}
          <div
            style={{
              fontFamily: swisshutless.bodyFamily,
              fontSize: 24,
              color: c.white,
              opacity: 0.7,
            }}
          >
            {data.shop ?? "shop.swisshutless.com"}
          </div>
        </div>
      </div>
    </div>
  );
}

export function swissHutlessProductImages(data: ProductData): string[] {
  return data.productImage ? [data.productImage] : [];
}
