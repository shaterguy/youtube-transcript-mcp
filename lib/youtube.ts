const YOUTUBE_URL_PATTERN = /(?<![A-Za-z0-9.-])(?:https?:\/\/)?(?:(?:www\.|m\.|music\.)?youtube\.com\/(?:watch\?(?:[^\s#]*?&)?v=|shorts\/|live\/|embed\/)|youtu\.be\/)([A-Za-z0-9_-]{11})(?![A-Za-z0-9_-])/i;
const VIDEO_ID_PATTERN = /^[A-Za-z0-9_-]{11}$/;
const DEFUDDLE_TIMEOUT_MS = 90_000;

export type TranscriptResult = {
  videoId: string;
  canonicalUrl: string;
  sourceUrl: string;
  transcript: string;
};

export class TranscriptError extends Error {
  constructor(message: string, readonly statusCode?: number) {
    super(message);
    this.name = "TranscriptError";
  }
}

export function extractYouTubeVideoId(input: string): string {
  const trimmed = input.trim();
  if (VIDEO_ID_PATTERN.test(trimmed)) {
    return trimmed;
  }

  const match = YOUTUBE_URL_PATTERN.exec(trimmed);
  if (!match) {
    throw new TranscriptError(
      "A valid YouTube video URL or 11-character video ID is required."
    );
  }

  return match[1];
}

export async function fetchYouTubeTranscript(
  input: string,
  language = "ko-KR"
): Promise<TranscriptResult> {
  const videoId = extractYouTubeVideoId(input);
  const canonicalUrl = `https://www.youtube.com/watch?v=${videoId}`;
  const sourceUrl = `https://defuddle.md/youtube.com/watch?v=${videoId}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DEFUDDLE_TIMEOUT_MS);

  try {
    const response = await fetch(sourceUrl, {
      method: "GET",
      cache: "no-store",
      redirect: "follow",
      signal: controller.signal,
      headers: {
        Accept: "text/markdown, text/plain;q=0.9, */*;q=0.1",
        "Accept-Language": language,
        "User-Agent": "YouTubeTranscriptMCP/0.2 (Vercel)",
      },
    });

    if (!response.ok) {
      throw new TranscriptError(
        `Transcript provider returned HTTP ${response.status}.`,
        response.status
      );
    }

    const transcript = (await response.text()).replace(/\r\n/g, "\n").trim();
    if (!transcript) {
      throw new TranscriptError(
        "No accessible transcript was returned for this video."
      );
    }

    return {
      videoId,
      canonicalUrl,
      sourceUrl,
      transcript,
    };
  } catch (error) {
    if (error instanceof TranscriptError) {
      throw error;
    }
    if (error instanceof Error && error.name === "AbortError") {
      throw new TranscriptError("Transcript retrieval timed out after 90 seconds.");
    }
    throw new TranscriptError(
      error instanceof Error
        ? `Transcript retrieval failed: ${error.message}`
        : "Transcript retrieval failed for an unknown reason."
    );
  } finally {
    clearTimeout(timeout);
  }
}
