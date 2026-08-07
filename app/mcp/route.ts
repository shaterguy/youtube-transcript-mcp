import { createMcpHandler } from "mcp-handler";
import { z } from "zod";
import { isGeminiConfigured } from "../../lib/gemini";
import {
  getCachedYouTubeTranscript,
  TRANSCRIPT_CACHE_VERSION,
} from "../../lib/transcript-cache";
import { TranscriptError } from "../../lib/youtube";
import {
  YOUTUBE_RESPONSE_CONTRACT,
  YOUTUBE_RESPONSE_POLICY_VERSION,
  YOUTUBE_SERVER_INSTRUCTIONS,
  YOUTUBE_TRANSCRIPT_TOOL_DESCRIPTION,
} from "../../lib/youtube-response-policy";

export const maxDuration = 300;

const responseContractSchema = z.object({
  policyVersion: z.literal(YOUTUBE_RESPONSE_POLICY_VERSION),
  scope: z.literal("youtube-content-only"),
  transcriptAcquisition: z.object({
    tool: z.literal("get_youtube_transcript"),
    exclusivePath: z.literal(true),
    otherTranscriptToolsAllowed: z.literal(false),
    externalResearchAfterTranscriptAllowed: z.literal(true),
  }),
  contentGeneration: z.object({
    performedByMcp: z.literal(false),
    performedByHostLlm: z.literal(true),
    mcpProvidesTranscriptAndResponseRulesOnly: z.literal(true),
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
    attachToMajorMeaningUnits: z.literal(true),
    useActualSpeechPositionsOnly: z.literal(true),
    neverInvent: z.literal(true),
    displayTextFormat: z.literal("MM:SS or HH:MM:SS"),
    markdownLinkTemplate: z.literal(
      "[<displayTimestamp>](<canonicalUrl>&t=<seconds>s)"
    ),
  }),
});

const handler = createMcpHandler(
  async (server) => {
    server.registerTool(
      "check_connection",
      {
        title: "Check MCP connection",
        description:
          "Use this when you need to verify that the YouTube transcript MCP server is reachable and whether the Gemini fallback, transcript cache, and YouTube response policy are configured.",
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
              `YouTube response policy configured: yes (${YOUTUBE_RESPONSE_POLICY_VERSION}).`,
            ].join("\n"),
          },
        ],
      })
    );

    server.registerTool(
      "get_youtube_transcript",
      {
        title: "Get or transcribe YouTube video",
        description: [
          YOUTUBE_TRANSCRIPT_TOOL_DESCRIPTION,
          "The complete transcript is returned in the structured output field named transcript.",
          "Results are cached by normalized video ID and language so repeated requests reuse the stored transcript instead of transcribing the video again.",
          "The tool first tries existing public captions and, if the cloud request is blocked or captions are unavailable, transcribes the public video through Gemini.",
        ].join(" "),
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
          responsePolicyVersion: z.literal(YOUTUBE_RESPONSE_POLICY_VERSION),
          responseContract: responseContractSchema,
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
            responsePolicyVersion: YOUTUBE_RESPONSE_POLICY_VERSION,
            responseContract: YOUTUBE_RESPONSE_CONTRACT,
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
  {
    instructions: YOUTUBE_SERVER_INSTRUCTIONS,
  },
  {
    basePath: "",
    verboseLogs: true,
    maxDuration: 300,
    disableSse: true,
  }
);

export { handler as GET, handler as POST, handler as DELETE };
