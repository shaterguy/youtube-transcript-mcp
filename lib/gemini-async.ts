/**
 * Durable, stateless Gemini Interactions API transcription jobs.
 * Vercel/Termux share this implementation; the client retains a signed progress token.
 * No in-process background promises or ephemeral server-side job map is used.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { deflateRawSync, inflateRawSync } from "node:zlib";
import { extractYouTubeVideoId } from "./youtube";
import { getYouTubeCaptionsWithYtDlp, YtDlpCaptionError } from "./yt-dlp";

const GEMINI_ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/interactions";
const API_REVISION = "2026-05-20";
const MODELS = ["gemini-3.6-flash"] as const;
const TOKEN_VALID_MS = 180 * 24 * 60 * 60 * 1000;
const MAX_SIGNED_JOB_TOKEN_LENGTH = 128_000;
const MAX_COMPRESSED_SEGMENT_CHARS = 48_000;
const MAX_DECOMPRESSED_SEGMENT_BYTES = 160_000;
const MAX_SEGMENTS = 24;
const MAX_SIMULTANEOUS_STARTS = 2;
const CLIP_OVERLAP_SECONDS = 3;
const RETRY_DELAYS_MS = [1000, 3000, 7000];

// A POST may have created a remote interaction even when its reply was lost.
class AmbiguousSubmissionError extends Error {}

export type JobStatus = "queued" | "in_progress" | "completed" | "failed" | "cancelled" | "incomplete" | "requires_action" | "rate_limited" | "blocked";
export type SegmentState = {
  startSeconds: number;
  endSeconds: number | null;
  interactionId: string | null;
  modelIndex: number;
  attempts: number;
  lastError?: string;
  lastReadError?: string;
  lastPostError?: string;
  lastProviderStatus?: string;
  lastHttpStatus?: number;
  lastCheckedAt?: number;
  lastRetryAfterMs?: number;
  cooldownSkipped?: boolean;
  // Compressed transcript allows safe resume without re-reading completed Gemini jobs.
  // The signed token is integrity-protected, not encrypted.
  transcriptZ?: string;
  read429Count?: number;
  // Never resubmit after a POST with an indeterminate provider outcome.
  submissionUnknown?: boolean;
  nextStatusCheckAt?: number;
};
type JobState = {
  version: 1;
  videoId: string;
  language: string;
  createdAt: number;
  durationSeconds: number | null;
  chunkSeconds: number;
  geminiFileUri?: string;
  geminiMimeType?: string;
  segments: SegmentState[];
  captionZ?: string;
};
export type TranscriptionJobResult = {
  cacheProvider?: "durable-local" | "durable-redis";
  cacheVersion?: "durable-v3";
  cacheCreatedAt?: string;
  cacheKey?: string;

  status: JobStatus;
  jobToken: string;
  videoId: string;
  canonicalUrl: string;
  segmentation: "file-clips" | "prompt-scoped" | "whole-video" | "captions";
  source: "yt-dlp" | "gemini";
  durationSeconds: number | null;
  completedSegments: number;
  totalSegments: number;
  segments: Array<Pick<SegmentState, "startSeconds" | "endSeconds" | "modelIndex" | "attempts"> & {
    status: JobStatus | "queued" | "requires_action";
    model: string;
    error?: string;
    lastReadError?: string;
  lastPostError?: string;
    lastProviderStatus?: string;
    lastHttpStatus?: number;
    lastCheckedAt?: number;
    lastRetryAfterMs?: number;
    nextStatusCheckAt?: number;
    cooldownSkipped?: boolean;
  }>;
  readWarning?: string;
  // retryable means an explicit status GET can be retried, never permission for a new POST.
  providerStatus?: string;
  reason?: string;
  retryable?: boolean;
  shouldPoll?: boolean;
  nextStatusCheckAt?: number;
  transcript?: string;
  characterCount?: number;
  lineCount?: number;
  first30Lines?: string[];
  error?: string;
};

function getApiKey(): string {
  const value = process.env.GEMINI_API_KEY?.trim();
  if (!value) throw new Error("GEMINI_API_KEY is not configured.");
  return value;
}
function getTokenKey(): string {
  return process.env.YOUTUBE_TRANSCRIPT_JOB_SIGNING_KEY?.trim() || getApiKey();
}
function sign(payload: string): string {
  return createHmac("sha256", getTokenKey()).update(payload).digest("base64url");
}
function encodeJob(state: JobState): string {
  const body = Buffer.from(JSON.stringify(state)).toString("base64url");
  const token = `${body}.${sign(body)}`;
  if (token.length > MAX_SIGNED_JOB_TOKEN_LENGTH) {
    throw new Error("Transcription job state exceeded the token size limit. Use smaller clip windows.");
  }
  return token;
}
function compressTranscript(text: string): string {
  const packed = deflateRawSync(Buffer.from(text, "utf8"), { level: 9 }).toString("base64url");
  if (packed.length > MAX_COMPRESSED_SEGMENT_CHARS) {
    throw new Error("Transcribed clip exceeded the maximum cached text size.");
  }
  return packed;
}
function restoreTranscript(encoded: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(encoded) || encoded.length > MAX_COMPRESSED_SEGMENT_CHARS) {
    throw new Error("Invalid cached transcript encoding.");
  }
  return inflateRawSync(Buffer.from(encoded, "base64url"), {
    maxOutputLength: MAX_DECOMPRESSED_SEGMENT_BYTES,
  }).toString("utf8");
}
function decodeJob(token: string): JobState {
  if (token.length > MAX_SIGNED_JOB_TOKEN_LENGTH || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)) {
    throw new Error("Invalid transcription job token.");
  }
  const [body, signature] = token.split(".");
  const validSignature = sign(body);
  const a = Buffer.from(signature);
  const b = Buffer.from(validSignature);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    throw new Error("Invalid transcription job signature.");
  }
  const state = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as JobState;
  if (state.version !== 1 || !/^[\w-]{11}$/.test(state.videoId) ||
      !Number.isFinite(state.createdAt) || state.createdAt > Date.now() + 60_000 ||
      Date.now() - state.createdAt > TOKEN_VALID_MS ||
      (state.geminiFileUri !== undefined && !/^https:\/\/generativelanguage\.googleapis\.com\/v1beta\/files\/[a-zA-Z0-9_-]+$/.test(state.geminiFileUri)) ||
      (state.geminiMimeType !== undefined && !/^video\/[a-z0-9.+-]+$/i.test(state.geminiMimeType)) ||
      (state.captionZ !== undefined && (typeof state.captionZ !== "string" || state.captionZ.length > MAX_COMPRESSED_SEGMENT_CHARS || !/^[A-Za-z0-9_-]+$/.test(state.captionZ))) ||
      !Array.isArray(state.segments) || state.segments.length < 1 || state.segments.length > MAX_SEGMENTS ||
      state.segments.some((s) => !Number.isInteger(s.startSeconds) || s.startSeconds < 0 ||
        (s.endSeconds !== null && (!Number.isInteger(s.endSeconds) || s.endSeconds <= s.startSeconds)) ||
        !Number.isInteger(s.modelIndex) || s.modelIndex < 0 || s.modelIndex >= MODELS.length ||
        !Number.isInteger(s.attempts) || s.attempts < 0 || s.attempts > 20 ||
        (s.interactionId !== null && !/^v1_[a-zA-Z0-9_-]+$/.test(s.interactionId)) ||
        (s.submissionUnknown !== undefined && (typeof s.submissionUnknown !== "boolean" || (s.submissionUnknown && (s.interactionId !== null || s.attempts < 1)))) ||
        (s.transcriptZ !== undefined && (typeof s.transcriptZ !== "string" || s.transcriptZ.length > MAX_COMPRESSED_SEGMENT_CHARS || !/^[A-Za-z0-9_-]+$/.test(s.transcriptZ))) ||
        (s.read429Count !== undefined && (!Number.isInteger(s.read429Count) || s.read429Count < 0 || s.read429Count > 20)) ||
        (s.lastReadError !== undefined && (typeof s.lastReadError !== "string" || s.lastReadError.length > 500)) ||
        (s.lastPostError !== undefined && (typeof s.lastPostError !== "string" || s.lastPostError.length > 500)) ||
        (s.lastProviderStatus !== undefined && (typeof s.lastProviderStatus !== "string" || s.lastProviderStatus.length > 80)) ||
        (s.lastHttpStatus !== undefined && (!Number.isInteger(s.lastHttpStatus) || s.lastHttpStatus < 100 || s.lastHttpStatus > 599)) ||
        (s.lastCheckedAt !== undefined && (!Number.isFinite(s.lastCheckedAt) || s.lastCheckedAt < 0 || s.lastCheckedAt > state.createdAt + TOKEN_VALID_MS)) ||
        (s.lastRetryAfterMs !== undefined && (!Number.isFinite(s.lastRetryAfterMs) || s.lastRetryAfterMs < 0 || !Number.isSafeInteger(s.lastRetryAfterMs))) ||
        (s.cooldownSkipped !== undefined && typeof s.cooldownSkipped !== "boolean") ||
        (s.nextStatusCheckAt !== undefined && (!Number.isFinite(s.nextStatusCheckAt) || s.nextStatusCheckAt < 0 || !Number.isSafeInteger(s.nextStatusCheckAt))))) {
    throw new Error("Malformed or expired transcription job token.");
  }
  return state;
}
function isRetryableStatus(code: number): boolean {
  return [408, 429, 500, 502, 503, 504].includes(code);
}
function isRetryableError(message: string): boolean {
  return /\b(429|500|502|503|504|UNAVAILABLE|RESOURCE_EXHAUSTED|DEADLINE_EXCEEDED|INTERNAL|overloaded|high demand|rate limit|timeout|timed out)\b/i.test(message);
}
function validRetryDelay(ms: number): number | null {
  // Preserve provider minimums without allowing timestamp/timer overflow.
  return Number.isFinite(ms) && ms >= 0 && ms <= Number.MAX_SAFE_INTEGER - Date.now()
    ? Math.ceil(ms) : null;
}
async function waitForRetry(ms: number): Promise<void> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    await new Promise(resolve => setTimeout(resolve, Math.min(2_147_483_647, until - Date.now())));
  }
}
function parseRetryAfter(headers: Headers): number | null {
  const raw = headers.get("Retry-After");
  if (!raw) return null;
  const n = Number(raw);
  if (Number.isFinite(n) && n >= 0) return validRetryDelay(n * 1000);
  const date = Date.parse(raw);
  return Number.isFinite(date) ? validRetryDelay(Math.max(0, date - Date.now())) : null;
}
function parseRetryFromMessage(value: unknown): number | null {
  const text = String(value ?? "");
  const match = /\b(?:retry\s+(?:after|in)|wait)\s+(\d+(?:\.\d+)?)\s*(seconds?|secs?|s|minutes?|mins?|m)\b/i.exec(text);
  if (!match) return null;
  const n = Number(match[1]);
  if (!Number.isFinite(n) || n < 0) return null;
  return validRetryDelay(n * (match[2].toLowerCase().startsWith("m") ? 60_000 : 1000));
}
function safeMessage(value: unknown): string {
  return String(value ?? "Unknown Gemini error").replace(/AIza[\w-]+/g, "[REDACTED_KEY]").slice(0, 500);
}
async function requestGemini(
  url: string,
  method: "GET" | "POST",
  body?: unknown,
): Promise<Record<string, unknown>> {
  const apiKey = getApiKey();
  let lastError: Error | null = null;
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    const controller = new AbortController();
    const deadline = setTimeout(() => controller.abort(), 18_000);
    try {
      const response = await fetch(url, {
        method,
        headers: {
          "x-goog-api-key": apiKey,
          "Api-Revision": API_REVISION,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: controller.signal,
        cache: "no-store",
      });
      const json = (await response.json().catch(() => ({}))) as Record<string, unknown>;
      if (response.ok) return json;
      const detail = (json.error && typeof json.error === "object"
        ? (json.error as {message?: unknown}).message : undefined) ?? `HTTP ${response.status}`;
      const retryAfterMs = parseRetryAfter(response.headers) ?? parseRetryFromMessage(detail);
      lastError = Object.assign(new Error(`HTTP ${response.status}: ${safeMessage(detail)}`), {
        httpStatus: response.status, retryAfterMs,
      });
      // 408/5xx may be emitted after a server accepted the POST.
      if (method === "POST" && [408, 500, 502, 503, 504].includes(response.status)) {
        throw new AmbiguousSubmissionError(lastError.message);
      }
      if (!isRetryableStatus(response.status) || attempt === RETRY_DELAYS_MS.length) break;
      // Polling too early during a free-tier minute-wide 429 window only makes it worse.
      // Keep the interaction ID and let the caller poll again after the indicated delay.
      if (response.status === 429 && (method === "GET" || (retryAfterMs ?? 0) > 2_000)) break;
      await waitForRetry(retryAfterMs ?? RETRY_DELAYS_MS[attempt]);
    } catch (err) {
      if (err instanceof AmbiguousSubmissionError) throw err;
      lastError = new Error(`Gemini ${method} request failed: ${safeMessage(err instanceof Error ? err.message : err)}`);
      if (method === "POST") throw new AmbiguousSubmissionError(lastError.message);
      if (attempt === RETRY_DELAYS_MS.length) break;
      await new Promise((resolve) => setTimeout(resolve, RETRY_DELAYS_MS[attempt]));
    } finally {
      clearTimeout(deadline);
    }
  }
  throw lastError ?? new Error("Gemini request failed.");
}

function timecode(seconds: number): string {
  const h = Math.floor(seconds / 3600).toString().padStart(2, "0");
  const m = Math.floor((seconds % 3600) / 60).toString().padStart(2, "0");
  const s = Math.floor(seconds % 60).toString().padStart(2, "0");
  return `${h}:${m}:${s}`;
}
function segmentPrompt(segment: SegmentState, language: string): string {
  const start = timecode(segment.startSeconds);
  const end = segment.endSeconds === null ? "영상의 끝" : timecode(segment.endSeconds);
  return `이 공개 YouTube 영상의 ${start}부터 ${end}까지 실제 들리는 음성만 빠짐없이 전사하십시오.
언어: 원어 그대로(선호 ${language}). 요약·의역·번역·추측·외부 지식 삽입 금지.
인트로·광고·반복 발화·감탄사·질문·답변 모두 포함하고, 들리지 않으면 [불명확]으로 표시하십시오.
모든 발화는 원본 전체 영상 기준 [HH:MM:SS] 화자: 발화 형식으로 작성하십시오.
이 구간 외의 내용이나 미리보기·생략 안내를 출력하지 마십시오.
구간 끝에 있는 발화도 빠뜨리지 마십시오. 실제 발화만 출력하십시오.`;
}
async function createInteraction(job: JobState, segment: SegmentState): Promise<void> {
  const canonicalUrl = `https://www.youtube.com/watch?v=${job.videoId}`;
  // Gemini Interactions accepts clipping only for Files API URIs. Real YouTube URLs
  // return HTTP 400 (Invalid input at input[0].processing) for clip objects.
  // On YouTube, submit the original video asynchronously and scope the TRANSCRIPT
  // response to the requested time window in the prompt. Never label this as a
  // physically clipped video; the whole source is still processed by Google.
  const video: Record<string, unknown> = job.geminiFileUri
    ? { type: "video", uri: job.geminiFileUri, mime_type: job.geminiMimeType ?? "video/mp4" }
    : { type: "video", uri: canonicalUrl };
  if (segment.endSeconds !== null) {
    video.processing = job.geminiFileUri
      ? {type:"static",start_offset:`${segment.startSeconds}s`,end_offset:`${segment.endSeconds}s`}
      : "static";
  }
  const model = MODELS[segment.modelIndex];
  segment.attempts++;
  try {
    const response = await requestGemini(GEMINI_ENDPOINT, "POST", {
      model,
      background: true,
      input: [ video, { type: "text", text: segmentPrompt(segment, job.language) } ],
    });
    if (typeof response.id !== "string" || !/^v1_[a-zA-Z0-9_-]+$/.test(response.id)) {
      throw new AmbiguousSubmissionError(`Gemini returned no valid interaction ID (${safeMessage(response.status)}).`);
    }
    segment.interactionId = response.id;
    if (typeof response.status === "string") segment.lastProviderStatus = response.status;
    delete segment.submissionUnknown;
    delete segment.lastError;
    delete segment.lastPostError;
    delete segment.lastReadError;
    delete segment.cooldownSkipped;
    delete segment.nextStatusCheckAt;
    delete segment.lastRetryAfterMs;
    segment.lastHttpStatus=200;
  } catch (error) {
    if (error instanceof AmbiguousSubmissionError) segment.submissionUnknown=true;
    segment.lastError = safeMessage(error instanceof Error ? error.message : error);
    const rejected=error as Error & {httpStatus?:number;retryAfterMs?:number|null};
    if(!(error instanceof AmbiguousSubmissionError)&&rejected.httpStatus!==undefined){
      segment.lastPostError=segment.lastError;segment.lastHttpStatus=rejected.httpStatus;
      if(rejected.retryAfterMs!=null)segment.lastRetryAfterMs=rejected.retryAfterMs;
      if(rejected.httpStatus===429)segment.nextStatusCheckAt=Date.now()+Math.max(30_000,rejected.retryAfterMs??0);
    }
  }
}

/** Optional metadata probe. Exact clipping is only enabled when duration is known. */
async function discoverDuration(videoId: string): Promise<number | null> {
  const key = process.env.YOUTUBE_DATA_API_KEY?.trim();
  if (key) {
    try {
      const url = `https://www.googleapis.com/youtube/v3/videos?part=contentDetails&id=${videoId}&key=${encodeURIComponent(key)}`;
      const c = new AbortController();
      const t = setTimeout(() => c.abort(), 4_000);
      try {
        const r = await fetch(url, {signal:c.signal,cache:"no-store"});
        if (r.ok) {
          const data = await r.json() as {items?:Array<{contentDetails?:{duration?:string}}>};
          const duration = data.items?.[0]?.contentDetails?.duration;
          if (duration) {
            const m = /^P(?:([0-9]+)D)?T?(?:([0-9]+)H)?(?:([0-9]+)M)?(?:([0-9]+)S)?$/.exec(duration);
            if (m) {
              const secs = Number(m[1]||0)*86400+Number(m[2]||0)*3600+Number(m[3]||0)*60+Number(m[4]||0);
              if (secs>0 && secs<=86400) return secs;
            }
          }
        }
      } finally {clearTimeout(t);}
    } catch { /* Use remaining sources. */ }
  }
  // Only use YouTube's own player metadata; do not infer the length from an LLM.
  try {
    const controller = new AbortController();
    const timeout = setTimeout(()=>controller.abort(),4000);
    try {
      const r = await fetch(`https://www.youtube.com/watch?v=${videoId}`, {signal:controller.signal,cache:"no-store"});
      if(!r.ok) return null;
      const html = await r.text();
      const m = /"lengthSeconds"\s*:\s*"(\d{1,6})"/.exec(html);
      const duration = Number(m?.[1]);
      return Number.isInteger(duration) && duration>0 && duration<=86400 ? duration : null;
    } finally {clearTimeout(timeout);}
  } catch {return null;}
}

