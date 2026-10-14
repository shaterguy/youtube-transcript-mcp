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
