import {
  GeminiTranscriptError,
  transcribeYouTubeWithGemini,
} from "./gemini";
import { getYouTubeCaptionsWithYtDlp, YtDlpCaptionError } from "./yt-dlp";

const YOUTUBE_URL_PATTERN = /(?<![A-Za-z0-9.-])(?:https?:\/\/)?(?:(?:www\.|m\.|music\.)?youtube\.com\/(?:watch\?(?:[^\s#]*?&)?v=|shorts\/|live\/|embed\/)|youtu\.be\/)([A-Za-z0-9_-]{11})(?![A-Za-z0-9_-])/i;
const VIDEO_ID_PATTERN = /^[A-Za-z0-9_-]{11}$/;

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

export type TranscriptSource = "yt-dlp" | "gemini";

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

export async function fetchYouTubeTranscript(
  input: string,
  language = "ko-KR"
): Promise<TranscriptResult> {
  const videoId = extractYouTubeVideoId(input);
  const canonicalUrl = `https://www.youtube.com/watch?v=${videoId}`;

  try {
    const captions = await getYouTubeCaptionsWithYtDlp(videoId, language);
    return {
      videoId,
      canonicalUrl,
      source: "yt-dlp",
      transcript: captions.transcript,
    };
  } catch (publicCaptionError) {
    // Transport or deployment failure does not establish absent captions.
    if (!(publicCaptionError instanceof YtDlpCaptionError) ||
        ["executable_unavailable", "video_unavailable"].includes(publicCaptionError.reason)) {
      throw new TranscriptError(
        publicCaptionError instanceof Error ? publicCaptionError.message : "Could not check captions."
      );
    }
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