function createSegments(duration: number | null, chunkSeconds: number, hasPhysicalClipSource: boolean): SegmentState[] {
  // YouTube URI does not support native clip offsets. Do not submit the same
  // complete YouTube video separately for each prompt-scoped interval.
  if (!hasPhysicalClipSource || duration === null) return [{startSeconds: 0,endSeconds: null,interactionId: null,modelIndex: 0,attempts: 0}];
  const count = Math.ceil(duration / chunkSeconds);
  if (count > MAX_SEGMENTS) throw new Error(`Video duration requires ${count} segments; maximum ${MAX_SEGMENTS}. Increase chunkSeconds.`);
  return Array.from({length: count},(_,idx)=>({
    startSeconds: Math.max(0,idx*chunkSeconds-(idx===0?0:CLIP_OVERLAP_SECONDS)),
    endSeconds: Math.min(duration,(idx+1)*chunkSeconds),
    interactionId:null,
    modelIndex:0,
    attempts:0,
  }));
}
/** Project legacy stored results without changing provider identity or signed state. */
export function normalizeTranscriptionJobResult(result: TranscriptionJobResult): TranscriptionJobResult {
  const segments = result.segments.map(segment => {
    let status = segment.status;
    if (status === "failed" && ["cancelled", "incomplete"].includes(segment.lastProviderStatus ?? "")) {
      status = segment.lastProviderStatus as JobStatus;
    } else if (status !== "completed" && !["failed", "cancelled", "incomplete"].includes(status)) {
      if (segment.lastReadError || segment.lastPostError || segment.cooldownSkipped) {
        status = segment.lastHttpStatus === 429 || /^HTTP 429:/.test(segment.lastReadError ?? segment.lastPostError ?? segment.error ?? "")
          ? "rate_limited" : "blocked";
      } else if (["requires_action", "failed", "cancelled", "incomplete"].includes(segment.lastProviderStatus ?? "")) {
        status = segment.lastProviderStatus as JobStatus;
      } else if (status === "queued" && segment.error) {
        status = "blocked";
      }
    }
    return {...segment, status};
  });
  const priority: JobStatus[] = ["failed", "cancelled", "incomplete", "blocked", "rate_limited", "requires_action", "in_progress", "queued"];
  const status: JobStatus = result.status === "failed" && !segments.some(s => ["cancelled", "incomplete"].includes(s.status)) ? "failed"
    : segments.every(s => s.status === "completed") ? "completed"
    : priority.find(value => segments.some(s => s.status === value)) ?? "blocked";
  const shouldPoll = status === "in_progress" || status === "queued";
  const interrupted = segments.filter(s => ["rate_limited", "blocked"].includes(s.status));
  const retryable = status === "rate_limited" || (status === "blocked" && interrupted.length > 0 &&
    interrupted.every(s => Boolean(s.lastReadError || s.lastPostError || s.cooldownSkipped) &&
      (s.lastHttpStatus === undefined || isRetryableStatus(s.lastHttpStatus))));
  const deadlines = interrupted.map(s => s.nextStatusCheckAt).filter((v): v is number => typeof v === "number");
  const nextStatusCheckAt = retryable && deadlines.length ? Math.max(...deadlines) : undefined;
  const providerStates = [...new Set(segments.map(s => s.lastReadError || s.lastPostError ? "unknown" : s.lastProviderStatus ??
    (s.status === "completed" ? "completed" : "unknown")))];
  const providerStatus = providerStates.length === 1 ? providerStates[0] : "mixed";
  const detail = segments.filter(s => !["completed", "in_progress", "queued"].includes(s.status))
    .map(s => s.lastReadError || s.lastPostError || s.error || `Provider status: ${s.lastProviderStatus ?? s.status}`).join(" | ");
  const reason = status === "completed" ? "All transcript segments completed."
    : shouldPoll ? `Provider status: ${status}.`
    : detail || result.error || `Transcription status: ${status}.`;
  const out = {...result, segments, status, providerStatus, reason, retryable, shouldPoll, nextStatusCheckAt};
  if (!shouldPoll && status !== "completed") out.error = reason.slice(0, 1000);
  else delete out.error;
  if (status !== "completed") {
    delete out.transcript; delete out.characterCount; delete out.lineCount; delete out.first30Lines;
  }
  return out;
}

