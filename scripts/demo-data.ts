/**
 * Real data for the demo run. Every value here was read from a source, not
 * invented — the comment above each block says where it came from, so anything
 * that looks wrong can be checked against the original.
 */

// ---------------------------------------------------------------------------
// laica — the four most recent Logbuch posts.
// Source: the laica Payload CMS (`logbuch` collection), sorted by publishedAt.
// Hero image URLs are the CMS media paths made absolute.
// ---------------------------------------------------------------------------

const LAICA_MEDIA = "https://www.laica.dev/api/media/file";

export const laicaPosts = [
  {
    title: "Viel gelernt bei der Innovationskonferenz",
    excerpt:
      "Letzte Woche durften wir spannende Leute kennenlernen. Und dabei gleich etwas über uns selbst gelernt.",
    date: "26. Juni 2026",
    heroImage: `${LAICA_MEDIA}/Astronaut-pitch.png`,
    slug: "innovationskonferenz-dresden",
  },
  {
    title: "Wir wollen starke, regional vernetzte KMU",
    excerpt:
      "Wir sind überzeugt, dass diese ein wichtiger Grundpfeiler einer gesunden Gesellschaft sind.",
    date: "12. Juni 2026",
    heroImage: `${LAICA_MEDIA}/Astrolost.png`,
    slug: "unsere-vision-warum-wir-in-regionale-unternehmen-investieren",
  },
  {
    title: "Viele kleine Schritte",
    excerpt:
      "LinkedIn-Outreach läuft, Rücklauf ist dünn. Die spannendste Erkenntnis kam aus den Checks.",
    date: "5. Juni 2026",
    heroImage: `${LAICA_MEDIA}/Digitale%20Unterschriften`,
    slug: "viele-kleine-schritte",
  },
  {
    title: "Erstes In-Person Teamtreffen und Baseline-KPIs",
    excerpt:
      "Letzte Woche traf sich ein Teil des Teams zum ersten Mal in Deutschland in Person. Das tat richtig gut.",
    date: "1. Juni 2026",
    heroImage: `${LAICA_MEDIA}/Team-1.png`,
    slug: "erstes-in-person-teamtreffen-und-baseline-kpis",
  },
];

/**
 * Carousels for the same four posts. Points and quotes are drawn from each
 * post's own body text in the CMS, shortened for a slide but not reworded into
 * something the post does not say.
 */
