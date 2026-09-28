import {
  GeminiTranscriptError,
  transcribeYouTubeWithGemini,
} from "./gemini";

const YOUTUBE_URL_PATTERN = /(?<![A-Za-z0-9.-])(?:https?:\/\/)?(?:(?:www\.|m\.|music\.)?youtube\.com\/(?:watch\?(?:[^\s#]*?&)?v=|shorts\/|live\/|embed\/)|youtu\.be\/)([A-Za-z0-9_-]{11})(?![A-Za-z0-9_-])/i;
const VIDEO_ID_PATTERN = /^[A-Za-z0-9_-]{11}$/;
const DEFUDDLE_TIMEOUT_MS = 2_000;

function extractUsableTranscriptBody(transcript: string): string {
  const lines = transcript.replace(/\r\n/g, "\n").split("\n");
  let startIndex = 0;

  if (lines[0]?.trim() === "---") {
    const frontMatterEnd = lines.findIndex(
      (line, index) => index > 0 && line.trim() === "---"
    );
    if (frontMatterEnd >= 0) {
      startIndex = frontMatterEnd + 1;
    }
  }

  return lines
    .slice(startIndex)
    .map((line) => line.trim())
    .filter(
      (line) =>
        line.length > 0 &&
        line !== "---" &&
        !/^(?:title|site|source|domain):\s*/i.test(line) &&
        !/^!\[[^\]]*\]\([^)]*\)$/.test(line) &&
        !/^https?:\/\/\S+$/.test(line)
    )
    .join("\n")
    .trim();
}

export function isUsablePublicTranscript(transcript: string): boolean {
  return Boolean(extractUsableTranscriptBody(transcript));
}

function assertUsablePublicTranscript(transcript: string): void {
  if (!isUsablePublicTranscript(transcript)) {
    throw new TranscriptError(
      "The public-caption provider returned metadata but no transcript text."
    );
  }
}

export type TranscriptSource = "defuddle" | "gemini";

export type TranscriptResult = {
  videoId: string;
  canonicalUrl: string;
  source: TranscriptSource;
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

async function fetchFromDefuddle(
  videoId: string,
  language: string
): Promise<string> {
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
        "User-Agent": "YouTubeTranscriptMCP/0.3 (Vercel)",
      },
    });

    if (!response.ok) {
      throw new TranscriptError(
        `Public-caption provider returned HTTP ${response.status}.`,
        response.status
      );
    }

    const transcript = (await response.text()).replace(/\r\n/g, "\n").trim();
    if (!transcript) {
      throw new TranscriptError(
        "The public-caption provider returned an empty transcript."
      );
    }
    assertUsablePublicTranscript(transcript);
    return transcript;
  } catch (error) {
    if (error instanceof TranscriptError) {
      throw error;
    }
    if (error instanceof Error && error.name === "AbortError") {
      throw new TranscriptError(
        "The public-caption provider timed out after 2 seconds."
      );
    }
    throw new TranscriptError(
      error instanceof Error
        ? `Public-caption retrieval failed: ${error.message}`
        : "Public-caption retrieval failed for an unknown reason."
    );
  } finally {
    clearTimeout(timeout);
  }
}

export async function fetchYouTubeTranscript(
  input: string,
  language = "ko-KR"
): Promise<TranscriptResult> {
  const videoId = extractYouTubeVideoId(input);
  const canonicalUrl = `https://www.youtube.com/watch?v=${videoId}`;

  try {
    const transcript = await fetchFromDefuddle(videoId, language);
    return {
      videoId,
      canonicalUrl,
      source: "defuddle",
      transcript,
    };
  } catch (publicCaptionError) {
    try {
      const transcript = await transcribeYouTubeWithGemini(canonicalUrl);
      return {
        videoId,
        canonicalUrl,
        source: "gemini",
        transcript,
      };
    } catch (geminiError) {
      const publicMessage =
        publicCaptionError instanceof Error
          ? publicCaptionError.message
          : "Unknown public-caption error.";
      const geminiMessage =
        geminiError instanceof GeminiTranscriptError || geminiError instanceof Error
          ? geminiError.message
          : "Unknown Gemini transcription error.";
      throw new TranscriptError(
        `Both transcript paths failed. Public captions: ${publicMessage} Gemini: ${geminiMessage}`
      );
    }
  }
}
