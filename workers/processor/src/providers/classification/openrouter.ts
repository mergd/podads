import {
  createOpenRouterChatCompletion,
  isRetryableOpenRouterStatus,
  OpenRouterRequestError,
  parseStructuredOutput
} from "../../lib/openrouter";
import { RetryableProcessingError } from "../../lib/retryable";
import type { AdDetectionResult, TranscriptResult } from "../../lib/types";

export const OPENROUTER_CLASSIFICATION_MODEL = "openai/gpt-5.6-luna";
export const OPENROUTER_CLASSIFICATION_FALLBACK_MODEL = "google/gemini-3.1-flash-lite";
const DEFAULT_PREROLL_WINDOW_SECONDS = 120;

export interface AdClassificationPromptOptions {
  mentionPrerolls?: boolean;
  maxSpanDurationMs?: number;
}

interface OpenRouterClassificationPayload {
  spans: Array<{
    startIdx: number;
    endIdx: number;
    startOffset: number;
    endOffset: number;
    confidence: number;
    reason: string;
  }>;
}

function sanitizeSegmentText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function clampUnitInterval(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }

  return Math.max(0, Math.min(1, value));
}

export function msAtSegmentOffset(
  segment: TranscriptResult["segments"][number],
  offset: number,
  edge: "start" | "end"
): number {
  const words = segment.words;
  if (words && words.length > 0 && offset > 0 && offset < 1) {
    if (edge === "start") {
      const wordIndex = Math.min(words.length - 1, Math.max(0, Math.floor(offset * words.length)));
      return words[wordIndex]?.startMs ?? segment.startMs;
    }

    const wordIndex = Math.min(words.length - 1, Math.max(0, Math.ceil(offset * words.length) - 1));
    return words[wordIndex]?.endMs ?? segment.endMs;
  }

  return segment.startMs + (segment.endMs - segment.startMs) * offset;
}

function formatSeconds(ms: number): string {
  return (ms / 1000).toFixed(1);
}

function buildSegmentLines(transcript: TranscriptResult): string {
  return transcript.segments
    .map((segment, index) => {
      const start = formatSeconds(segment.startMs);
      const end = formatSeconds(segment.endMs);
      return `${index}\t${start}\t${end}\t${sanitizeSegmentText(segment.text)}`;
    })
    .join("\n");
}

const CLASSIFICATION_MODELS = [
  OPENROUTER_CLASSIFICATION_MODEL,
  OPENROUTER_CLASSIFICATION_FALLBACK_MODEL
] as const;

export function buildAdClassificationPrompt(
  transcript: TranscriptResult,
  options: AdClassificationPromptOptions = {}
): string {
  const maxSpanDurationMinutes = options.maxSpanDurationMs
    ? Math.round(options.maxSpanDurationMs / 60_000)
    : null;
  const prerollInstructions = options.mentionPrerolls
    ? [
        `Prerolls are common and often appear in the first ${DEFAULT_PREROLL_WINDOW_SECONDS} seconds before the show really starts.`,
        "Treat opening sponsor reads, brand intros, website calls to action, promo offers, and legal disclaimers as likely ad signals when they appear before editorial conversation begins."
      ]
    : [];

  return [
    "Identify paid advertising spans in this podcast transcript.",
    "Return JSON only.",
    "Segments are provided as TSV lines: `index<TAB>startSec<TAB>endSec<TAB>text`. Times are in seconds.",
    "For each ad span, return inclusive `startIdx` and `endIdx` plus `startOffset` and `endOffset` in the range 0 to 1.",
    "`startOffset` is how far into the start segment the ad begins. `endOffset` is how far into the end segment the ad ends.",
    "If a segment is entirely an ad, use startOffset 0 and/or endOffset 1.",
    "Whisper often glues the last interview clause and the first ad clause onto one line. Do not take that whole line.",
    "Estimate the split from the words: if the first 3 of 7 words are still editorial, startOffset is 3/7.",
    "When the line has a sentence boundary, pause, or music-bed cue, land the offset there rather than at 0 or 1.",
    "Only include third-party paid advertising, sponsorship reads, partner messaging, promo codes, or explicit product promotions.",
    "The show's own events, merchandise, games, newsletters, memberships, and websites are editorial self-promotion, not ads; do not remove them even when they have a call to action.",
    "Do not include other editorial chatter, intros, outros, or self-referential jokes.",
    "When an ad pod is concentrated in one block, prefer the net start and net end of the whole promotional block rather than splitting it into evenly spaced micro-spans.",
    "Include an ad's full creative: dialogue and setup immediately before the brand name, sponsor tags, legal disclaimers, pricing details, URLs, promo codes, and closing lines. A brand mention is not necessarily the beginning of an ad.",
    "Native third-party sponsored capsules are paid inventory. When a named segment is explicitly introduced and closed as 'brought to you by [brand]', return one enclosing ad span for the entire capsule, including any news report or editorial-sounding material between its sponsor bookends. Do not split out and retain that middle.",
    "Ad pods often land near round durations such as about 30s, 60s, 90s, 120s, or 180s. Use that only as a weak prior when the transcript supports it, not as a hard rule.",
    ...(maxSpanDurationMinutes === null
      ? []
      : [`No single returned span may exceed ${maxSpanDurationMinutes} minutes.`]),
    "Confidence must be between 0 and 1.",
    "Prefer fewer high-confidence spans over many weak guesses.",
    ...prerollInstructions,
    "",
    buildSegmentLines(transcript)
  ].join("\n");
}

