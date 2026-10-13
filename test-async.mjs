import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require=createRequire(import.meta.url);
const {startGeminiTranscriptionJob,getGeminiTranscriptionJob}=require('./test-output/gemini-async.js');
process.env.GEMINI_API_KEY='test-key-do-not-use';

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
queue=[reply({error:{message:'temporary high demand'}},503),reply({id:'v1_mock'+(++n),status:'in_progress'}),reply({id:'v1_mock'+(++n),status:'in_progress'}),reply({id:'v1_mock'+(++n),status:'in_progress'})];
const started=await startGeminiTranscriptionJob({url:'https://youtu.be/G-8cDsHLrD0',language:'ko-KR',durationSeconds:520,chunkSeconds:240});
assert.equal(started.totalSegments,3);assert.equal(started.segmentation,'prompt-scoped');
assert.equal(started.status,'in_progress');assert.equal(started.segments.every(x=>x.attempts===1),true);
assert.deepEqual(calls.filter(x=>x.method==='POST' && x.payload).slice(0,4).map(x=>x.payload.input[0].processing),
    ['static','static','static','static']);
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
const multi=await startGeminiTranscriptionJob({url:'G-8cDsHLrD0',durationSeconds:180,chunkSeconds:60});
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
assert.equal(queuedCheck.segments[0].status,'in_progress');
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
queue=[reply({error:{message:'Rate limit exceeded for model gemini-3.8-flash. Please retry in 27s'}},429)];
const throttledPoll=await getGeminiTranscriptionJob(throttled.jobToken);
assert.equal(throttledPoll.status,'in_progress');
assert.equal(throttledPoll.segments[0].modelIndex,0);
assert.equal(calls.length,nBeforeRateGet+1);

// A POST 429 may be retried, honoring provider retry guidance.
queue=[
 reply({error:{message:'Rate limit exceeded. Please retry in 0s'}},429),
 reply({id:'v1_post429_recovered',status:'in_progress'})
];
const recoveredPost429=await startGeminiTranscriptionJob({url:'G-8cDsHLrD0',durationSeconds:60});
assert.equal(recoveredPost429.status,'in_progress');

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
Date.now=()=>advanceNow()+30_000;
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
Date.now=()=>advanceNow2()+2_000;
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

console.log(JSON.stringify({status:'PASS',cases:['503 backoff','YouTube time-window scopes','all-segment assembly','signed token rejection','empty-result rejection','provider failed retry with one model','Gemini Files native clipping','queued background handling','INTERNAL provider retry','GET 429 non-hammering','POST 429 retry guidance','resume without re-fetching completed segments','persistent GET 429 preserves active interaction','GET 429 cooldown','clear stale 429 errors'],completed_segments:completed.totalSegments,recovered_model:retry.segments[0].model},null,2));
