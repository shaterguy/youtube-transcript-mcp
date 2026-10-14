/**
 * Durable transcription jobs: local atomic file CAS on Termux, Redis REST on cloud.
 * All writes are atomic compare-and-set. A Gemini POST is never replayed after
 * a worker disappears mid-submission, even if its interaction ID was lost.
 */
import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { extractYouTubeVideoId, isUsablePublicTranscript } from "./youtube";
import {
  getGeminiTranscriptionJob,
  normalizeTranscriptionJobResult,
  startGeminiTranscriptionJob,
  type TranscriptionJobResult,
} from "./gemini-async";

export type StartTranscriptionArgs = Parameters<typeof startGeminiTranscriptionJob>[0];

type Phase = "acquiring" | "starting" | "active" | "polling" | "submitting" | "completed" | "failed" | "unknown";
type StoredJob = {
  version: 2;
  phase: Phase;
  owner: string;
  createdAt: number;
  updatedAt: number;
  videoId: string;
  language: string;
  result?: TranscriptionJobResult;
  startArgs?: StartTranscriptionArgs;
  acquisitionClaimUntil?: number;
  error?: string;
};

// Redis expires 90 days after the last persisted write, not after plain reads.
// This retention is not a wall-clock timeout for an active provider interaction.
const REDIS_RETENTION_SECONDS = 90 * 24 * 3600;
// Exceeds a single Vercel function execution. Expiry quarantines a lost POST;
// never assumes it was rejected or creates a replacement interaction.
const UNCERTAIN_OWNER_AFTER_MS = 20 * 60_000;
const CAS_SCRIPT = `
local current = redis.call('GET', KEYS[1])
if current ~= ARGV[1] then return 0 end
redis.call('SET', KEYS[1], ARGV[2], 'EX', ARGV[3])
return 1
`;

type StoreConfig = { url: string; token: string; key: string; localDir?: string };
function getConfig(): StoreConfig | null {
  // The local TMCP must never depend on cloud Redis or additional credentials.
  // Persist beside the Termux service, outside the repository and deployment.
  const useLocal = process.env.YOUTUBE_TRANSCRIPT_JOB_BACKEND === "local" ||
    (process.env.YOUTUBE_TRANSCRIPT_JOB_BACKEND !== "redis" &&
     !(process.env.UPSTASH_REDIS_REST_URL || process.env.UPSTASH_REDIS_REST_TOKEN) &&
     (process.env.PREFIX || "").includes("/com.termux/"));
  if (useLocal) {
    const key = process.env.YOUTUBE_TRANSCRIPT_JOB_SIGNING_KEY?.trim() ||
      process.env.GEMINI_API_KEY?.trim();
    if (!key) throw new Error("A stable local Gemini/job signing key is required.");
    const localDir = process.env.YOUTUBE_TRANSCRIPT_JOB_DIR?.trim() ||
      path.join(os.homedir(), ".local", "state", "youtube-transcript-mcp", "jobs");
    return {url:"", token:"", key, localDir};
  }
  const url = process.env.UPSTASH_REDIS_REST_URL?.trim();
  const token = process.env.UPSTASH_REDIS_REST_TOKEN?.trim();
  const key = process.env.YOUTUBE_TRANSCRIPT_JOB_SIGNING_KEY?.trim();
  if (!url && !token) {
    if (process.env.YOUTUBE_TRANSCRIPT_REQUIRE_DURABLE_JOBS === "1") {
      throw new Error("Durable transcript job store is required but not configured.");
    }
    return null;
  }
  if (!url || !token || !key) {
    throw new Error("Durable transcript jobs require Redis URL, Redis token and a stable job signing key.");
  }
  let endpoint: URL;
  try { endpoint = new URL(url); }
  catch { throw new Error("Invalid Redis REST URL."); }
  if (endpoint.protocol !== "https:" || !endpoint.hostname.endsWith(".upstash.io") ||
      endpoint.username || endpoint.password || endpoint.search || endpoint.hash || endpoint.pathname !== "/") {
    throw new Error("Redis REST endpoint must be an HTTPS Upstash origin.");
  }
  return {url:endpoint.origin,token,key};
}

export function isDurableTranscriptStoreConfigured(): boolean {
  try { return Boolean(getConfig()); } catch { return false; }
}