export const laicaCarousels: Array<{
  slug: string;
  slides: Array<{ template: string; data: Record<string, unknown> }>;
}> = [
  {
    slug: "innovationskonferenz-dresden",
    slides: [
      {
        template: "laica-slide",
        data: {
          kind: "cover",
          kicker: "Logbuch",
          title: "Viel gelernt bei der Innovationskonferenz",
          body: "Was uns die FutureSax-Konferenz über unseren eigenen Fokus beigebracht hat.",
        },
      },
      {
        template: "laica-slide",
        data: {
          kind: "point",
          index: 1,
          total: 3,
          title: "Erste Chance in der freien Wildbahn",
          body: "Die jährliche Innovationskonferenz von FutureSax war die erste Gelegenheit, unsere Idee einem breiteren Publikum zu zeigen.",
        },
      },
      {
        template: "laica-slide",
        data: {
          kind: "point",
          index: 2,
          total: 3,
          title: "Eine Rückmeldung kam immer wieder",
          body: "Fokussiert euch für den Start. In unseren Augen hatten wir das schon getan.",
        },
      },
      {
        template: "laica-slide",
        data: {
          kind: "point",
          index: 3,
          total: 3,
          title: "Ich muss es in einem Satz erklären können",
          body: "Eine Person sagte: Ich kenne Firmen, die das brauchen könnten. Aber ich muss ihnen in einem Satz sagen können, was ihr macht.",
        },
      },
      {
        template: "laica-slide",
        data: {
          kind: "quote",
          title: "Wir helfen dir, deinen Verkaufsprozess zu automatisieren.",
          body: "Unser neuer Fokus. Damit starten wir.",
        },
      },
      {
        template: "laica-slide",
        data: {
          kind: "outro",
          title: "Was ist deine Meinung zu unserem neuen Fokus?",
          cta: "Schreib mir eine Mail",
        },
      },
    ],
  },
  {
    slug: "unsere-vision-warum-wir-in-regionale-unternehmen-investieren",
    slides: [
      {
        template: "laica-slide",
        data: {
          kind: "cover",
          kicker: "Vision",
          title: "Wir wollen starke, regional vernetzte KMU",
          body: "Warum wir uns in lokale Unternehmen investieren.",
        },
      },
      {
        template: "laica-slide",
        data: {
          kind: "point",
          index: 1,
          total: 3,
          title: "Petru bildet sein Dorf aus",
          body: "Er arbeitet remote für einen US-Arbeitgeber und hat mehreren Familien aus seinem Dorf zu einer Stelle verholfen.",
        },
      },
      {
        template: "laica-slide",
        data: {
          kind: "point",
          index: 2,
          total: 3,
          title: "Die Wertschöpfung bleibt vor Ort",
          body: "Ein Auftrag in der Region bezahlt Löhne in der Region. Die fliessen zurück in die Bäckerei, den Sportverein, zum Handwerker um die Ecke.",
        },
      },
      {
        template: "laica-slide",
        data: {
          kind: "point",
          index: 3,
          total: 3,
          title: "Wer sich kennt, achtet aufeinander",
          body: "Aus Reklamationen werden Gespräche. Man löst Probleme, bevor sie eskalieren, weil man sich nächste Woche wieder sieht.",
        },
      },
      {
        template: "laica-slide",
        data: {
          kind: "quote",
          title: "Einem Menschen geht es gut genug, dass er Kapazität hat, an andere zu denken.",
          body: "Das Muster hinter beiden Geschichten.",
        },
      },
      {
        template: "laica-slide",
        data: {
          kind: "outro",
          title: "Siehst du das ähnlich?",
          cta: "Schreib uns",
        },
      },
    ],
  },
  {
    slug: "viele-kleine-schritte",
    slides: [
      {
        template: "laica-slide",
        data: {
          kind: "cover",
          kicker: "Logbuch",
          title: "Viele kleine Schritte",
          body: "Eine dieser unspektakulären Wochen, in denen man Themen abarbeitet.",
        },
      },
      {
        template: "laica-slide",
        data: {
          kind: "point",
          index: 1,
          total: 2,
          title: "Marketing ist schwierig",
          body: "Wir schreiben auf LinkedIn gezielt Leute an. Bisher kommt wenig zurück. Wer hätte das gedacht.",
        },
      },
      {
        template: "laica-slide",
        data: {
          kind: "point",
          index: 2,
          total: 2,
          title: "Fragen, die in kein Format passen",
          body: "Allgemeine Fragen zu KI, Automatisierung oder Tool-Auswahl. Themen, bei denen man einfach jemanden zum Reden braucht.",
        },
      },
      {
        template: "laica-slide",
        data: {
          kind: "quote",
          title: "Miete deinen CTO",
          body: "Zwei Mal 30 Minuten mit jemandem, der sich auskennt. Unverbindlich und unabhängig.",
        },
      },
      {
        template: "laica-slide",
        data: { kind: "outro", title: "Klingt das nach etwas für dich?", cta: "Schreib uns" },
      },
    ],
  },
  {
    slug: "erstes-in-person-teamtreffen-und-baseline-kpis",
    slides: [
      {
        template: "laica-slide",
        data: {
          kind: "cover",
          kicker: "Logbuch",
          title: "Erstes In-Person Teamtreffen",
          body: "Ein Remote-Team trifft sich zum ersten Mal in Person.",
        },
      },
      {
        template: "laica-slide",
        data: {
          kind: "point",
          index: 1,
          total: 3,
          title: "Was remote fehlt",
          body: "Der ungezwungene Austausch in der Kaffeeküche, das gemeinsame Mittagessen, das Feierabendbier.",
        },
      },
      {
        template: "laica-slide",
        data: {
          kind: "point",
          index: 2,
          total: 3,
          title: "Baseline-KPIs Mai",
          body: "2 durchgeführte Checks, 182 Outbound Clicks, 2 Referrals — 1.1 % Conversion.",
        },
      },
      {
        template: "laica-slide",
        data: {
          kind: "point",
          index: 3,
          total: 3,
          title: "Top 3 Kategorien",
          body: "CRM, No-Code Automatisierung, KI-Plattformen.",
        },
      },
      {
        template: "laica-slide",
        data: {
          kind: "quote",
          title: "Ein kleiner Schritt für die Notarin, ein grosser Schritt für Laica.",
          body: "Über die Gründung der Laica UG.",
        },
      },
      {
        template: "laica-slide",
        data: { kind: "outro", title: "Wir bauen weiter.", cta: "Folge dem Logbuch" },
      },
    ],
  },
];