function makeView(job: JobState, statuses: Array<JobStatus | "queued" | "requires_action">, texts?: string[]): TranscriptionJobResult {
  const total = job.segments.length;
  const completed = statuses.filter(x=>x==="completed").length;
  const hasError = statuses.includes("failed");
  const status: JobStatus = hasError ? "failed" : completed===total ? "completed" : "in_progress";
  const out: TranscriptionJobResult = {
    status, jobToken: encodeJob(job),videoId:job.videoId,
    source:job.captionZ?"yt-dlp":"gemini",
    canonicalUrl:`https://www.youtube.com/watch?v=${job.videoId}`,
    segmentation:job.captionZ?"captions":job.geminiFileUri&&job.durationSeconds!==null?"file-clips":"whole-video",
    durationSeconds:job.durationSeconds,completedSegments:completed,totalSegments:total,
    segments:job.segments.map((s,i)=>({
      startSeconds:s.startSeconds,endSeconds:s.endSeconds,
      modelIndex:s.modelIndex,model:MODELS[s.modelIndex],attempts:s.attempts,
      status:statuses[i],...(s.lastError?{error:s.lastError}:{}),
      ...(s.lastReadError?{lastReadError:s.lastReadError}:{}),
      ...(s.lastPostError?{lastPostError:s.lastPostError}:{}),
      ...(s.lastProviderStatus?{lastProviderStatus:s.lastProviderStatus}:{}),
      ...(s.lastHttpStatus!==undefined?{lastHttpStatus:s.lastHttpStatus}:{}),
      ...(s.lastCheckedAt!==undefined?{lastCheckedAt:s.lastCheckedAt}:{}),
      ...(s.lastRetryAfterMs!==undefined?{lastRetryAfterMs:s.lastRetryAfterMs}:{}),
      ...(s.nextStatusCheckAt!==undefined?{nextStatusCheckAt:s.nextStatusCheckAt}:{}),
      ...(s.cooldownSkipped?{cooldownSkipped:true}:{})
    }))
  };
  const warnings=job.segments.flatMap((s,i)=>s.cooldownSkipped
    ? [`segment ${i+1}: ${s.interactionId ? "GET" : "POST retry"} skipped during cooldown`]
    : s.lastReadError ? [`segment ${i+1}: ${s.lastReadError}`] : []);
  if(warnings.length) out.readWarning=warnings.join(" | ").slice(0,1000);
  if(status==="completed" && texts) {
    // Preserve every segment, including possible overlap speech; never silently drop content.
    const transcript=texts.map(s=>s.trim()).join("\n").trim();
    const lines=transcript.split("\n");
    out.transcript=transcript;
    out.characterCount=transcript.length;
    out.lineCount=lines.length;
    out.first30Lines=lines.slice(0,30);
  }
  if(status==="failed") out.error="One or more segments could not be transcribed; incomplete video text is not published as a full transcript.";
  return normalizeTranscriptionJobResult(out);
}

