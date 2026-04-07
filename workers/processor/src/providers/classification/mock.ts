import type { AdDetectionResult, TranscriptSegment } from "../../lib/types";

const AD_KEYWORDS = ["sponsor", "promo", "brought to you", "discount", "advertiser", "partner"];

export async function mockClassification(
  model: string,
  segments: TranscriptSegment[]
): Promise<AdDetectionResult> {
  const spans = segments
    .filter((segment) => {
      const normalized = segment.text.toLowerCase();
      return AD_KEYWORDS.some((keyword) => normalized.includes(keyword));
    })
    .map((segment) => ({
      startMs: segment.startMs,
      endMs: segment.endMs,
      confidence: 0.92,
      reason: "keyword_match"
    }));

  return {
    provider: "mock",
    model,
    spans,
    estimatedCostUsd: 0
  };
}
