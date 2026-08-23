import QRCode from "qrcode";

/**
 * QR as inline SVG so it stays vector in the PDF. A rasterised QR at
 * newsprint dot gain is a coin flip; vector edges scan first time.
 */
export async function qrSvg(url: string): Promise<string> {
  const svg = await QRCode.toString(url, {
    type: "svg",
    margin: 1,
    // Newsprint spreads ink. M gives enough redundancy to survive that.
    errorCorrectionLevel: "M",
    color: { dark: "#16161a", light: "#ffffff" },
  });
  // Strip the XML prolog so it can be inlined in an HTML document.
  return svg.replace(/<\?xml[^>]*\?>\s*/, "");
}

/** The URL as printed under the code, shortened so it does not wrap forever. */
export function displayUrl(url: string, maxLength = 58): string {
  const stripped = url.replace(/^https?:\/\//, "").replace(/\/$/, "");
  if (stripped.length <= maxLength) return stripped;
  return stripped.slice(0, maxLength - 1) + "…";
}