export async function startGeminiTranscriptionJob(args: {
  url:string;
  language?:string;
  durationSeconds?:number;
  chunkSeconds?:number;
  geminiFileUri?:string;
  geminiMimeType?:string;
}, hooks?:{beforeInitialPost?:()=>Promise<void>}):Promise<TranscriptionJobResult> {
  const videoId=extractYouTubeVideoId(args.url);
  const language=args.language?.trim()||"ko-KR";
  const chunkSeconds=args.chunkSeconds??240;
  if(!Number.isInteger(chunkSeconds)||chunkSeconds<60||chunkSeconds>900) throw new Error("chunkSeconds must be 60–900.");
  if(args.durationSeconds!==undefined && (!Number.isInteger(args.durationSeconds)||args.durationSeconds<1||args.durationSeconds>86400)) {
    throw new Error("durationSeconds must be an integer between 1 and 86400.");
  }
  if(args.geminiFileUri!==undefined && !/^https:\/\/generativelanguage\.googleapis\.com\/v1beta\/files\/[a-zA-Z0-9_-]+$/.test(args.geminiFileUri)){
    throw new Error("geminiFileUri must be a valid Gemini Files API URI.");
  }
  if(args.geminiMimeType!==undefined && !/^video\/[a-z0-9.+-]+$/i.test(args.geminiMimeType)){
    throw new Error("geminiMimeType must be a video MIME type.");
  }
  // The single start path tries captions, then durable Gemini in this same call.
  // Private/unavailable video restrictions are not bypassed. Files API input is clipped media.
  if (!args.geminiFileUri) {
    try {
      const captions=await getYouTubeCaptionsWithYtDlp(videoId,language,{budgetMs:120_000});
      const captionJob:JobState={version:1,videoId,language,createdAt:Date.now(),durationSeconds:args.durationSeconds??null,
        chunkSeconds,captionZ:compressTranscript(captions.transcript),
        segments:[{startSeconds:0,endSeconds:null,interactionId:null,modelIndex:0,attempts:0}]};
      return makeView(captionJob,["completed"],[captions.transcript]);
    } catch (error) {
      if (!(error instanceof YtDlpCaptionError) || error.reason === "video_unavailable") throw error;
    }
  }
  getApiKey();
  const duration=args.durationSeconds??await discoverDuration(videoId);
  const job:JobState={version:1,videoId,language,createdAt:Date.now(),durationSeconds:duration,chunkSeconds,
    ...(args.geminiFileUri?{geminiFileUri:args.geminiFileUri,geminiMimeType:args.geminiMimeType??"video/mp4"}:{}),
    segments:createSegments(duration,chunkSeconds,Boolean(args.geminiFileUri))};
  if(hooks?.beforeInitialPost)await hooks.beforeInitialPost();
  // Eagerly start all clips with bounded concurrency; later polling only reads them.
  let cursor=0;
  await Promise.all(Array.from({length:Math.min(MAX_SIMULTANEOUS_STARTS,job.segments.length)},async()=>{
    while(cursor<job.segments.length){const idx=cursor++;await createInteraction(job,job.segments[idx]);}
  }));
  const statuses: JobStatus[]=job.segments.map(s=>s.interactionId
    ? s.lastProviderStatus==="in_progress"?"in_progress":s.lastProviderStatus==="requires_action"?"requires_action":"queued"
    : s.submissionUnknown?"failed":"queued");
  return makeView(job,statuses);
}

