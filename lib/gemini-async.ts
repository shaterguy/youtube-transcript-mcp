/**
 * Durable, stateless Gemini Interactions API transcription jobs.
 * Vercel/Termux share this implementation; the client retains a signed progress token.
 * No in-process background promises or ephemeral server-side job map is used.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { extractYouTubeVideoId } from "./youtube";

const GEMINI_ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/interactions";
const API_REVISION = "2026-05-20";
const MODELS = ["gemini-3.8-flash", "gemini-3.7-flash", "gemini-3.5-flash-lite"] as const;
const TOKEN_VALID_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_SEGMENTS = 24;
const MAX_SIMULTANEOUS_STARTS = 2;
const CLIP_OVERLAP_SECONDS = 3;
const RETRY_DELAYS_MS = [1000, 3000, 7000];

export type JobStatus = "in_progress" | "completed" | "failed";
export type SegmentState = {
  startSeconds: number;
  endSeconds: number | null;
  interactionId: string | null;
  modelIndex: number;
  attempts: number;
  lastError?: string;
};
type JobState = {
  version: 1;
  videoId: string;
  language: string;
  createdAt: number;
  durationSeconds: number | null;
  chunkSeconds: number;
  segments: SegmentState[];
};
export type TranscriptionJobResult = {
  status: JobStatus;
  jobToken: string;
  videoId: string;
  canonicalUrl: string;
  segmentation: "clipped" | "whole-video";
  durationSeconds: number | null;
  completedSegments: number;
  totalSegments: number;
  segments: Array<Pick<SegmentState, "startSeconds" | "endSeconds" | "modelIndex" | "attempts"> & { status: JobStatus | "queued"; model: string; error?: string }>;
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
  return `${body}.${sign(body)}`;
}
function decodeJob(token: string): JobState {
  if (token.length > 24_000 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)) {
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
      !Array.isArray(state.segments) || state.segments.length < 1 || state.segments.length > MAX_SEGMENTS ||
      state.segments.some((s) => !Number.isInteger(s.startSeconds) || s.startSeconds < 0 ||
        (s.endSeconds !== null && (!Number.isInteger(s.endSeconds) || s.endSeconds <= s.startSeconds)) ||
        !Number.isInteger(s.modelIndex) || s.modelIndex < 0 || s.modelIndex >= MODELS.length ||
        !Number.isInteger(s.attempts) || s.attempts < 0 || s.attempts > 20 ||
        (s.interactionId !== null && !/^v1_[a-zA-Z0-9_-]+$/.test(s.interactionId)))) {
    throw new Error("Malformed or expired transcription job token.");
  }
  return state;
}
function isRetryableStatus(code: number): boolean {
  return [408, 429, 500, 502, 503, 504].includes(code);
}
function isRetryableError(message: string): boolean {
  return /\b(429|500|502|503|504|UNAVAILABLE|RESOURCE_EXHAUSTED|DEADLINE_EXCEEDED|overloaded|high demand|rate limit|timeout|timed out)\b/i.test(message);
}
function parseRetryAfter(headers: Headers): number | null {
  const raw = headers.get("Retry-After");
  if (!raw) return null;
  const n = Number(raw);
  if (Number.isFinite(n) && n >= 0) return Math.min(15_000, n * 1000);
  const date = Date.parse(raw);
  return Number.isFinite(date) ? Math.max(0, Math.min(15_000, date - Date.now())) : null;
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
      lastError = new Error(`HTTP ${response.status}: ${safeMessage(detail)}`);
      if (!isRetryableStatus(response.status) || attempt === RETRY_DELAYS_MS.length) break;
      const retryAfter = parseRetryAfter(response.headers);
      await new Promise((resolve) => setTimeout(resolve, retryAfter ?? RETRY_DELAYS_MS[attempt]));
    } catch (err) {
      lastError = new Error(`Gemini ${method} request failed: ${safeMessage(err instanceof Error ? err.message : err)}`);
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
  const video: Record<string, unknown> = { type: "video", uri: canonicalUrl };
  if (segment.endSeconds !== null) {
    video.processing = {
      type: "static",
      start_offset: segment.startSeconds,
      end_offset: segment.endSeconds,
    };
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
      throw new Error(`Gemini returned no valid interaction ID (${safeMessage(response.status)}).`);
    }
    segment.interactionId = response.id;
    delete segment.lastError;
  } catch (error) {
    segment.lastError = safeMessage(error instanceof Error ? error.message : error);
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

function createSegments(duration: number | null, chunkSeconds: number): SegmentState[] {
  if (duration === null) return [{startSeconds: 0,endSeconds: null,interactionId: null,modelIndex: 0,attempts: 0}];
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
function makeView(job: JobState, statuses: Array<JobStatus | "queued">, texts?: string[]): TranscriptionJobResult {
  const total = job.segments.length;
  const completed = statuses.filter(x=>x==="completed").length;
  const hasError = statuses.includes("failed");
  const status: JobStatus = hasError ? "failed" : completed===total ? "completed" : "in_progress";
  const out: TranscriptionJobResult = {
    status, jobToken: encodeJob(job),videoId:job.videoId,
    canonicalUrl:`https://www.youtube.com/watch?v=${job.videoId}`,
    segmentation:job.durationSeconds===null?"whole-video":"clipped",
    durationSeconds:job.durationSeconds,completedSegments:completed,totalSegments:total,
    segments:job.segments.map((s,i)=>({
      startSeconds:s.startSeconds,endSeconds:s.endSeconds,
      modelIndex:s.modelIndex,model:MODELS[s.modelIndex],attempts:s.attempts,
      status:statuses[i],...(s.lastError?{error:s.lastError}:{})
    }))
  };
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
  return out;
}

export async function startGeminiTranscriptionJob(args: {
  url:string;
  language?:string;
  durationSeconds?:number;
  chunkSeconds?:number;
}):Promise<TranscriptionJobResult> {
  getApiKey();
  const videoId=extractYouTubeVideoId(args.url);
  const language=args.language?.trim()||"ko-KR";
  const chunkSeconds=args.chunkSeconds??240;
  if(!Number.isInteger(chunkSeconds)||chunkSeconds<60||chunkSeconds>900) throw new Error("chunkSeconds must be 60–900.");
  if(args.durationSeconds!==undefined && (!Number.isInteger(args.durationSeconds)||args.durationSeconds<1||args.durationSeconds>86400)) {
    throw new Error("durationSeconds must be an integer between 1 and 86400.");
  }
  const duration=args.durationSeconds??await discoverDuration(videoId);
  const job:JobState={version:1,videoId,language,createdAt:Date.now(),durationSeconds:duration,chunkSeconds,segments:createSegments(duration,chunkSeconds)};
  // Eagerly start all clips with bounded concurrency; later polling only reads them.
  let cursor=0;
  await Promise.all(Array.from({length:Math.min(MAX_SIMULTANEOUS_STARTS,job.segments.length)},async()=>{
    while(cursor<job.segments.length){const idx=cursor++;await createInteraction(job,job.segments[idx]);}
  }));
  const statuses=job.segments.map(s=>s.interactionId?"in_progress" as const:"queued" as const);
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
export async function getGeminiTranscriptionJob(jobToken:string):Promise<TranscriptionJobResult>{
  const job=decodeJob(jobToken);
  getApiKey();
  const statuses:Array<JobStatus|"queued">=Array.from({length:job.segments.length},()=>"queued");
  const texts:string[]=Array.from({length:job.segments.length},()=>"");
  let cursor=0;
  await Promise.all(Array.from({length:Math.min(MAX_SIMULTANEOUS_STARTS,job.segments.length)},async()=>{
    while(cursor<job.segments.length){
      const i=cursor++;
      const segment=job.segments[i];
      if(!segment.interactionId){
        if(segment.attempts<3){
          // A previous initiation failed; retry when the client presents its latest token.
          if(segment.attempts>0 && segment.modelIndex<MODELS.length-1) segment.modelIndex++;
          await createInteraction(job,segment);
        }
        statuses[i]=segment.interactionId?"in_progress":"failed";
        continue;
      }
      try{
        const payload=await requestGemini(`${GEMINI_ENDPOINT}/${encodeURIComponent(segment.interactionId)}`,"GET");
        const state=String(payload.status||"");
        if(state==="completed"){
          const txt=extractOutput(payload);
          if(txt){statuses[i]="completed";texts[i]=txt;delete segment.lastError;}
          else{statuses[i]="failed";segment.lastError="Completed interaction contained no transcript text.";}
        }else if(state==="in_progress"||state==="requires_action"){
          statuses[i]="in_progress";
        }else if(state==="failed"||state==="cancelled"||state==="incomplete"){
          const message=providerFailure(payload);
          segment.lastError=message;
          if(segment.attempts<3 && isRetryableError(message)){
            segment.modelIndex=Math.min(segment.modelIndex+1,MODELS.length-1);
            segment.interactionId=null;
            await createInteraction(job,segment);
            statuses[i]=segment.interactionId?"in_progress":"failed";
          } else statuses[i]="failed";
        }else {statuses[i]="failed";segment.lastError=`Unexpected interaction status: ${safeMessage(state)}`;}
      }catch(err){
        segment.lastError=safeMessage(err instanceof Error?err.message:err);
        // A status-read timeout is not proof that the remote interaction failed.
        statuses[i]="in_progress";
      }
    }
  }));
  return makeView(job,statuses,texts);
}
