import { z } from "zod";
import { isUsablePublicTranscript } from "./youtube";
import type { TranscriptionJobResult } from "./gemini-async";
import { YOUTUBE_RESPONSE_POLICY_VERSION, YOUTUBE_FINAL_RESPONSE_DIRECTIVE, YOUTUBE_RESPONSE_CONTRACT } from "./youtube-response-policy";
export const responseContractSchema = z.object({
  policyVersion: z.literal(YOUTUBE_RESPONSE_POLICY_VERSION),
  scope: z.literal("youtube-content-only"),
  transcriptAcquisition: z.object({
    tool: z.literal("start_youtube_transcript_job"),
    exclusivePath: z.literal(true),
    otherTranscriptToolsAllowed: z.literal(false),
    externalResearchAfterTranscriptAllowed: z.literal(true),
  }),
  contentGeneration: z.object({
    performedByMcp: z.literal(false),
    performedByHostLlm: z.literal(true),
    mcpProvidesTranscriptAndResponseRulesOnly: z.literal(true),
  }),
  composition: z.object({
    mode: z.literal("source-assimilated-report"),
    reportStyleRequired: z.literal(true),
    transcriptRetellingForbidden: z.literal(true),
    attributionNarrationForbidden: z.literal(true),
    sourceViewpointPreservedWithoutAttributionFrame: z.literal(true),
    rule: z.string(),
    negativeExamples: z.array(z.string()),
    positiveExamples: z.array(z.string()),
  }),
  defaultMode: z.literal("organized-analysis"),
  rawTranscriptOnlyWhenExplicitlyRequested: z.literal(true),
  transcriptCleanup: z.object({
    silentlyCorrectObviousTyposAndTranscriptionErrors: z.literal(true),
  }),
  sections: z.object({
    overview: z.object({
      label: z.literal("[개요]"),
      required: z.literal(true),
      rule: z.string(),
    }),
    content: z.object({
      label: z.literal("[내용정리]"),
      required: z.literal(true),
      rule: z.string(),
    }),
    factCheck: z.object({
      label: z.literal("[사실검증]"),
      required: z.literal(false),
      omitWhenNoMaterialError: z.literal(true),
      rule: z.string(),
    }),
    additionalAnalysis: z.object({
      label: z.literal("[추가분석]"),
      required: z.literal(true),
      rule: z.string(),
    }),
  }),
  timestamps: z.object({
    clickable: z.literal(true),
    markdownLinkRequired: z.literal(true),
    rejectPlainTextTimestamp: z.literal(true),
    placement: z.literal("end-of-content-unit"),
    prefixPlacementForbidden: z.literal(true),
    standalonePlacementForbidden: z.literal(true),
    headingPlacementForbidden: z.literal(true),
    afterTerminalPunctuation: z.literal(true),
    attachToMajorMeaningUnits: z.literal(true),
    oneRepresentativeTimestampPerMeaningUnitPreferred: z.literal(true),
    useActualSpeechPositionsOnly: z.literal(true),
    neverInvent: z.literal(true),
    displayTextFormat: z.literal("MM:SS or HH:MM:SS"),
    markdownLinkTemplate: z.literal(
      "<content sentence or paragraph>. [<displayTimestamp>](<canonicalUrl>&t=<seconds>s)"
    ),
  }),
});


export const completedPolicyShape = {
  responsePolicyVersion: z.literal(YOUTUBE_RESPONSE_POLICY_VERSION).optional(),
  responseDirective: z.literal(YOUTUBE_FINAL_RESPONSE_DIRECTIVE).optional(),
  responseContract: responseContractSchema.optional(),
};

export function hasCompleteTranscript(result: TranscriptionJobResult): boolean {
  return result.status === "completed" && result.totalSegments > 0 &&
    result.completedSegments === result.totalSegments && Array.isArray(result.segments) && result.segments.length === result.totalSegments &&
    result.segments.every(s => s.status === "completed") &&
    typeof result.transcript === "string" && isUsablePublicTranscript(result.transcript);
}

/** Apply the current contract at delivery time, never from a stored/cache policy. */
export function withYouTubeResponsePolicy(result: TranscriptionJobResult) {
  const clean = { ...result } as TranscriptionJobResult & Record<string, unknown>;
  delete clean.responsePolicyVersion; delete clean.responseDirective; delete clean.responseContract;
  if (!hasCompleteTranscript(clean)) {
    if (clean.status === "completed") {
      clean.status = "blocked"; clean.shouldPoll = false; clean.retryable = false;
      clean.reason = clean.error = "Stored completion has no verified complete transcript; no success response was emitted.";
    }
    delete clean.transcript; delete clean.first30Lines; delete clean.characterCount; delete clean.lineCount;
    delete clean.cacheProvider; delete clean.cacheVersion; delete clean.cacheCreatedAt; delete clean.cacheKey;
    return clean;
  }
  return {
    responsePolicyVersion: YOUTUBE_RESPONSE_POLICY_VERSION,
    responseDirective: YOUTUBE_FINAL_RESPONSE_DIRECTIVE,
    responseContract: YOUTUBE_RESPONSE_CONTRACT,
    ...clean,
  };
}
