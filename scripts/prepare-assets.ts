/**
 * Copy the brand logos meco needs into `assets/`, rasterising SVG to PNG.
 *
 * Sources live outside this repo (a design volume, a sibling website repo), so
 * this is a one-off import step rather than something the server does. Run it
 * again if a logo changes upstream.
 */
import { mkdir, readFile, writeFile, access } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import sharp from "sharp";

const OUT = resolve(import.meta.dirname, "..", "assets");

interface AssetJob {
  /** Where it lands under assets/. */
  out: string;
  /** Candidate sources — a path or an `https:` URL. First one that exists wins. */
  from: string[];
  /** Rasterise to this width (SVG only). */
  width?: number;
}

const JOBS: AssetJob[] = [
  {
    out: "hopefamily/logo-white.png",
    from: [
      "/Volumes/PRIVAT/schoch/Hope Family/Design/Logo/Logo Hope Family RGB/Logo-Hope-Family-RGB_Black White.svg",
    ],
    width: 900,
  },
  {
    out: "hopefamily/logo-blue.png",
    from: [
      "/Volumes/PRIVAT/schoch/Hope Family/Design/Logo/Logo Hope Family RGB/Logo-Hope-Family-RGB_Blue Banana.svg",
    ],
    width: 900,
  },
  {
    out: "laica/logo.png",
    from: ["/Users/tim/repo/colin/public/laica-logo-black-green-200.png"],
  },
  {
    out: "swisshutless/logo.png",
    from: ["https://shop.swisshutless.com/shop/Bilder/shoplogo.png"],
  },
];

/** Brand fonts that are not on Google Fonts, so they must ship with the repo. */
const FONT_JOBS: Array<{ out: string; from: string[] }> = [
  {
    out: "hopefamily/Eina02-Regular.otf",
    from: [
      "/Volumes/PRIVAT/schoch/Hope Family/Design/Logo/_ Erstellung/Styleguide Ordner/Document fonts/Extratype - Eina 02 Regular.otf",
    ],
  },
  {
    out: "hopefamily/Eina02-SemiBold.otf",
    from: [
      "/Volumes/PRIVAT/schoch/Hope Family/Design/Logo/_ Erstellung/Styleguide Ordner/Document fonts/Extratype - Eina 02 SemiBold.otf",
    ],
  },
];

function isUrl(p: string): boolean {
  return p.startsWith("http://") || p.startsWith("https://");
}

async function exists(p: string): Promise<boolean> {
  if (isUrl(p)) return true;
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

/** Read a source, whether it is a local path or a URL. */
async function fetchSource(p: string): Promise<Buffer> {
  if (!isUrl(p)) return readFile(p);
  const res = await fetch(p);
  if (!res.ok) throw new Error(`${p} → HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

async function run(): Promise<void> {
  for (const job of JOBS) {
    const src = await (async () => {
      for (const candidate of job.from) {
        if (await exists(candidate)) return candidate;
      }
      return null;
    })();

    const dest = resolve(OUT, job.out);
    await mkdir(dirname(dest), { recursive: true });

    if (!src) {
      console.warn(`SKIP ${job.out} — no source found:\n  ${job.from.join("\n  ")}`);
      continue;
    }

    const bytes = await fetchSource(src);
    const png = src.endsWith(".svg")
      ? await sharp(bytes, { density: 400 })
          .resize({ width: job.width ?? 900 })
          .png()
          .toBuffer()
      : await sharp(bytes).png().toBuffer();

    await writeFile(dest, png);
    const meta = await sharp(png).metadata();
    console.log(`OK   ${job.out}  ${meta.width}x${meta.height}  ${png.length} bytes`);
  }

  for (const job of FONT_JOBS) {
    const src = await (async () => {
      for (const candidate of job.from) {
        if (await exists(candidate)) return candidate;
      }
      return null;
    })();

    const dest = resolve(OUT, job.out);
    await mkdir(dirname(dest), { recursive: true });

    if (!src) {
      console.warn(`SKIP ${job.out} — no source found:\n  ${job.from.join("\n  ")}`);
      continue;
    }

    const bytes = await readFile(src);
    await writeFile(dest, bytes);
    console.log(`OK   ${job.out}  ${bytes.length} bytes`);
  }
}

await run();
