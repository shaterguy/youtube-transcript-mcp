import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require=createRequire(import.meta.url);
const {startGeminiTranscriptionJob,getGeminiTranscriptionJob}=require('./test-output/gemini-async.js');
process.env.GEMINI_API_KEY='test-key-do-not-use';
const ytDlp=require('./test-output/yt-dlp.js');
assert.equal(ytDlp.classifyYtDlpFailure('ERROR: Sign in to confirm you’re not a bot'), 'bot_challenge');
assert.equal(ytDlp.classifyYtDlpFailure('ERROR: Video unavailable'), 'video_unavailable');
assert.equal(ytDlp.classifyYtDlpFailure('ERROR: Private video'), 'video_unavailable');
assert.equal(ytDlp.classifyYtDlpFailure('HTTP Error 429: Too Many Requests'), 'rate_limited');
// The cloud executable must not depend on a globally installed yt-dlp CLI.
import path from 'node:path';
const savedVercel=process.env.VERCEL;
const savedBinary=process.env.YT_DLP_BIN;
process.env.VERCEL='1';
delete process.env.YT_DLP_BIN;
assert.equal(ytDlp.executor().binary,path.join(process.cwd(),'vendor','yt-dlp_linux'));
assert.deepEqual(ytDlp.executor().prefix,[]);
process.env.YT_DLP_BIN='/fixtures/yt-dlp';
assert.equal(ytDlp.executor().binary,'/fixtures/yt-dlp');
if(savedVercel===undefined)delete process.env.VERCEL;else process.env.VERCEL=savedVercel;
if(savedBinary===undefined)delete process.env.YT_DLP_BIN;else process.env.YT_DLP_BIN=savedBinary;
ytDlp.getYouTubeCaptionsWithYtDlp=async()=>{throw new ytDlp.YtDlpCaptionError('No captions in fixture','no_captions');};
const GEMINI_FILE='https://generativelanguage.googleapis.com/v1beta/files/abc123';


function reply(body,status=200,headers={}){
  return {ok:status>=200 && status<300,status,headers:new Headers(headers),json:async()=>body,text:async()=>JSON.stringify(body)};
}
let queue=[];
let calls=[];
global.fetch=async (uri,opts={})=>{
  const method=opts.method??'GET';
  calls.push({uri,method,payload:opts.body?JSON.parse(opts.body):null});
  if(!queue.length)throw new Error(`Unexpected HTTP ${method} ${uri}`);
  const fn=queue.shift();return typeof fn==='function'?fn(uri,opts):fn;
};
let n=0;
queue=[reply({error:{message:'Rate limit exceeded. Please retry in 0s'}},429),reply({id:'v1_mock'+(++n),status:'in_progress'}),reply({id:'v1_mock'+(++n),status:'in_progress'}),reply({id:'v1_mock'+(++n),status:'in_progress'})];
const started=await startGeminiTranscriptionJob({url:'https://youtu.be/G-8cDsHLrD0',language:'ko-KR',durationSeconds:520,chunkSeconds:240,geminiFileUri:GEMINI_FILE});
assert.equal(started.totalSegments,3);assert.equal(started.segmentation,'file-clips');
assert.equal(started.status,'in_progress');assert.equal(started.segments.every(x=>x.attempts===1),true);
assert.equal(calls.filter(x=>x.method==='POST' && x.payload).slice(0,4).every(x=>x.payload.input[0].processing.type==='static'),true);
const prompts=calls.filter(x=>x.method==='POST' && x.payload).map(x=>x.payload.input[1].text).join(' ');
assert.ok(prompts.includes('00:03:57') && prompts.includes('00:07:57'));
const statuses=['00:00:05','00:04:05','00:08:12'];
queue=statuses.map(t=>reply({status:'completed',steps:[{type:'model_output',content:[{type:'text',text:`[${t}] 화자 1: 테스트 발화` }]}]}));
let completed=await getGeminiTranscriptionJob(started.jobToken);
assert.equal(completed.status,'completed');assert.equal(completed.completedSegments,3);
assert.equal(completed.transcript.split('\n').length,3);
assert.equal(completed.first30Lines.length,3);
let invalid=false;try{await getGeminiTranscriptionJob(started.jobToken.slice(0,-2)+'xx')}catch(e){invalid=/signature/.test(e.message)}assert.ok(invalid);

