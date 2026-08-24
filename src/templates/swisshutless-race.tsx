/**
 * Swiss Hutless — a race infographic for one round of the season.
 *
 * Built for the two Instagram Placements: the portrait post and the full-screen
 * story. The track picture is the hero, a dark scrim carries the type, and the
 * round number is the one loud element so a follower scrolling fast can tell
 * which race this is.
 */
import { swisshutless } from "../brands.js";
import type { Placement } from "../channels.js";

export interface RaceData {
  /** Round number within the season, e.g. 3. */
  round: number;
  /** Official circuit name. */
  circuit: string;
  /** Town and country, e.g. "Wohlen, Schweiz". */
  location: string;
  /** Already formatted for display, e.g. "12. – 14. Juni 2026". */
  date: string;
  /** Photo or track layout map of the circuit. */
  trackImage?: string;
  /** Season label, e.g. "Swiss Karting 2026". */
  season?: string;
  /** Optional class/category line, e.g. "OK-Junior". */
  category?: string;
}

const c = swisshutless.colors;

export function swissHutlessRace(data: RaceData, placement: Placement) {
  const tall = placement.height / placement.width > 1.5;
  const pad = tall ? 90 : 78;
  const circuitSize = tall ? 104 : 88;

  return (
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        flexDirection: "column",
        position: "relative",
        backgroundColor: c.black,
      }}
    >
      {data.trackImage ? (
        <img
          src={data.trackImage}
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

      <div
        style={{
          position: "absolute",
          top: 0,
          left: 0,
          width: "100%",
          height: "100%",
          backgroundImage:
            "linear-gradient(to bottom, rgba(10,10,12,0.72) 0%, rgba(10,10,12,0.35) 38%, rgba(10,10,12,0.94) 100%)",
        }}
      />

      {/* Brand stripe down the left edge. */}
      <div
        style={{
          position: "absolute",
          top: 0,
          left: 0,
          width: 14,
          height: "100%",
          backgroundColor: c.red,
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
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
          }}
        >
          <div
            style={{
              fontFamily: swisshutless.headingFamily,
              fontSize: 30,
              fontWeight: 700,
              color: c.white,
              letterSpacing: 3,
            }}
          >
            {(data.season ?? "SWISS KARTING 2026").toUpperCase()}
          </div>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              backgroundColor: c.red,
              color: c.white,
              fontFamily: swisshutless.headingFamily,
              fontSize: 34,
              fontWeight: 700,
              padding: "10px 24px",
              letterSpacing: 2,
            }}
          >
            RUNDE {data.round}
          </div>
        </div>

        <div style={{ display: "flex", flexDirection: "column" }}>
          <div
            style={{
              fontFamily: swisshutless.bodyFamily,
              fontSize: 28,
              fontWeight: 600,
              color: c.red,
              letterSpacing: 4,
              marginBottom: 18,
            }}
          >
            {(data.category ?? "NÄCHSTES RENNEN").toUpperCase()}
          </div>

          <div
            style={{
              fontFamily: swisshutless.headingFamily,
              fontSize: circuitSize,
              fontWeight: 700,
              lineHeight: 1.02,
              color: c.white,
              textTransform: "uppercase",
            }}
          >
            {data.circuit}
          </div>

          <div
            style={{
              display: "flex",
              alignItems: "center",
              marginTop: 30,
            }}
          >
            <div
              style={{
                fontFamily: swisshutless.bodyFamily,
                fontSize: tall ? 38 : 32,
                color: c.white,
                opacity: 0.85,
              }}
            >
              {data.location}
            </div>
          </div>

          <div
            style={{
              display: "flex",
              alignItems: "center",
              marginTop: 34,
              paddingTop: 30,
              borderTopWidth: 3,
              borderTopColor: c.red,
              borderTopStyle: "solid",
            }}
          >
            <div
              style={{
                fontFamily: swisshutless.headingFamily,
                fontSize: tall ? 52 : 44,
                fontWeight: 700,
                color: c.white,
              }}
            >
              {data.date}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export function swissHutlessRaceImages(data: RaceData): string[] {
  return data.trackImage ? [data.trackImage] : [];
}
