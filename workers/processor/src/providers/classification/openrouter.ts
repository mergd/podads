import { createOpenRouterChatCompletion, parseStructuredOutput } from "../../lib/openrouter";
import type { AdDetectionResult, TranscriptResult } from "../../lib/types";

export const OPENROUTER_CLASSIFICATION_MODEL = "google/gemini-3.1-flash-lite-preview";
const DEFAULT_PREROLL_WINDOW_SECONDS = 120;

export interface AdClassificationPromptOptions {
  mentionPrerolls?: boolean;
}

interface OpenRouterClassificationPayload {
  spans: Array<{
    startMs: number;
    endMs: number;
    confidence: number;
    reason: string;
  }>;
}

export function buildAdClassificationPrompt(
  transcript: TranscriptResult,
  options: AdClassificationPromptOptions = {}
): string {
  const segments = transcript.segments.map((segment) => ({
    startMs: segment.startMs,
    endMs: segment.endMs,
    text: segment.text
  }));
  const prerollInstructions = options.mentionPrerolls
    ? [
        `Prerolls are common and often appear in the first ${DEFAULT_PREROLL_WINDOW_SECONDS} seconds before the show really starts.`,
        "Treat opening sponsor reads, brand intros, website calls to action, promo offers, and legal disclaimers as likely ad signals when they appear before editorial conversation begins."
      ]
    : [];

  return [
    "Identify paid advertising spans in this podcast transcript.",
    "Return JSON only.",
    "Only include host-read ads, sponsorship reads, promo codes, partner messaging, or explicit product promotions.",
    "Do not include editorial chatter, intro, outro, or self-referential jokes unless clearly promotional.",
    "Confidence must be between 0 and 1.",
    "Prefer fewer high-confidence spans over many weak guesses.",
    ...prerollInstructions,
    "",
    JSON.stringify({ segments })
  ].join("\n");
}

function normalizeOpenRouterSpans(payload: OpenRouterClassificationPayload): AdDetectionResult["spans"] {
  return payload.spans
    .filter((span) => typeof span.startMs === "number" && typeof span.endMs === "number")
    .map((span) => ({
      startMs: Math.max(0, Math.round(span.startMs)),
      endMs: Math.max(0, Math.round(span.endMs)),
      confidence:
        typeof span.confidence === "number" && Number.isFinite(span.confidence)
          ? Math.max(0, Math.min(1, span.confidence))
          : 0.5,
      reason: typeof span.reason === "string" && span.reason.length > 0 ? span.reason : "openrouter_classification"
    }))
    .filter((span) => span.endMs > span.startMs);
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
                required: ["startMs", "endMs", "confidence", "reason"],
                properties: {
                  startMs: {
                    type: "number"
                  },
                  endMs: {
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
  const spans = normalizeOpenRouterSpans(parsed);

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
  transcript: TranscriptResult
): Promise<AdDetectionResult> {
  return runOpenRouterClassificationModel(env, OPENROUTER_CLASSIFICATION_MODEL, transcript);
}