// Cache partial completed clips in the signed token so GET rate limits cannot
// prevent a video with more than five clips from ever fully assembling.
queue=[
  reply({id:'v1_keep1',status:'in_progress'}),
  reply({id:'v1_keep2',status:'in_progress'}),
  reply({id:'v1_keep3',status:'in_progress'})
];
const multi=await startGeminiTranscriptionJob({url:'G-8cDsHLrD0',durationSeconds:180,chunkSeconds:60,geminiFileUri:GEMINI_FILE});
assert.equal(multi.totalSegments,3);
queue=[
  reply({status:'completed',steps:[{type:'model_output',content:[{type:'text',text:'[00:00:01] 화자: 첫 구간'}]}]}),
  reply({status:'in_progress'}),
  reply({status:'in_progress'})
];
const partial=await getGeminiTranscriptionJob(multi.jobToken);
assert.equal(partial.status,'in_progress');
assert.equal(partial.completedSegments,1);
const readsBeforeResume=calls.filter(x=>x.method==='GET').length;
queue=[
  reply({status:'completed',steps:[{type:'model_output',content:[{type:'text',text:'[00:01:05] 화자: 두 번째 구간'}]}]}),
  reply({status:'completed',steps:[{type:'model_output',content:[{type:'text',text:'[00:02:06] 화자: 세 번째 구간'}]}]})
];
const assembled=await getGeminiTranscriptionJob(partial.jobToken);
assert.equal(assembled.status,'completed');
assert.equal(assembled.completedSegments,3);
assert.equal(assembled.transcript.split('\n').length,3);
assert.equal(calls.filter(x=>x.method==='GET').length-readsBeforeResume,2);
const readsBeforeRepeatedPoll=calls.filter(x=>x.method==='GET').length;
queue=[];
const reassembled=await getGeminiTranscriptionJob(assembled.jobToken);
assert.equal(reassembled.status,'completed');
assert.equal(reassembled.transcript,assembled.transcript);
assert.equal(calls.filter(x=>x.method==='GET').length,readsBeforeRepeatedPoll);
assert.ok(assembled.jobToken.length < 128000);

// Completed interaction with no text must NEVER be published as full transcript.
queue=[reply({id:'v1_another',status:'in_progress'})];
const one=await startGeminiTranscriptionJob({url:'G-8cDsHLrD0',durationSeconds:60});
queue=[reply({status:'completed',steps:[{type:'model_output',content:[]}]})];
const empty=await getGeminiTranscriptionJob(one.jobToken);
assert.equal(empty.status,'failed');assert.equal('transcript' in empty,false);

// Provider-level 503 triggers a new background interaction and model fallback.
queue=[reply({id:'v1_recover1',status:'in_progress'})];
const recover=await startGeminiTranscriptionJob({url:'G-8cDsHLrD0',durationSeconds:100});
queue=[reply({status:'failed',error:{code:503,message:'503 high demand'}}),reply({id:'v1_recover2',status:'in_progress'})];
const retry=await getGeminiTranscriptionJob(recover.jobToken);
assert.equal(retry.status,'in_progress');assert.equal(retry.segments[0].modelIndex,0);
assert.notEqual(retry.jobToken,recover.jobToken);
queue=[reply({status:'completed',steps:[{type:'model_output',content:[{type:'text',text:'[00:00:01] 화자: 성공'}]}]})];
const ready=await getGeminiTranscriptionJob(retry.jobToken);
assert.equal(ready.status,'completed');

// Gemini may leave a background request queued during high demand. It is not a failure.
queue=[reply({id:'v1_queued_interaction',status:'queued'})];
const queuedJob=await startGeminiTranscriptionJob({url:'G-8cDsHLrD0',durationSeconds:60});
queue=[reply({status:'queued'})];
const queuedCheck=await getGeminiTranscriptionJob(queuedJob.jobToken);
assert.equal(queuedCheck.status,'in_progress');
assert.equal(queuedCheck.segments[0].status,'queued');
assert.equal(queuedCheck.segments[0].modelIndex,0);