function digest(config: StoreConfig, args: StartTranscriptionArgs): string {
  const payload = JSON.stringify({
    videoId: extractYouTubeVideoId(args.url),
    language: (args.language?.trim() || "ko-KR").toLowerCase(),
    durationSeconds: args.durationSeconds ?? null,
    chunkSeconds: args.chunkSeconds ?? 240,
    geminiFileUri: args.geminiFileUri ?? null,
    geminiMimeType: args.geminiMimeType ?? null,
  });
  return createHmac("sha256",config.key).update(payload).digest("hex");
}
// v3 content identity deliberately ignores acquisition hints. The v2 signing and
// storage format remain readable; existing tokens and provider IDs are unchanged.
function contentId(config: StoreConfig, args: StartTranscriptionArgs): string {
  return digest(config, {url: args.url, language: args.language});
}
function complete(record: StoredJob): boolean {
  const r = record.result;
  return record.phase === "completed" && r?.status === "completed" &&
    r.totalSegments > 0 && r.completedSegments === r.totalSegments &&
    Array.isArray(r.segments) && r.segments.length === r.totalSegments && r.segments.every(s => s.status === "completed") &&
    typeof r.transcript === "string" && isUsablePublicTranscript(r.transcript);
}

/** Find v2 records made with acquisition-specific hashes, without changing them.
 * Local files have no TTL. Redis keeps its existing 90-day write-based retention.
 * Missing/corrupt store data fails closed rather than issuing a duplicate POST.
 */
type LegacyIndex = { ids: Map<string,string[]>; unreadable: number };
const legacyIndexes = new Map<string,Promise<LegacyIndex>>();
const contentKey = (videoId:string, language:string) => `${videoId}:${language.trim().toLowerCase()}`;
async function buildLegacyIndex(config:StoreConfig):Promise<LegacyIndex> {
  let keys:string[]=[];
  if(config.localDir) {
    try { keys=(await fs.readdir(config.localDir)).filter(n=>/^yt:transcript:job:v2:[a-f0-9]{64}\.json$/.test(n)).map(n=>n.slice(0,-5)); }
    catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;}
  } else {
    let cursor="0";
    do {
      const page=await redis<[string,string[]]>(config,["SCAN",cursor,"MATCH","yt:transcript:job:v2:*","COUNT",100]);
      if(!Array.isArray(page)||page.length!==2||!Array.isArray(page[1]))throw new Error("Invalid durable cache scan response.");
      cursor=String(page[0]);keys.push(...page[1]);
      if(keys.length>10000)throw new Error("Legacy cache index exceeds safe limit; no transcription submitted.");
    }while(cursor!=="0");
  }
  const index:LegacyIndex={ids:new Map(),unreadable:0};
  for(const key of new Set(keys)){
    if(!/^yt:transcript:job:v2:[a-f0-9]{64}$/.test(key))continue;
    const id=key.slice("yt:transcript:job:v2:".length);
    try {
      const item=await load(config,id);if(!item)continue;
      const identity=contentKey(item.record.videoId,item.record.language);
      index.ids.set(identity,[...(index.ids.get(identity)||[]),id]);
    }catch{index.unreadable++;}
  }
  return index;
}
async function findExistingContent(config:StoreConfig,args:StartTranscriptionArgs):Promise<{id:string|null;warning?:string}> {
  const scope=(config.localDir||config.url)+":"+createHmac("sha256",config.key).update("legacy-index").digest("hex");
  let pending=legacyIndexes.get(scope);
  if(!pending){pending=buildLegacyIndex(config);legacyIndexes.set(scope,pending);pending.catch(()=>legacyIndexes.delete(scope));}
  const index=await pending;
  const matches:Array<{id:string;record:StoredJob}>=[];
  for(const id of index.ids.get(contentKey(extractYouTubeVideoId(args.url),args.language||"ko-KR"))||[]){
    // Reload matched IDs: completion, attempts and cooldown must never be stale.
    const item=await load(config,id);
    if(item&&(complete(item.record)||!["completed","failed"].includes(item.record.phase)))matches.push({id,record:item.record});
  }
  matches.sort((a,b)=>Number(complete(b.record))-Number(complete(a.record))||a.record.createdAt-b.record.createdAt||a.id.localeCompare(b.id));
  return {id:matches[0]?.id??null,...(index.unreadable?{warning:`${index.unreadable} unreadable legacy record(s) preserved; content identity is unknown, so legacy deduplication cannot be fully verified.`}:{})};
}

