import { useEffect, useState } from "react";

export type ImageCornerTone = "light" | "dark";

const SAMPLE_SIZE = 32;
const CORNER_FRACTION = 0.3;
const LIGHT_LUMINANCE_THRESHOLD = 140;

export function useImageCornerTone(
  src: string | null | undefined,
  fallback: ImageCornerTone = "dark"
): ImageCornerTone {
  const [tone, setTone] = useState<ImageCornerTone>(fallback);

  useEffect(() => {
    if (!src) {
      setTone(fallback);
      return;
    }

    let cancelled = false;
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.decoding = "async";

    img.onload = () => {
      if (cancelled) {
        return;
      }

      try {
        const canvas = document.createElement("canvas");
        canvas.width = SAMPLE_SIZE;
        canvas.height = SAMPLE_SIZE;
        const ctx = canvas.getContext("2d", { willReadFrequently: true });
        if (!ctx) {
          return;
        }

        const srcX = Math.floor(img.naturalWidth * (1 - CORNER_FRACTION));
        const srcY = Math.floor(img.naturalHeight * (1 - CORNER_FRACTION));
        const srcW = img.naturalWidth - srcX;
        const srcH = img.naturalHeight - srcY;
        ctx.drawImage(img, srcX, srcY, srcW, srcH, 0, 0, SAMPLE_SIZE, SAMPLE_SIZE);

        const { data } = ctx.getImageData(0, 0, SAMPLE_SIZE, SAMPLE_SIZE);
        let total = 0;
        let count = 0;
        for (let i = 0; i < data.length; i += 4) {
          total += 0.2126 * (data[i] ?? 0) + 0.7152 * (data[i + 1] ?? 0) + 0.0722 * (data[i + 2] ?? 0);
          count += 1;
        }

        const average = count > 0 ? total / count : 0;
        if (!cancelled) {
          setTone(average > LIGHT_LUMINANCE_THRESHOLD ? "light" : "dark");
        }
      } catch {
        // Canvas tainted (cross-origin without CORS) — stick with fallback tone.
      }
    };

    img.src = src;

    return () => {
      cancelled = true;
    };
  }, [src, fallback]);

  return tone;
}
