import { initWasm, Resvg } from "@resvg/resvg-wasm";
// @ts-expect-error - the .wasm import is wired via wrangler `rules` (CompiledWasm)
import resvgWasmModule from "@resvg/resvg-wasm/index_bg.wasm";

const OUTPUT_SIZE = 1400;
const BADGE_FRACTION = 0.22;
const BADGE_MARGIN_FRACTION = 0.04;

let wasmReady: Promise<void> | null = null;

function ensureWasmReady(): Promise<void> {
  if (!wasmReady) {
    wasmReady = initWasm(resvgWasmModule as WebAssembly.Module);
  }
  return wasmReady;
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    const chunk = bytes.subarray(offset, offset + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

function detectMimeType(bytes: Uint8Array, fallback: string): string {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  ) {
    return "image/png";
  }
  if (bytes.length >= 12 && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) {
    return "image/webp";
  }
  return fallback;
}

function buildCompositeSvg(sourceDataUri: string): string {
  const badgeSize = Math.round(OUTPUT_SIZE * BADGE_FRACTION);
  const margin = Math.round(OUTPUT_SIZE * BADGE_MARGIN_FRACTION);
  const badgeX = OUTPUT_SIZE - margin - badgeSize;
  const badgeY = OUTPUT_SIZE - margin - badgeSize;
  const radius = Math.round(badgeSize * 0.22);

  // "P" glyph as an SVG <path> so we don't depend on any font being available in the wasm runtime.
  // Geometry is authored in a 100x100 coordinate space and scaled via transform.
  const glyphPath =
    "M 30 18 L 30 82 L 42 82 L 42 60 L 56 60 C 70 60 80 51 80 39 C 80 27 70 18 56 18 Z " +
    "M 42 28 L 55 28 C 63 28 68 32 68 39 C 68 46 63 50 55 50 L 42 50 Z";
  const glyphScale = badgeSize / 100;
  const glyphX = badgeX;
  const glyphY = badgeY;

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${OUTPUT_SIZE}" height="${OUTPUT_SIZE}" viewBox="0 0 ${OUTPUT_SIZE} ${OUTPUT_SIZE}">`,
    `<image x="0" y="0" width="${OUTPUT_SIZE}" height="${OUTPUT_SIZE}" preserveAspectRatio="xMidYMid slice" href="${sourceDataUri}" />`,
    `<g>`,
    `<rect x="${badgeX}" y="${badgeY}" width="${badgeSize}" height="${badgeSize}" rx="${radius}" ry="${radius}" fill="rgba(15,15,20,0.92)" stroke="rgba(255,255,255,0.16)" stroke-width="2" />`,
    `<g transform="translate(${glyphX} ${glyphY}) scale(${glyphScale})">`,
    `<path d="${glyphPath}" fill="#ffffff" fill-rule="evenodd" />`,
    `</g>`,
    `</g>`,
    `</svg>`
  ].join("");
}

export interface BrandedArtwork {
  bytes: Uint8Array;
  contentType: "image/png";
}

export async function generateBrandedArtwork(sourceImageUrl: string): Promise<BrandedArtwork> {
  const response = await fetch(sourceImageUrl, {
    headers: { "user-agent": "podads-bot/0.1 (artwork)" }
  });

  if (!response.ok) {
    throw new Error(`Source artwork fetch failed with status ${response.status}`);
  }

  const contentTypeHeader = response.headers.get("content-type")?.split(";")[0]?.trim();
  const sourceBytes = new Uint8Array(await response.arrayBuffer());
  const mimeType = detectMimeType(sourceBytes, contentTypeHeader || "image/jpeg");

  const dataUri = `data:${mimeType};base64,${toBase64(sourceBytes)}`;
  const svg = buildCompositeSvg(dataUri);

  await ensureWasmReady();
  const resvg = new Resvg(svg, {
    fitTo: { mode: "width", value: OUTPUT_SIZE },
    background: "rgba(0,0,0,0)"
  });
  const rendered = resvg.render();
  const pngBytes = rendered.asPng();
  rendered.free();
  resvg.free();

  return { bytes: pngBytes, contentType: "image/png" };
}