function sign(config: StoreConfig, id: string): string {
  return createHmac("sha256",config.key).update(`ytj2.${id}`).digest("base64url");
}
function makeToken(config: StoreConfig, id: string): string {
  return `ytj2.${id}.${sign(config,id)}`;
}
function decodeToken(config: StoreConfig, token: string): string {
  const match = /^ytj2\.([a-f0-9]{64})\.([\w-]{43})$/.exec(token);
  if (!match) throw new Error("Invalid durable transcription job token.");
  const actual = Buffer.from(match[2]);
  const expected = Buffer.from(sign(config,match[1]));
  if (actual.length !== expected.length || !timingSafeEqual(actual,expected)) {
    throw new Error("Invalid durable transcription job signature.");
  }
  return match[1];
}
function redisKey(id: string): string { return `yt:transcript:job:v2:${id}`; }
function redact(error: unknown): string {
  return String(error instanceof Error ? error.message : error)
    .replace(/AIza[\w-]+/g, "[REDACTED_KEY]").slice(0,500);
}
// A file is written fully before it becomes visible. SET NX is an atomic
// hardlink; EVAL compare-and-set uses a short-lived exclusive directory lock.
// An orphaned lock can be reclaimed without retrying any Gemini POST: the
// persisted starting/submitting state is quarantined by the existing state
// machine, while a stale GET-only poll can be resumed safely.
async function localRedis<T>(config:StoreConfig, command:unknown[]):Promise<T> {
  const dir=config.localDir!;
  const operation=String(command[0]);
  const key=String(operation==="EVAL"?command[3]:command[1]);
  if(!/^yt:transcript:job:v2:[a-f0-9]{64}$/.test(key))
    throw new Error("Invalid local durable job key.");
  await fs.mkdir(dir,{recursive:true,mode:0o700});
  const filename=path.join(dir,key+".json");
  const read=async():Promise<string|null>=>{
    try { return await fs.readFile(filename,"utf8"); }
    catch(err){if((err as NodeJS.ErrnoException).code==="ENOENT")return null;throw err;}
  };
  if(operation==="GET") return await read() as T;
  const tmp=filename+"."+randomUUID()+".tmp";
  if(operation==="SET"){
    if(!command.includes("NX")) throw new Error("Local durable SET requires NX.");
    // Android app sandboxes can deny hardlinks. O_EXCL is supported by Termux.
    // Persist the claim before Gemini can be called; a crash during the write
    // leaves a quarantined, never-reused claim rather than a duplicate POST.
    let handle;
    try {handle=await fs.open(filename,"wx",0o600);}
    catch(err){if((err as NodeJS.ErrnoException).code==="EEXIST")return null as T;throw err;}
    try{
      await handle.writeFile(String(command[2]),"utf8");
      await handle.sync();
    } finally {await handle.close();}
    return "OK" as T;
  }
  if(operation!=="EVAL")throw new Error("Unsupported local durable storage command.");
  const lock=filename+".lock";
  let acquired=false;
  for(let attempt=0;attempt<35;attempt++){
    try {await fs.mkdir(lock,{mode:0o700});acquired=true;break;}
    catch(err){
      if((err as NodeJS.ErrnoException).code!=="EEXIST")throw err;
      try{
        const stat=await fs.stat(lock);
        if(Date.now()-stat.mtimeMs>120_000)await fs.rmdir(lock).catch(()=>{});
      }catch(other){if((other as NodeJS.ErrnoException).code!=="ENOENT")throw other;}
      await new Promise(resolve=>setTimeout(resolve,50+attempt*5));
    }
  }
  if(!acquired)throw new Error("Local durable job lock is currently busy.");
  try{
    const previous=await read();
    if(previous!==String(command[4]))return 0 as T;
    await fs.writeFile(tmp,String(command[5]),{encoding:"utf8",mode:0o600,flag:"wx"});
    await fs.rename(tmp,filename);
    return 1 as T;
  }finally{
    await fs.rm(tmp,{force:true});
    await fs.rmdir(lock).catch(()=>{});
  }
}
async function redis<T>(config:StoreConfig, command: unknown[]): Promise<T> {
  if(config.localDir)return localRedis<T>(config,command);
  let lastError: Error | undefined;
  // EVAL CAS and SET NX are safe to repeat with the *same* arguments.
  for (let attempt=0;attempt<3;attempt++) {
    const controller = new AbortController();
    const timer=setTimeout(()=>controller.abort(),8_000);
    try {
      const response=await fetch(config.url, {
        method:"POST", headers:{Authorization:`Bearer ${config.token}`,"Content-Type":"application/json"},
        body:JSON.stringify(command),signal:controller.signal,cache:"no-store",
      });
      const json=await response.json() as {result?:T;error?:string};
      if (!response.ok || json.error) throw new Error(`Redis REST error: ${response.status} ${redact(json.error ?? "unknown")}`);
      return json.result as T;
    } catch (error) {
      lastError=new Error(`Durable job store unavailable: ${redact(error)}`);
      if (attempt<2) await new Promise(r=>setTimeout(r,(attempt+1)*300));
    } finally {clearTimeout(timer);}
  }
  throw lastError ?? new Error("Durable job store unavailable.");
}
async function load(config:StoreConfig,id:string): Promise<{raw:string;record:StoredJob}|null> {
  let raw=await redis<string|null>(config,["GET",redisKey(id)]);
  // A concurrent local O_EXCL claim may be visible just before its bytes are
  // flushed. Wait only for that claim; never issue a replacement provider POST.
  for (let n=0; config.localDir && raw === "" && n<20; n++) {
    await new Promise(resolve=>setTimeout(resolve,50));
    raw=await redis<string|null>(config,["GET",redisKey(id)]);
  }
  if (raw===null) return null;
  if (typeof raw!=="string") throw new Error("Invalid durable job store payload.");
  let record:StoredJob;
  try { record=JSON.parse(raw) as StoredJob; } catch { throw new Error("Corrupted durable job store payload."); }
  if (record.version!==2 || !record.owner || !["acquiring","starting","active","polling","submitting","completed","failed","unknown"].includes(record.phase)) {
    throw new Error("Invalid durable job record.");
  }
  return {raw,record};
}
async function saveIfUnchanged(config:StoreConfig,id:string,previousRaw:string,next:StoredJob):Promise<boolean> {
  const result=await redis<number>(config,["EVAL",CAS_SCRIPT,1,redisKey(id),previousRaw,JSON.stringify(next),REDIS_RETENTION_SECONDS]);
  return Number(result)===1;
}
async function storeResult(config:StoreConfig,id:string,owner:string,result:TranscriptionJobResult):Promise<void> {
  // Do not let a timed-out/stale worker replace a newer or quarantined record.
  const loaded=await load(config,id);
  if(!loaded || loaded.record.owner!==owner || !["acquiring","starting","polling"].includes(loaded.record.phase)) {
    throw new Error("Durable transcription job ownership changed; result was not overwritten.");
  }
  const phase:Phase=result.status==="completed"?"completed":["failed","cancelled","incomplete"].includes(result.status)?"failed":"active";
  const next:StoredJob={...loaded.record,phase,updatedAt:Date.now(),result};
  if(!await saveIfUnchanged(config,id,loaded.raw,next)) {
    const current=await load(config,id);
    if(!current || current.raw!==JSON.stringify(next)) {
      throw new Error("Durable job CAS conflict; result was not overwritten.");
    }
  }
}
function toPublic(config:StoreConfig,id:string,record:StoredJob):TranscriptionJobResult {
  const token=makeToken(config,id);
  if (record.result && record.phase!=="unknown") {
    // Hide the self-contained legacy token. Polling always resumes from the
    // latest durable state, not the caller's potentially stale response.
    const result = normalizeTranscriptionJobResult({...record.result,jobToken:token});
    if (complete(record)) return {...result,
      cacheProvider: config.localDir ? "durable-local" : "durable-redis",
      cacheVersion: "durable-v3",
      cacheCreatedAt: new Date(record.updatedAt).toISOString(),
      cacheKey: `${record.videoId}:${record.language.trim().toLowerCase()}`,
    };
    return result;
  }
  const base:TranscriptionJobResult=record.result ?? {
    status:"in_progress",jobToken:token,videoId:record.videoId,
    canonicalUrl:`https://www.youtube.com/watch?v=${record.videoId}`,
    segmentation:"whole-video",source:"gemini",durationSeconds:null,
    completedSegments:0,totalSegments:1,
    segments:[{startSeconds:0,endSeconds:null,modelIndex:0,model:"gemini-3.6-flash",attempts:0,status:"queued"}],
  };
  if(record.phase==="acquiring") {
    const result=normalizeTranscriptionJobResult({...base,status:"queued",jobToken:token});
    if(record.error) return {...result,status:"blocked",providerStatus:"not_submitted",reason:record.error,error:record.error,retryable:true,shouldPoll:false};
    return {...result,providerStatus:"not_submitted",reason:"Caption acquisition reserved; provider POST has not begun. Retrieve this same job token for progress."};
  }
  if (record.phase==="unknown" || record.phase==="failed") {
    const reason=record.error??base.error??"Transcription progress cannot safely be recovered; no duplicate Gemini POST was submitted.";
    const failed=normalizeTranscriptionJobResult({...base,status:"failed",jobToken:token,
      error:reason,transcript:undefined,first30Lines:undefined,characterCount:undefined,lineCount:undefined});
    return {...failed,status:"failed",reason,error:reason,providerStatus:"unknown",retryable:false,shouldPoll:false,nextStatusCheckAt:undefined};
  }
  return normalizeTranscriptionJobResult({...base,status:"queued",jobToken:token});
}
async function readPublic(config:StoreConfig,id:string):Promise<TranscriptionJobResult> {
  let loaded=await load(config,id);
  if(!loaded) throw new Error("Durable transcription job missing or expired; original interaction cannot be safely resubmitted.");
  if (Date.now()-loaded.record.updatedAt>UNCERTAIN_OWNER_AFTER_MS) {
    if (loaded.record.phase==="polling") {
      // Normal Gemini GETs are safe to repeat. Retry POSTs first enter
      // the durably persisted submitting phase, which cannot be reclaimed.
      const next:StoredJob={...loaded.record,phase:"active",updatedAt:Date.now()};
      await saveIfUnchanged(config,id,loaded.raw,next);
    } else if (["starting","submitting"].includes(loaded.record.phase)) {
      const next:StoredJob={...loaded.record,phase:"unknown",updatedAt:Date.now(),
        error:"Worker disappeared during a potentially submitted Gemini request. Provider interaction ID may be unknown; automatic duplicate submission is prohibited."};
      await saveIfUnchanged(config,id,loaded.raw,next);
    }
    loaded=await load(config,id);
    if (!loaded) throw new Error("Durable job expired during read.");
  }
  return toPublic(config,id,loaded.record);
}