function normalizeOpenRouterSpans(
  payload: OpenRouterClassificationPayload,
  transcript: TranscriptResult
): AdDetectionResult["spans"] {
  const lastIndex = transcript.segments.length - 1;

  return payload.spans
    .filter((span) => Number.isFinite(span.startIdx) && Number.isFinite(span.endIdx))
    .map((span) => {
      const startIdx = Math.max(0, Math.min(lastIndex, Math.round(span.startIdx)));
      const endIdx = Math.max(startIdx, Math.min(lastIndex, Math.round(span.endIdx)));
      const startSegment = transcript.segments[startIdx];
      const endSegment = transcript.segments[endIdx];

      if (!startSegment || !endSegment) {
        return null;
      }

      const startOffset = clampUnitInterval(span.startOffset, 0);
      const endOffset = clampUnitInterval(span.endOffset, 1);

      return {
        startMs: Math.max(0, Math.round(msAtSegmentOffset(startSegment, startOffset, "start"))),
        endMs: Math.max(0, Math.round(msAtSegmentOffset(endSegment, endOffset, "end"))),
        confidence:
          typeof span.confidence === "number" && Number.isFinite(span.confidence)
            ? Math.max(0, Math.min(1, span.confidence))
            : 0.5,
        reason: typeof span.reason === "string" && span.reason.length > 0 ? span.reason : "openrouter_classification"
      };
    })
    .filter((span): span is AdDetectionResult["spans"][number] => span !== null && span.endMs > span.startMs);
}

function providerRoutingForModel(model: string): Record<string, unknown> | undefined {
  if (model.startsWith("deepseek/")) {
    return {
      only: ["baseten"],
      allow_fallbacks: false
    };
  }

  if (model.startsWith("openai/")) {
    return {
      only: ["openai"],
      allow_fallbacks: false
    };
  }

  return undefined;
}

export async function runOpenRouterClassificationModel(
  env: Env,
  model: string,
  transcript: TranscriptResult,
  options: AdClassificationPromptOptions = {}
): Promise<AdDetectionResult> {
  const provider = providerRoutingForModel(model);
  const { payload, metrics } = await createOpenRouterChatCompletion(env, {
    model,
    ...(provider ? { provider } : {}),
    temperature: 0.1,
    response_format: {
      type: "json_schema",
      json_schema: {
        name: "podads_ad_spans",
        strict: true,
        schema: {
          type: "object",
          additionalProperties: false,
          required: ["spans"],
          properties: {
            spans: {
              type: "array",
              items: {
                type: "object",
                additionalProperties: false,
                required: ["startIdx", "endIdx", "startOffset", "endOffset", "confidence", "reason"],
                properties: {
                  startIdx: {
                    type: "integer"
                  },
                  endIdx: {
                    type: "integer"
                  },
                  startOffset: {
                    type: "number"
                  },
                  endOffset: {
                    type: "number"
                  },
                  confidence: {
                    type: "number"
                  },
                  reason: {
                    type: "string"
                  }
                }
              }
            }
          }
        }
      }
    },
    messages: [
      {
        role: "user",
        content: buildAdClassificationPrompt(transcript, options)
      }
    ]
  });
  const parsed = parseStructuredOutput<OpenRouterClassificationPayload>(payload);
  const spans = normalizeOpenRouterSpans(parsed, transcript);

  return {
    provider: "openrouter",
    model,
    spans,
    estimatedCostUsd: metrics.estimatedCostUsd,
    requestDurationMs: metrics.requestDurationMs,
    promptTokens: metrics.promptTokens,
    completionTokens: metrics.completionTokens,
    totalTokens: metrics.totalTokens,
    routedProvider: metrics.routedProvider
  };
}

export async function openRouterClassification(
  env: Env,
  transcript: TranscriptResult,
  options: AdClassificationPromptOptions = {}
): Promise<AdDetectionResult> {
  const models = CLASSIFICATION_MODELS;
  const classificationOptions = {
    mentionPrerolls: true,
    ...options
  };
  let lastRetryableError: OpenRouterRequestError | null = null;

  for (const model of models) {
    try {
      return await runOpenRouterClassificationModel(env, model, transcript, classificationOptions);
    } catch (error) {
      if (!(error instanceof OpenRouterRequestError)) {
        throw error;
      }

      if (!isRetryableOpenRouterStatus(error.status)) {
        throw error;
      }

      lastRetryableError = error;
    }
  }

  if (lastRetryableError) {
    throw new RetryableProcessingError(
      `OpenRouter classification exhausted fallback models (${models.join(" -> ")}): ${lastRetryableError.message}`,
      lastRetryableError.retryAfterSeconds
    );
  }

  throw new Error("No OpenRouter classification models are configured.");
}
