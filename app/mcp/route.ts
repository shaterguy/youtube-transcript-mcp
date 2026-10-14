import { createMcpHandler } from "mcp-handler";
import { z } from "zod";
import { isGeminiConfigured } from "../../lib/gemini";
import { completedPolicyShape, withYouTubeResponsePolicy } from "../../lib/youtube-response-output";
import { startPersistentTranscriptionJob, getPersistentTranscriptionJob, isDurableTranscriptStoreConfigured } from "../../lib/job-store";
import {
  YOUTUBE_RESPONSE_POLICY_VERSION,
  YOUTUBE_SERVER_INSTRUCTIONS,
  YOUTUBE_TRANSCRIPT_TOOL_DESCRIPTION,
} from "../../lib/youtube-response-policy";

export const maxDuration = 300;

const asyncJobOutputSchema = z.object({
  ...completedPolicyShape,
  cacheProvider: z.enum(["durable-local", "durable-redis"]).optional(),
  cacheVersion: z.literal("durable-v3").optional(),
  cacheCreatedAt: z.string().datetime().optional(),
  cacheKey: z.string().optional(),
  status: z.enum(["queued", "in_progress", "completed", "failed", "cancelled", "incomplete", "requires_action", "rate_limited", "blocked"]),
  jobToken: z.string(),
  videoId: z.string(),
  canonicalUrl: z.string(),
  segmentation: z.enum(["file-clips", "prompt-scoped", "whole-video", "captions"]),
  source: z.enum(["yt-dlp", "gemini"]),
  durationSeconds: z.number().int().nullable(),
  completedSegments: z.number().int().nonnegative(),
  totalSegments: z.number().int().positive(),
  segments: z.array(z.object({
    startSeconds: z.number().int().nonnegative(),
    endSeconds: z.number().int().nullable(),
    modelIndex: z.number().int().nonnegative(),
    model: z.string(),
    attempts: z.number().int().nonnegative(),
    status: z.enum(["queued", "in_progress", "completed", "failed", "cancelled", "incomplete", "requires_action", "rate_limited", "blocked"]),
    error: z.string().optional(),
    lastReadError: z.string().optional(),
    lastPostError: z.string().optional(),
    lastProviderStatus: z.string().optional(),
    lastHttpStatus: z.number().int().optional(),
    lastCheckedAt: z.number().int().optional(),
    lastRetryAfterMs: z.number().nonnegative().optional(),
    nextStatusCheckAt: z.number().optional(),
    cooldownSkipped: z.boolean().optional(),
  })),
  readWarning: z.string().optional(),
  providerStatus: z.string().optional(),
  reason: z.string().optional(),
  retryable: z.boolean().optional(),
  shouldPoll: z.boolean().optional(),
  nextStatusCheckAt: z.number().optional(),
  transcript: z.string().optional(),
  characterCount: z.number().int().nonnegative().optional(),
  lineCount: z.number().int().nonnegative().optional(),
  first30Lines: z.array(z.string()).optional(),
  error: z.string().optional(),
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
              `Transcript cache configured: ${isDurableTranscriptStoreConfigured() ? "yes" : "no"} (durable-v3, normalized video ID + language).`,
              `YouTube response policy configured: yes (${YOUTUBE_RESPONSE_POLICY_VERSION}).`,
            ].join("\n"),
          },
        ],
      })
    );

    server.registerTool(
      "start_youtube_transcript_job",
      {
        title: "Get cached captions or start durable YouTube transcription",
        description: [
          YOUTUBE_TRANSCRIPT_TOOL_DESCRIPTION,
          "A single start reuses complete cached transcripts or active jobs by normalized video ID and language, then tries yt-dlp captions, then Gemini background transcription if captions are unavailable.",
          "Returns completed caption/cache results directly, or a durable jobToken for later retrieval. There is no whole-job timeout; transport timeouts never cancel an accepted job.",
          "Every verified completion carries the same responseDirective and responseContract before transcript, regardless of acquisition path.",
          "YouTube URL is submitted once for the entire video after public captions are checked; only Files API URIs support physical clipping.",
          "Optional Gemini Files API URI enables actual clipped media windows. Initial POST throttling has bounded retries; confirmed provider stops are never silently resubmitted.",
          "Pass durationSeconds if known. Otherwise YouTube metadata is checked; when duration cannot",
          "be verified, the full video is submitted asynchronously as one job (segmentation=whole-video).",
          "Follow up with the latest jobToken only while shouldPoll=true. Stop automatic waiting on any blocked or terminal status.",
          "Read reason/retryable/nextStatusCheckAt before explicitly retrying a status GET. Never present partial text as a complete transcript.",
        ].join(" "),
        inputSchema: {
          url: z.string().min(1).max(2048),
          language: z.string().min(2).max(35).optional(),
          durationSeconds: z.number().int().min(1).max(86400).optional(),
          chunkSeconds: z.number().int().min(60).max(900).optional(),
          geminiFileUri: z.string().url().optional().describe("Optional Google Gemini Files API video URI for native physical clips."),
          geminiMimeType: z.string().regex(/^video\/[a-z0-9.+-]+$/i).optional(),
        },
        outputSchema: asyncJobOutputSchema.shape,
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: false,
          openWorldHint: true,
        },
      },
      async (args) => {
        try {
          const result = withYouTubeResponsePolicy(await startPersistentTranscriptionJob(args));
          return { structuredContent: result, content: [{ type: "text", text: JSON.stringify(result) }] };
        } catch (error) {
          return { isError: true, content: [{ type: "text", text: error instanceof Error ? error.message : "Could not start transcription job." }] };
        }
      }
    );

    server.registerTool(
      "get_youtube_transcript_job",
      {
        title: "Poll background transcription job and assemble completed clips",
        description: [
          "Retrieve the same durable job, resume a proven pre-submission acquisition after its lease expires, and combine text only when ALL segments completed.",
          "Stop automatic waiting when shouldPoll=false: rate_limited, blocked, requires_action, failed, cancelled or incomplete.",
          "For accepted interactions, retryable means the same status GET only. A proven unsubmitted acquisition or explicitly rejected initial POST may resume within the same job after its cooldown; unknown POST outcomes are never replayed.",
          "Use readOnly=true to prohibit all provider POSTs, including acquisition recovery and rejected-submit retries.",
          "Pass the durable jobToken on every poll; the store recovers the latest state across workers.",
          "Returns full transcript only if status=completed. Never infer completeness from partial progress.",
        ].join(" "),
        inputSchema: {
          jobToken: z.string().min(1).max(128000),
          readOnly: z.boolean().optional().describe("GET-only status diagnosis. Never submits or retries Gemini interactions."),
        },
        outputSchema: asyncJobOutputSchema.shape,
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: false,
          openWorldHint: true,
        },
      },
      async ({ jobToken, readOnly }) => {
        try {
          const result = withYouTubeResponsePolicy(await getPersistentTranscriptionJob(jobToken,{readOnly}));
          return { structuredContent: result, content: [{ type: "text", text: JSON.stringify(result) }] };
        } catch (error) {
          return { isError: true, content: [{ type: "text", text: error instanceof Error ? error.message : "Could not poll transcription job." }] };
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

const instrumentedHandler = async (request: Request) => {
  let bodyMethod: string | null = null;
  try {
    const raw = await request.clone().text();
    if (raw) {
      const parsed = JSON.parse(raw) as { method?: unknown };
      bodyMethod = typeof parsed?.method === "string" ? parsed.method : null;
    }
  } catch {
    bodyMethod = null;
  }

  console.log(
    "MCP_DIAG",
    JSON.stringify({
      ts: new Date().toISOString(),
      httpMethod: request.method,
      protocolVersion: request.headers.get("mcp-protocol-version"),
      mcpMethod: request.headers.get("mcp-method"),
      mcpName: request.headers.get("mcp-name"),
      hasSessionId: Boolean(request.headers.get("mcp-session-id")),
      accept: request.headers.get("accept"),
      bodyMethod,
    })
  );

  return handler(request);
};

export {
  instrumentedHandler as GET,
  instrumentedHandler as POST,
  instrumentedHandler as DELETE,
};