// A lease bounds one acquisition invocation, never the overall job lifetime.
const ACQUISITION_LEASE_MS=5*60_000;
async function executeAcquisition(config:StoreConfig,id:string,owner:string,args:StartTranscriptionArgs):Promise<TranscriptionJobResult>{
  try {
    const beforeInitialPost=async()=>{
      const current=await load(config,id);
      if(!current||current.record.phase!=="acquiring"||current.record.owner!==owner)throw new Error("Caption acquisition ownership changed; no provider POST sent.");
      if(!await saveIfUnchanged(config,id,current.raw,{...current.record,phase:"starting",updatedAt:Date.now()}))throw new Error("Could not reserve initial provider POST.");
    };
    const result=await startGeminiTranscriptionJob(args,{beforeInitialPost});
    await storeResult(config,id,owner,result);
  }catch(error){
    const current=await load(config,id);
    if(current&&current.record.owner===owner&&current.record.phase==="acquiring"){
      // Proven no POST: release only this acquisition claim for explicit resume.
      const restricted=(error as {reason?:string})?.reason==="video_unavailable";
      await saveIfUnchanged(config,id,current.raw,{...current.record,phase:restricted?"failed":"acquiring",updatedAt:Date.now(),acquisitionClaimUntil:0,error:`Acquisition paused before provider submission: ${redact(error)}`});
    }else if(current&&current.record.owner===owner&&current.record.phase==="starting"){
      await saveIfUnchanged(config,id,current.raw,{...current.record,phase:"unknown",updatedAt:Date.now(),error:`Unable to confirm provider submission outcome: ${redact(error)}. No automatic replay.`});
      throw error;
    }else throw error;
  }
  return readPublic(config,id);
}
async function resumeAcquisition(config:StoreConfig,id:string):Promise<TranscriptionJobResult>{
  const current=await load(config,id);
  if(!current||current.record.phase!=="acquiring"||!current.record.startArgs||
    (current.record.acquisitionClaimUntil??0)>Date.now())return readPublic(config,id);
  const owner=randomUUID(),next:StoredJob={...current.record,owner,updatedAt:Date.now(),acquisitionClaimUntil:Date.now()+ACQUISITION_LEASE_MS};
  delete next.error;
  if(!await saveIfUnchanged(config,id,current.raw,next))return readPublic(config,id);
  return executeAcquisition(config,id,owner,next.startArgs!);
}
export async function startPersistentTranscriptionJob(args:StartTranscriptionArgs):Promise<TranscriptionJobResult> {
  const config=getConfig();
  if(!config)throw new Error("Durable transcript store is required for start; no provider request was sent.");
  const id=contentId(config,args),owner=randomUUID(),videoId=extractYouTubeVideoId(args.url);
  if(await load(config,id))return resumeAcquisition(config,id);
  // The exact legacy key is checked even if the one-time migration index exists.
  const exact=digest(config,args);
  if(exact!==id&&await load(config,exact))return resumeAcquisition(config,exact);
  const existing=await findExistingContent(config,args);
  if(existing.id)return resumeAcquisition(config,existing.id);
  const now=Date.now();
  const initial:StoredJob={version:2,phase:"acquiring",owner,createdAt:now,updatedAt:now,videoId,
    language:args.language?.trim()||"ko-KR",startArgs:{...args,url:videoId},acquisitionClaimUntil:now+ACQUISITION_LEASE_MS};
  let created:boolean;
  try{created=(await redis<string|null>(config,["SET",redisKey(id),JSON.stringify(initial),"EX",REDIS_RETENTION_SECONDS,"NX"]))==="OK";}
  catch(error){const observed=await load(config,id);if(!observed||observed.record.owner!==owner)throw error;created=true;}
  const result=created?await executeAcquisition(config,id,owner,args):await readPublic(config,id);
  return existing.warning?{...result,readWarning:[result.readWarning,existing.warning].filter(Boolean).join(" | ")}:result;
}