// ---------------------------------------------------------------------------
// Hope Family — the four most recent blog posts.
// Source: https://www.hope-family.com/blog. Header images are the Squarespace
// CDN URLs the site itself serves; each was checked to return an image.
// ---------------------------------------------------------------------------

export const hopeFamilyPosts = [
  {
    title: "Eine Woche, die Spuren hinterlässt",
    excerpt: "110 Mädchen, eine Woche Sommerlager und ganz viele Geschichten, die bleiben.",
    date: "11.08.2026",
    headerImage:
      "https://images.squarespace-cdn.com/content/v1/68e52c240f55e10baf8c8466/e9e78711-b321-4497-b685-b1ac09b1fcbf/IMG-20260722-WA0008.jpg",
    slug: "sommerlager-2026",
  },
  {
    title: "Zwei Monate unterwegs – unser Herbst 2025",
    excerpt: "Zwei Monate unterwegs, und was davon geblieben ist.",
    date: "24.12.2025",
    headerImage:
      "https://images.squarespace-cdn.com/content/v1/68e52c240f55e10baf8c8466/1ac659da-3044-455d-b6b9-3214324b631b/processed_1000125092.jpg",
    slug: "sommer-2025-hfjk9",
  },
  {
    title: "Sommer 2025",
    excerpt:
      "Es tut gut, einfach mal etwas langsamer unterwegs zu sein und viel frische Luft zu tanken.",
    date: "29.07.2025",
    headerImage:
      "https://images.squarespace-cdn.com/content/v1/68e52c240f55e10baf8c8466/ad8fd797-6747-4a1a-b8d4-de2a315bacbe/1_Title_sommer-2025.jpg",
    slug: "sommer-2025",
  },
  {
    title: "Abschluss 2024",
    excerpt: "Ein Rückblick auf das Jahr und das Leben in Moldau.",
    date: "19.12.2024",
    headerImage:
      "https://images.squarespace-cdn.com/content/v1/68e52c240f55e10baf8c8466/1760914529165-BZLHT99OFVVDZKZGV2BG/img-20241209-wa00031630785200175534420-768x346.jpg",
    slug: "abschluss-2024",
  },
];

// ---------------------------------------------------------------------------
// Swiss Hutless — the 2026 autobau Schweizer Kartmeisterschaft.
// Source: the official Auto Sport Schweiz calendar PDF,
// https://motorsport.ch/dokumente/dateien/Kalender-2026-INT-NAT-V4.pdf
// (rows marked SM / ASS). Months read from the section headings in that PDF.
// `trackImage` is filled in below only where a real image URL was verified.
// ---------------------------------------------------------------------------

export interface DemoRace {
  round: number;
  circuit: string;
  location: string;
  date: string;
  season: string;
  category: string;
  trackImage?: string;
}

