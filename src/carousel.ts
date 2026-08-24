/**
 * Assembling Slides into a Carousel.
 *
 * LinkedIn takes a carousel as a PDF, so the slides are rendered as PNGs and
 * stitched into one page each. Chromium's print-to-PDF would give selectable
 * text, but a carousel is read as pictures and stitching cannot surprise us at
 * three in the morning.
 */
import { PDFDocument } from "pdf-lib";

/** Combine rendered slide PNGs into a single multi-page PDF. */
export async function slidesToPdf(slides: readonly Buffer[]): Promise<Buffer> {
  if (slides.length === 0) {
    throw new Error("A Carousel needs at least one Slide.");
  }

  const pdf = await PDFDocument.create();

  for (const png of slides) {
    const embedded = await pdf.embedPng(png);
    const page = pdf.addPage([embedded.width, embedded.height]);
    page.drawImage(embedded, {
      x: 0,
      y: 0,
      width: embedded.width,
      height: embedded.height,
    });
  }

  return Buffer.from(await pdf.save());
}