export async function getPersistentTranscriptionJob(jobToken:string,options?:{readOnly?:boolean}):Promise<TranscriptionJobResult> {
  const config=getConfig();
  if(!config) return getGeminiTranscriptionJob(jobToken,undefined,options);
  const id=decodeToken(config,jobToken);
  const loaded=await load(config,id);
  if(!loaded) throw new Error("Durable transcription job missing or expired.");
  if(loaded.record.phase==="acquiring")return options?.readOnly?readPublic(config,id):resumeAcquisition(config,id);
  if(loaded.record.phase!=="active" || !loaded.record.result || !["queued","in_progress","rate_limited","blocked","requires_action"].includes(loaded.record.result.status)) {
    return readPublic(config,id);
  }
  const owner=randomUUID();
  const claimed:StoredJob={...loaded.record,phase:"polling",owner,updatedAt:Date.now()};
  if(!await saveIfUnchanged(config,id,loaded.raw,claimed)) {
    const current=await load(config,id);
    if(!current || current.raw!==JSON.stringify(claimed)) return readPublic(config,id);
  }
  const beforeNewPost=async()=>{
    const latest=await load(config,id);
    if(!latest || latest.record.owner!==owner || latest.record.phase!=="polling")
      throw new Error("Durable poll ownership changed before Gemini retry POST.");
    const pending:StoredJob={...latest.record,phase:"submitting",updatedAt:Date.now()};
    if(!await saveIfUnchanged(config,id,latest.raw,pending))
      throw new Error("Could not reserve durable Gemini retry POST.");
  };
  const afterNewPost=async(legacyToken:string)=>{
    const latest=await load(config,id);
    if(!latest || latest.record.owner!==owner || latest.record.phase!=="submitting" || !latest.record.result)
      throw new Error("Gemini POST outcome cannot be safely committed.");
    const next:StoredJob={...latest.record,phase:"polling",updatedAt:Date.now(),
      result:{...latest.record.result,jobToken:legacyToken}};
    if(!await saveIfUnchanged(config,id,latest.raw,next))
      throw new Error("Could not durably save Gemini retry interaction ID.");
  };
  try {
    const result=options?.readOnly
      ? await getGeminiTranscriptionJob(loaded.record.result.jobToken,undefined,{readOnly:true})
      : await getGeminiTranscriptionJob(loaded.record.result.jobToken,{beforeNewPost,afterNewPost});
    await storeResult(config,id,owner,result);
  } catch (error) {
    // Every Gemini retry POST first reserves phase=submitting. A failure while
    // still polling is GET-only or occurs after a new interaction token was
    // durably recorded, so retrying its status GET is safe. Only an unresolved
    // submitting phase must be quarantined to prevent duplicate provider POSTs.
    const observed=await load(config,id);
    if(observed && observed.record.owner===owner && observed.record.phase==="submitting") {
      await saveIfUnchanged(config,id,observed.raw,{...observed.record,phase:"unknown",updatedAt:Date.now(),
        error:`Worker interrupted during Gemini POST: ${redact(error)}. No automatic duplicate POST.`});
    } else if(observed && observed.record.owner===owner && observed.record.phase==="polling") {
      await saveIfUnchanged(config,id,observed.raw,{...observed.record,phase:"active",updatedAt:Date.now()});
    }
    throw error;
  }
  return readPublic(config,id);
}