function extractOutput(interaction:Record<string,unknown>):string {
  if(typeof interaction.output_text==="string") return interaction.output_text.trim();
  if(Array.isArray(interaction.steps)){
    return interaction.steps.filter(s=>s && typeof s==="object" && (s as {type?:string}).type==="model_output")
      .flatMap(s=>Array.isArray((s as {content?:unknown}).content)?(s as {content:unknown[]}).content:[])
      .filter(c=>c && typeof c==="object" && (c as {type?:string}).type==="text")
      .map(c=>(c as {text?:unknown}).text)
      .filter((t):t is string=>typeof t==="string").join("\n").trim();
  }
  return "";
}
function providerFailure(interaction:Record<string,unknown>):string {
  const e=interaction.error??interaction.errors??interaction.status;
  return safeMessage(typeof e==="string" ? e : JSON.stringify(e));
}
export async function getGeminiTranscriptionJob(
  jobToken:string,
  hooks?:{beforeNewPost?:()=>Promise<void>;afterNewPost?:(token:string)=>Promise<void>},
  options?:{readOnly?:boolean}
):Promise<TranscriptionJobResult>{
  const readOnly=options?.readOnly===true;
  const job=decodeJob(jobToken);
  if(job.captionZ) return makeView(job,["completed"],[restoreTranscript(job.captionZ)]);
  getApiKey();
  const statuses:Array<JobStatus|"queued"|"requires_action">=Array.from({length:job.segments.length},()=>"queued");
  const texts:string[]=Array.from({length:job.segments.length},()=>"");
  // Persist a retry POST reservation and its resulting ID before any later POST.
  // Durable retries are serial; normal status GETs remain safely repeatable.
  const retryPost=async(segment:SegmentState)=>{
    if(readOnly) throw new Error("GET-only diagnosis prohibits Gemini POST.");
    if(hooks?.beforeNewPost) await hooks.beforeNewPost();
    await createInteraction(job,segment);
    if(hooks?.afterNewPost) await hooks.afterNewPost(encodeJob(job));
  };
  let cursor=0;
  await Promise.all(Array.from({length:Math.min(hooks?1:MAX_SIMULTANEOUS_STARTS,job.segments.length)},async()=>{
    while(cursor<job.segments.length){
      const i=cursor++;
      const segment=job.segments[i];
      if(segment.transcriptZ){
        texts[i]=restoreTranscript(segment.transcriptZ);
        statuses[i]="completed";
        continue;
      }
      if(segment.nextStatusCheckAt && Date.now() < segment.nextStatusCheckAt){
        segment.cooldownSkipped=true;
        statuses[i]="in_progress";
        continue;
      }
      if(!segment.interactionId){
        if(readOnly){
          statuses[i]=segment.submissionUnknown?"failed":"queued";
          continue;
        }
        if(segment.submissionUnknown){
          // No interaction ID is available; retrying may duplicate a charged job.
          statuses[i]="failed";
          continue;
        }
        if(segment.lastPostError && segment.lastHttpStatus!==undefined && !isRetryableStatus(segment.lastHttpStatus)){
          statuses[i]="blocked";continue;
        }
        if(segment.attempts<3){
          // A previous initiation failed; retry when the client presents its latest token.
          if(segment.attempts>0 && segment.modelIndex<MODELS.length-1) segment.modelIndex++;
          await retryPost(segment);
        }
        statuses[i]=segment.interactionId?"in_progress":segment.attempts<3?"queued":"failed";
        continue;
      }
      try{
        const payload=await requestGemini(`${GEMINI_ENDPOINT}/${encodeURIComponent(segment.interactionId)}`,"GET");
        const state=String(payload.status||"");
        segment.lastProviderStatus=state;
        segment.lastHttpStatus=200;
        segment.lastCheckedAt=Date.now();
        delete segment.read429Count;
        delete segment.nextStatusCheckAt;
        delete segment.lastReadError;
        delete segment.lastRetryAfterMs;
        delete segment.cooldownSkipped;
        if(state==="completed"){
          const txt=extractOutput(payload);
          if(txt){
            segment.transcriptZ=compressTranscript(txt);
            statuses[i]="completed";
            texts[i]=txt;
            delete segment.lastError;
            delete segment.read429Count;
            delete segment.nextStatusCheckAt;
          }
          else{statuses[i]="failed";segment.lastError="Completed interaction contained no transcript text.";}
        }else if(state==="in_progress"||state==="queued"||state==="requires_action"){
          statuses[i]=state;
          delete segment.lastError;
          delete segment.read429Count;
          delete segment.nextStatusCheckAt;
        }else if(state==="failed"||state==="cancelled"||state==="incomplete"){
          const message=providerFailure(payload);
          segment.lastError=message;
          // A confirmed provider stop must be observable; status polling never hides it behind a new POST.
          statuses[i]=state;

        }else {statuses[i]="failed";segment.lastError=`Unexpected interaction status: ${safeMessage(state)}`;}
      }catch(err){
        const message=safeMessage(err instanceof Error?err.message:err);
        const readError=err as Error & {httpStatus?:number;retryAfterMs?:number|null};
        segment.lastCheckedAt=Date.now();
        segment.lastReadError=message;
        // This attempt did not observe a provider state. Do not attach an old
        // successful status to the new lastCheckedAt timestamp.
        delete segment.lastProviderStatus;
        segment.cooldownSkipped=false;
        if(readError.httpStatus!==undefined) segment.lastHttpStatus=readError.httpStatus;
        else delete segment.lastHttpStatus;
        if(readError.retryAfterMs!==undefined && readError.retryAfterMs!==null)
          segment.lastRetryAfterMs=readError.retryAfterMs;
        else delete segment.lastRetryAfterMs;
        const isQuotaRead429=readError.httpStatus===429 || /^HTTP 429:/.test(message);
        if(isQuotaRead429){
          // A 429 GET never proves remote failure. Keep the active interaction ID,
          // retry only after the provider cooldown, and do not submit duplicates.
          const already429=/^HTTP 429:/.test(segment.lastError ?? "");
          segment.read429Count=Math.min(20,(segment.read429Count ?? (already429?1:0))+1);
          const providerDelay=readError.retryAfterMs ?? parseRetryFromMessage(message) ?? 0;
          const backoff=Math.min(30 * 60_000,30_000 * 2 ** (segment.read429Count-1));
          const delay=Math.max(providerDelay,backoff);
          const now=Date.now();
          const jitter=Math.min(Math.floor(Math.random()*backoff*0.1),
            Math.max(0,Number.MAX_SAFE_INTEGER-now-delay));
          segment.nextStatusCheckAt=now+delay+jitter;
        }
        segment.lastError=message;
        // Other status-read timeouts likewise do not prove that the remote job failed.
        if (!isQuotaRead429 && (readError.httpStatus === undefined || isRetryableStatus(readError.httpStatus))) {
          segment.nextStatusCheckAt = Date.now() + Math.max(30_000, readError.retryAfterMs ?? 0);
        } else if (!isQuotaRead429) delete segment.nextStatusCheckAt;
        statuses[i]=isQuotaRead429?"rate_limited":"blocked";
      }
    }
  }));
  return makeView(job,statuses,texts);
}

/** Reads existing interactions only. Provider POST is unreachable on this path. */
export function getGeminiTranscriptionJobReadOnly(jobToken:string):Promise<TranscriptionJobResult> {
  return getGeminiTranscriptionJob(jobToken,undefined,{readOnly:true});
}