export const races: DemoRace[] = [
  {
    round: 1,
    circuit: "Franciacorta",
    location: "Castrezzato, Italien",
    date: "29. März 2026",
    season: "Schweizer Kart Meisterschaft 2026",
    category: "Super Mini / X30 / OK Junior / KZ2",
    // Wikimedia Commons: circuit layout. The kart track adjoins this circuit.
    trackImage:
      "https://upload.wikimedia.org/wikipedia/commons/3/38/Franciacorta_International_Circuit_layout.png",
  },
  {
    round: 2,
    circuit: "7 Laghi Kart",
    location: "Castelletto di Branduzzo, Italien",
    date: "19. April 2026",
    season: "Schweizer Kart Meisterschaft 2026",
    category: "Super Mini / X30 / OK Junior / KZ2",
    // Track layout from the circuit's own site.
    trackImage: "https://7laghikartitalia.it/images/circuito.png",
  },
  {
    round: 3,
    circuit: "Circuit de l'Enclos",
    location: "Septfontaines / Levier, Frankreich",
    date: "31. Mai 2026",
    season: "Schweizer Kart Meisterschaft 2026",
    category: "Super Mini / X30 / OK Junior / KZ2",
    // Aerial photo of both tracks, from the circuit's own site.
    trackImage: "https://circuitdelenclos.com/upload/contenu/Plan-Aerien-Piste-2018.jpg",
  },
  {
    round: 4,
    circuit: "7 Laghi Kart",
    location: "Castelletto di Branduzzo, Italien",
    date: "12. Juli 2026",
    season: "Schweizer Kart Meisterschaft 2026",
    category: "Super Mini / X30 / OK Junior / KZ2",
    trackImage: "https://7laghikartitalia.it/images/circuito.png",
  },
  {
    round: 5,
    circuit: "Cremona Circuit",
    location: "San Martino del Lago, Italien",
    date: "23. August 2026",
    season: "Schweizer Kart Meisterschaft 2026",
    category: "Super Mini / X30 / OK Junior / KZ2",
    // Wikimedia Commons photo of the circuit's finish line. Commons also has a
    // layout diagram, but only as SVG, which the renderer does not decode.
    trackImage:
      "https://upload.wikimedia.org/wikipedia/commons/thumb/c/c5/Cremona_Circuit_finish_line.jpg/1920px-Cremona_Circuit_finish_line.jpg",
  },
  {
    round: 6,
    circuit: "Kart-Bahn Wohlen",
    location: "Waltenschwil, Schweiz",
    date: "10. Oktober 2026",
    season: "Schweizer Kart Meisterschaft 2026",
    category: "Super Mini / X30 / OK Junior / KZ2 — Finale",
    // Facility photo from the track's own site.
    trackImage:
      "https://www.kartbahnwohlen.ch/wp-content/uploads/2022/10/kartbahn-img1.jpg",
  },
];

// ---------------------------------------------------------------------------
// Swiss Hutless shop products.
// Source: https://shop.swisshutless.com — names, prices and image URLs read
// from each product page. Only products whose image URL was verified to return
// a real JPEG are included; specs use the shop's own wording.
// ---------------------------------------------------------------------------

const SHOP_IMG = "https://shop.swisshutless.com/shop/resources/product_images_klein";

export const products = [
  {
    name: 'Kart Mini "Performance"',
    price: "CHF 4'990.00",
    productImage: `${SHOP_IMG}/6813_kl.jpg`,
    category: "Karts & Chassis / Racing",
    badge: "Ready to drive",
    specs: [
      "Motor: BMB L-X",
      "Reifen: LeCont LMK",
      "Komplett, fahrbereit",
      "Artikel-Nr. 104500",
    ],
  },
  {
    name: "Kid's Kart Delfino",
    price: "CHF 2'390.00",
    productImage: `${SHOP_IMG}/5209_kl.jpg`,
    category: "Karts & Chassis / Racing",
    badge: "4-Takt",
    specs: [
      "Motor: Honda GX 35, 35 ccm 4-Takt",
      "Leistung: 1.3 PS bei 7'000 U/Min",
      "Chassis: Delfino, 25 mm Rahmen",
      "Radstand: 800 mm, Achse 30 mm",
      "Reifen: Bridgestone, Alufelgen",
    ],
  },
  {
    name: "Kart Niktec TAG / OK",
    price: "CHF 4'750.00",
    productImage: `${SHOP_IMG}/5853_kl.jpg`,
    category: "Karts & Chassis / Racing",
    badge: "Ohne Reifen",
    specs: [
      "Felgen Douglas 132/212 mm",
      "Radnaben vorne und hinten in Magnesium",
      "Rahmen in Rot oder Schwarz",
      "Verschalung KG 506",
      "Ohne Kühlsystem",
    ],
  },
  {
    name: "Motor IAME X30",
    price: "CHF 2'990.00",
    productImage: `${SHOP_IMG}/4348_kl.jpg`,
    category: "Motoren / IAME",
    badge: "Komplett",
    specs: [
      "Mit Auspuff und Vergaser",
      "Mit Kühler und Wasserpumpe",
      "Ohne Batterie",
      "Artikel-Nr. 202550",
    ],
  },
  {
    name: "Jacke Swiss Hutless Soft-Shell",
    price: "Ab CHF 119.00",
    productImage: `${SHOP_IMG}/5491_kl.jpg`,
    category: "Bekleidung / Sport's Wear",
    badge: "Team",
    specs: ["Offizielle Team-Bekleidung", "Groessen XS bis XXL", "Soft-Shell"],
  },
];
