import { createMcpHandler } from "mcp-handler";
import { z } from "zod";
import { fetchYouTubeTranscript, TranscriptError } from "../../lib/youtube";

export const maxDuration = 120;

const handler = createMcpHandler(
  async (server) => {
    server.registerTool(
      "check_connection",
      {
        title: "Check MCP connection",
        description:
          "Use this when you need to verify that the YouTube transcript MCP server is reachable.",
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
            text: "YouTube Transcript MCP connection is working.",
          },
        ],
      })
    );

    server.registerTool(
      "get_youtube_transcript",
      {
        title: "Get YouTube transcript",
        description:
          "Use this when the user provides a YouTube video URL or video ID and wants the available transcript, captions, or timestamped script. This tool retrieves existing public captions; it does not create a new transcription when no accessible captions exist.",
        inputSchema: {
          url: z
            .string()
            .min(1)
            .max(2_048)
            .describe("A YouTube video URL, shared text containing the URL, or an 11-character video ID."),
          language: z
            .string()
            .min(2)
            .max(35)
            .optional()
            .describe("Preferred language tag for the transcript provider, such as ko-KR or en-US."),
        },
        outputSchema: {
          videoId: z.string(),
          canonicalUrl: z.string().url(),
          source: z.literal("defuddle"),
          characterCount: z.number().int().nonnegative(),
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
          const result = await fetchYouTubeTranscript(url, language ?? "ko-KR");
          const characterCount = result.transcript.length;

          return {
            structuredContent: {
              videoId: result.videoId,
              canonicalUrl: result.canonicalUrl,
              source: "defuddle" as const,
              characterCount,
            },
            content: [
              {
                type: "text",
                text: [
                  `Video ID: ${result.videoId}`,
                  `Video URL: ${result.canonicalUrl}`,
                  "Transcript source: existing public captions via Defuddle",
                  `Character count: ${characterCount}`,
                  "",
                  result.transcript,
                ].join("\n"),
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
    maxDuration: 120,
    disableSse: true,
  }
);

export { handler as GET, handler as POST, handler as DELETE };