// INTERNAL is a transient provider failure, even when nested in an errors array.
queue=[reply({id:'v1_internal1',status:'in_progress'})];
const internal=await startGeminiTranscriptionJob({url:'G-8cDsHLrD0',durationSeconds:60});
queue=[
  reply({status:'failed', errors:[{code:'INTERNAL',message:'There was a problem processing your request. You will not be charged.'}]}),
  reply({id:'v1_internal2',status:'in_progress'})
];
const recoveredInternal=await getGeminiTranscriptionJob(internal.jobToken);
assert.equal(recoveredInternal.status,'in_progress');
assert.equal(recoveredInternal.segments[0].modelIndex,0);
assert.notEqual(recoveredInternal.jobToken,internal.jobToken);

// A Free Tier GET 429 must not hammer the provider with immediate retries.
queue=[reply({id:'v1_rate1',status:'in_progress'})];
const throttled=await startGeminiTranscriptionJob({url:'G-8cDsHLrD0',durationSeconds:60});
const nBeforeRateGet=calls.length;
queue=[reply({error:{message:'Rate limit exceeded. Retry later.'}},429,{'Retry-After':'7'})];
const throttledPoll=await getGeminiTranscriptionJob(throttled.jobToken);
assert.equal(throttledPoll.status,'in_progress');
assert.equal(throttledPoll.segments[0].modelIndex,0);
assert.equal(calls.length,nBeforeRateGet+1);
assert.equal(throttledPoll.segments[0].lastHttpStatus,429);
assert.equal(throttledPoll.segments[0].lastRetryAfterMs,7000);
assert.match(throttledPoll.readWarning,/HTTP 429/);
assert.ok(throttledPoll.segments[0].lastCheckedAt>0);
const beforeCooldownGet=calls.length;
const cooling=await getGeminiTranscriptionJob(throttledPoll.jobToken,undefined,{readOnly:true});
assert.equal(calls.length,beforeCooldownGet);
assert.equal(cooling.segments[0].cooldownSkipped,true);
assert.match(cooling.readWarning,/GET skipped/);
assert.equal(cooling.segments[0].lastProviderStatus,undefined);

// GET-only must never submit a new interaction on provider failure, even if retryable.
queue=[reply({id:'v1_readonly_fail',status:'in_progress'})];
const roFail=await startGeminiTranscriptionJob({url:'G-8cDsHLrD0',durationSeconds:60});
const beforeReadOnlyPosts=calls.filter(c=>c.method==='POST').length;
queue=[reply({status:'failed',error:{code:503,message:'503 high demand'}})];
const roFailed=await getGeminiTranscriptionJob(roFail.jobToken,undefined,{readOnly:true});
assert.equal(roFailed.status,'failed');
assert.equal(calls.filter(c=>c.method==='POST').length,beforeReadOnlyPosts);
assert.equal(roFailed.segments[0].attempts,1);
assert.equal(roFailed.segments[0].lastProviderStatus,'failed');
assert.equal(roFailed.segments[0].lastHttpStatus,200);
// requires_action is a genuine provider state; do not report a confirmed in_progress.
queue=[reply({id:'v1_readonly_action',status:'in_progress'})];
const roAction=await startGeminiTranscriptionJob({url:'G-8cDsHLrD0',durationSeconds:60});
queue=[reply({status:'requires_action',steps:[{type:'tool_call',content:[]}]})];
const action=await getGeminiTranscriptionJob(roAction.jobToken,undefined,{readOnly:true});
assert.equal(action.status,'in_progress');
assert.equal(action.segments[0].status,'requires_action');
assert.equal(action.segments[0].lastProviderStatus,'requires_action');
assert.equal(calls.filter(c=>c.method==='POST').length,beforeReadOnlyPosts+1);

