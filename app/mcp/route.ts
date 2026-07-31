import { createMcpHandler } from "mcp-handler";
import { z } from "zod";
import { isGeminiConfigured } from "../../lib/gemini";
import {
  getCachedYouTubeTranscript,
  TRANSCRIPT_CACHE_VERSION,
} from "../../lib/transcript-cache";
import { TranscriptError } from "../../lib/youtube";

export const maxDuration = 300;

const handler = createMcpHandler(
  async (server) => {
    server.registerTool(
      "check_connection",
      {
        title: "Check MCP connection",
        description:
          "Use this when you need to verify that the YouTube transcript MCP server is reachable and whether the Gemini fallback and transcript cache are configured.",
        inputSchema: z.object({}),
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      async () => ({
        content: [
          {
            type: "text",
            text: [
              "YouTube Transcript MCP connection is working.",
              `Gemini fallback configured: ${isGeminiConfigured() ? "yes" : "no"}.`,
              `Transcript cache configured: yes (${TRANSCRIPT_CACHE_VERSION}).`,
            ].join("\n"),
          },
        ],
      })
    );

    server.registerTool(
      "get_youtube_transcript",
      {
        title: "Get or transcribe YouTube video",
        description:
          "Use this when the user provides a public YouTube video URL or video ID and wants a transcript, captions, or timestamped script. The complete transcript is returned in the structured output field named transcript. Results are cached by normalized video ID and language so repeated requests reuse the stored transcript instead of transcribing the video again. The tool first tries existing public captions and, if the cloud request is blocked or captions are unavailable, transcribes the public video through Gemini.",
        inputSchema: {
          url: z
            .string()
            .min(1)
            .max(2_048)
            .describe("A public YouTube video URL, shared text containing the URL, or an 11-character video ID."),
          language: z
            .string()
            .min(2)
            .max(35)
            .optional()
            .describe("Preferred language tag for the public-caption provider, such as ko-KR or en-US."),
        },
        outputSchema: {
          videoId: z.string(),
          canonicalUrl: z.string().url(),
          source: z.enum(["defuddle", "gemini"]),
          characterCount: z.number().int().nonnegative(),
          lineCount: z.number().int().nonnegative(),
          first30Lines: z.array(z.string()).max(30),
          transcript: z.string(),
          cacheProvider: z.literal("vercel-data-cache"),
          cacheVersion: z.string(),
          cacheCreatedAt: z.string().datetime(),
        },
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: true,
        },
      },
      async ({ url, language }) => {
        try {
          const result = await getCachedYouTubeTranscript(url, language);
          const transcriptLines = result.transcript.split("\n");
          const structuredResult = {
            videoId: result.videoId,
            canonicalUrl: result.canonicalUrl,
            source: result.source,
            characterCount: result.transcript.length,
            lineCount: transcriptLines.length,
            first30Lines: transcriptLines.slice(0, 30),
            transcript: result.transcript,
            cacheProvider: result.cacheProvider,
            cacheVersion: result.cacheVersion,
            cacheCreatedAt: result.cacheCreatedAt,
          };

          return {
            structuredContent: structuredResult,
            content: [
              {
                type: "text",
                text: JSON.stringify(structuredResult, null, 2),
              },
            ],
          };
        } catch (error) {
          const message =
            error instanceof TranscriptError
              ? error.message
              : error instanceof Error
                ? error.message
                : "Unknown transcript retrieval error.";

          return {
            isError: true,
            content: [
              {
                type: "text",
                text: `Could not retrieve the YouTube transcript. ${message}`,
              },
            ],
          };
        }
      }
    );
  },
  {},
  {
    basePath: "",
    verboseLogs: true,
    maxDuration: 300,
    disableSse: true,
  }
);

export { handler as GET, handler as POST, handler as DELETE };
