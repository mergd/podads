import {
  createOpenRouterChatCompletion,
  isRetryableOpenRouterStatus,
  OpenRouterRequestError,
  parseStructuredOutput
} from "../../lib/openrouter";
import { RetryableProcessingError } from "../../lib/retryable";
import type { AdDetectionResult, TranscriptResult } from "../../lib/types";

export const OPENROUTER_CLASSIFICATION_MODEL = "google/gemini-3.1-flash-lite-preview";
export const OPENROUTER_CLASSIFICATION_FALLBACK_MODEL = "openai/gpt-5.4-mini";
const DEFAULT_PREROLL_WINDOW_SECONDS = 120;

export interface AdClassificationPromptOptions {
  mentionPrerolls?: boolean;
  maxSpanDurationMs?: number;
}

interface OpenRouterClassificationPayload {
  spans: Array<{
    startIdx: number;
    endIdx: number;
    confidence: number;
    reason: string;
  }>;
}

function sanitizeSegmentText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
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
    "For each ad span, return the inclusive `startIdx` and `endIdx` referring to those segment indices.",
    "Only include host-read ads, sponsorship reads, promo codes, partner messaging, or explicit product promotions.",
    "Do not include editorial chatter, intro, outro, or self-referential jokes unless clearly promotional.",
    "When an ad pod is concentrated in one block, prefer the net start and net end of the whole promotional block rather than splitting it into evenly spaced micro-spans.",
    "Include adjacent ad copy that belongs to the same spot, such as sponsor tags, legal disclaimers, pricing details, URLs, promo codes, and short bridge lines that are still part of the paid read.",
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

      return {
        startMs: Math.max(0, Math.round(startSegment.startMs)),
        endMs: Math.max(0, Math.round(endSegment.endMs)),
        confidence:
          typeof span.confidence === "number" && Number.isFinite(span.confidence)
            ? Math.max(0, Math.min(1, span.confidence))
            : 0.5,
        reason: typeof span.reason === "string" && span.reason.length > 0 ? span.reason : "openrouter_classification"
      };
    })
    .filter((span): span is AdDetectionResult["spans"][number] => span !== null && span.endMs > span.startMs);
}

export async function runOpenRouterClassificationModel(
  env: Env,
  model: string,
  transcript: TranscriptResult,
  options: AdClassificationPromptOptions = {}
): Promise<AdDetectionResult> {
  const { payload, metrics } = await createOpenRouterChatCompletion(env, {
    model,
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
                required: ["startIdx", "endIdx", "confidence", "reason"],
                properties: {
                  startIdx: {
                    type: "integer"
                  },
                  endIdx: {
                    type: "integer"
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
    totalTokens: metrics.totalTokens
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
