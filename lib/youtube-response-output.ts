import { isUsablePublicTranscript } from "./youtube";
import type { TranscriptionJobResult } from "./gemini-async";

export function hasCompleteTranscript(result: TranscriptionJobResult): boolean {
  return result.status === "completed" && result.totalSegments > 0 &&
    result.completedSegments === result.totalSegments && Array.isArray(result.segments) && result.segments.length === result.totalSegments &&
    result.segments.every(s => s.status === "completed") &&
    typeof result.transcript === "string" && isUsablePublicTranscript(result.transcript);
}

/** Deliver verified source data, stripping legacy writing policy from cached results. */
export function sanitizeTranscriptResult(result: TranscriptionJobResult) {
  const clean = { ...result } as TranscriptionJobResult & Record<string, unknown>;
  delete clean.responsePolicyVersion; delete clean.responseDirective; delete clean.responseContract;
  if (!hasCompleteTranscript(clean)) {
    if (clean.status === "completed") {
      clean.status = "blocked"; clean.shouldPoll = false; clean.retryable = false;
      clean.reason = clean.error = "Stored completion has no verified complete transcript; no success response was emitted.";
    }
    delete clean.transcript; delete clean.first30Lines; delete clean.characterCount; delete clean.lineCount;
    delete clean.cacheProvider; delete clean.cacheVersion; delete clean.cacheCreatedAt; delete clean.cacheKey;
  }
  return clean;
}