// A sustained 503 GET remains an unconfirmed provider state; GET-only cannot POST.
queue=[reply({id:'v1_readonly_http503',status:'in_progress'})];
const transport503=await startGeminiTranscriptionJob({url:'G-8cDsHLrD0',durationSeconds:60});
const postsBefore503=calls.filter(c=>c.method==='POST').length;
queue=Array.from({length:4},()=>reply({error:{message:'Provider overloaded'}},503,{'Retry-After':'0'}));
const unavailable=await getGeminiTranscriptionJob(transport503.jobToken,undefined,{readOnly:true});
assert.equal(unavailable.status,'in_progress');
assert.equal(unavailable.segments[0].lastHttpStatus,503);
assert.match(unavailable.readWarning,/HTTP 503/);
assert.equal(unavailable.segments[0].attempts,1);
assert.equal(calls.filter(c=>c.method==='POST').length,postsBefore503);
// A transient network error is recovered by GET; do not retain stale failure metadata.
queue=[reply({id:'v1_readonly_network',status:'in_progress'})];
const flaky=await startGeminiTranscriptionJob({url:'G-8cDsHLrD0',durationSeconds:60});
const postsBeforeNetwork=calls.filter(c=>c.method==='POST').length;
queue=[()=>{throw new Error('fixture network timeout');},reply({status:'in_progress'})];
const recoveredRead=await getGeminiTranscriptionJob(flaky.jobToken,undefined,{readOnly:true});
assert.equal(recoveredRead.segments[0].lastHttpStatus,200);
assert.equal(recoveredRead.segments[0].lastReadError,undefined);
assert.equal(recoveredRead.readWarning,undefined);
assert.equal(calls.filter(c=>c.method==='POST').length,postsBeforeNetwork);

// A POST 429 may be retried, honoring provider retry guidance.
queue=[
 reply({error:{message:'Rate limit exceeded. Please retry in 0s'}},429),
 reply({id:'v1_post429_recovered',status:'in_progress'})
];
const recoveredPost429=await startGeminiTranscriptionJob({url:'G-8cDsHLrD0',durationSeconds:60});
assert.equal(recoveredPost429.status,'in_progress');

// An ambiguous POST failure must not be automatically replayed on a new poll.
const beforeAmbiguous=calls.filter(x=>x.method==='POST').length;
queue=[reply({error:{message:'upstream overloaded'}},503)];
const uncertain=await startGeminiTranscriptionJob({url:'G-8cDsHLrD0',durationSeconds:60});
assert.equal(uncertain.status,'failed');
assert.match(uncertain.segments[0].error,/HTTP 503/);
assert.equal(calls.filter(x=>x.method==='POST').length-beforeAmbiguous,1);
queue=[];
const uncertainPoll=await getGeminiTranscriptionJob(uncertain.jobToken);
assert.equal(uncertainPoll.status,'failed');
assert.equal(calls.filter(x=>x.method==='POST').length-beforeAmbiguous,1);

const beforeLostReply=calls.filter(x=>x.method==='POST').length;
queue=[()=>{throw new Error('Connection closed after request was sent');}];
const lostReply=await startGeminiTranscriptionJob({url:'G-8cDsHLrD0',durationSeconds:60});
assert.equal(lostReply.status,'failed');
assert.match(lostReply.segments[0].error,/Connection closed/);
queue=[];
assert.equal((await getGeminiTranscriptionJob(lostReply.jobToken)).status,'failed');
assert.equal(calls.filter(x=>x.method==='POST').length-beforeLostReply,1);

// A successful POST without an interaction ID is likewise indeterminate.
const beforeMissingId=calls.filter(x=>x.method==='POST').length;
queue=[reply({status:'in_progress'})];
const missingId=await startGeminiTranscriptionJob({url:'G-8cDsHLrD0',durationSeconds:60});
assert.equal(missingId.status,'failed');
queue=[];
assert.equal((await getGeminiTranscriptionJob(missingId.jobToken)).status,'failed');
assert.equal(calls.filter(x=>x.method==='POST').length-beforeMissingId,1);

// A persistent GET 429 is throttled, then rerouted to the next model
// after a second independent status read; no completed clip is discarded.
queue=[reply({id:'v1_get429_fallback_1',status:'in_progress'})];
const stuck429=await startGeminiTranscriptionJob({url:'G-8cDsHLrD0',durationSeconds:60});
queue=[reply({error:{message:'Rate limit exceeded. Please retry in 27s'}},429)];
const quotaFirst=await getGeminiTranscriptionJob(stuck429.jobToken);
assert.equal(quotaFirst.status,'in_progress');
assert.equal(quotaFirst.segments[0].modelIndex,0);
const beforeCooldownCall=calls.length;
queue=[];
const quotaCooling=await getGeminiTranscriptionJob(quotaFirst.jobToken);
assert.equal(quotaCooling.status,'in_progress');
assert.equal(calls.length,beforeCooldownCall, 'GET during Retry-After cooldown');
const advanceNow=Date.now;
let quotaSecond;
Date.now=()=>quotaCooling.segments[0].nextStatusCheckAt;
try{
  queue=[
    reply({error:{message:'Rate limit exceeded. Please retry in 27s'}},429)
  ];
  quotaSecond=await getGeminiTranscriptionJob(quotaCooling.jobToken);
} finally {Date.now=advanceNow;}
assert.equal(quotaSecond.status,'in_progress');
assert.equal(quotaSecond.segments[0].modelIndex,0);
assert.equal(quotaSecond.segments[0].attempts,1);
assert.equal(calls.at(-1).method,'GET');
assert.notEqual(quotaSecond.jobToken,quotaFirst.jobToken);

