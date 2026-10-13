import { unstable_cache } from "next/cache";
import {
  extractYouTubeVideoId,
  fetchYouTubeTranscript,
  type TranscriptResult,
} from "./youtube";

export const TRANSCRIPT_CACHE_VERSION = "v3";

export type CachedTranscriptResult = TranscriptResult & {
  cacheProvider: "vercel-data-cache";
  cacheVersion: string;
  cacheCreatedAt: string;
};

function normalizeLanguage(language?: string): string {
  const normalized = language?.trim();
  return normalized ? normalized.toLowerCase() : "ko-kr";
}

export async function getCachedYouTubeTranscript(
  input: string,
  language?: string
): Promise<CachedTranscriptResult> {
  const videoId = extractYouTubeVideoId(input);
  const normalizedLanguage = normalizeLanguage(language);

  const loadTranscript = unstable_cache(
    async (): Promise<CachedTranscriptResult> => {
      const result = await fetchYouTubeTranscript(videoId, normalizedLanguage);
      return {
        ...result,
        cacheProvider: "vercel-data-cache",
        cacheVersion: TRANSCRIPT_CACHE_VERSION,
        cacheCreatedAt: new Date().toISOString(),
      };
    },
    [
      "youtube-transcript",
      TRANSCRIPT_CACHE_VERSION,
      videoId,
      normalizedLanguage,
    ],
    {
      revalidate: false,
      tags: [`youtube-transcript-${videoId}`],
    }
  );

  return loadTranscript();
}