// When a provider starts answering status GETs again, stale 429 is removed.
queue=[reply({id:'v1_quota_then_ok',status:'in_progress'})];
const recoveringStatus=await startGeminiTranscriptionJob({url:'G-8cDsHLrD0',durationSeconds:60});
queue=[reply({error:{message:'Rate limit exceeded. Please retry in 0s'}},429)];
const firstBlocked=await getGeminiTranscriptionJob(recoveringStatus.jobToken);
const advanceNow2=Date.now;
let clearedError;
Date.now=()=>firstBlocked.segments[0].nextStatusCheckAt;
try{
  queue=[reply({status:'in_progress'})];
  clearedError=await getGeminiTranscriptionJob(firstBlocked.jobToken);
} finally {Date.now=advanceNow2;}
assert.equal(clearedError.status,'in_progress');
assert.equal(clearedError.segments[0].error,undefined);

// Files API URI uses native physical clip offsets instead of YouTube prompt scoping.
queue=[reply({id:'v1_gemfile',status:'in_progress'})];
const fileJob=await startGeminiTranscriptionJob({url:'G-8cDsHLrD0',durationSeconds:60,
   geminiFileUri:'https://generativelanguage.googleapis.com/v1beta/files/abc123',geminiMimeType:'video/mp4'});
assert.equal(fileJob.segmentation,'file-clips');
assert.deepEqual(calls.at(-1).payload.input[0].processing,{type:'static',start_offset:'0s',end_offset:'60s'});
assert.equal(calls.at(-1).payload.input[0].mime_type,'video/mp4');


// Genuine YouTube URI must be uploaded only ONCE even with known 9-minute
// duration; do not reinterpret prompt windows as physical clips.
queue=[reply({id:'v1_once',status:'in_progress'})];
const beforeOnce=calls.filter(x=>x.method==='POST').length;
const whole=await startGeminiTranscriptionJob({url:'G-8cDsHLrD0',durationSeconds:520,chunkSeconds:60});
assert.equal(whole.segmentation,'whole-video');
assert.equal(whole.totalSegments,1);
assert.equal(calls.filter(x=>x.method==='POST').length-beforeOnce,1);
// Existing human/auto captions must bypass Gemini even for the async tool.
ytDlp.getYouTubeCaptionsWithYtDlp=async()=>({transcript:'[00:00:01] 안녕하세요',language:'ko',kind:'manual'});
const beforeCaption=calls.length;
const captioned=await startGeminiTranscriptionJob({url:'G-8cDsHLrD0',durationSeconds:600});
assert.equal(captioned.source,'yt-dlp');
assert.equal(captioned.segmentation,'captions');
assert.equal(captioned.status,'completed');
assert.ok(captioned.transcript.includes('안녕하세요'));
assert.equal(calls.length,beforeCaption);
const restored=await getGeminiTranscriptionJob(captioned.jobToken);
assert.equal(restored.transcript,captioned.transcript);

console.log(JSON.stringify({status:'PASS',cases:['503 backoff','Gemini Files native time-window clips','all-segment assembly','signed token rejection','empty-result rejection','provider failed retry with one model','Gemini Files native clipping','queued background handling','INTERNAL provider retry','GET 429 non-hammering','POST 429 retry guidance','resume without re-fetching completed segments','persistent GET 429 preserves active interaction','YouTube submitted once','async caption-first bypasses Gemini','GET 429 cooldown','clear stale 429 errors'],completed_segments:completed.totalSegments,recovered_model:retry.segments[0].model},null,2));
