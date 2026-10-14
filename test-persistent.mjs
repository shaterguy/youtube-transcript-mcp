import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createRequire } from 'node:module';
const require=createRequire(import.meta.url);
const {startPersistentTranscriptionJob,getPersistentTranscriptionJob}=require('./test-output/job-store.js');

const oldEnv={...process.env};
process.env.UPSTASH_REDIS_REST_URL='https://test-redis.upstash.io';
process.env.UPSTASH_REDIS_REST_TOKEN='fixture-token';
process.env.YOUTUBE_TRANSCRIPT_JOB_SIGNING_KEY='fixture-signing-key-durable';
process.env.GEMINI_API_KEY='fixture-gemini-key';
process.env.YOUTUBE_TRANSCRIPT_REQUIRE_DURABLE_JOBS='1';
const redisData=new Map();
let providerPost=0,providerGet=0,storedUpdates=0;
let providerReplies=[],holdPoll=null,providerErr=false;
const response=(result,status=200)=>({ok:status>=200&&status<300,status,headers:new Headers(),json:async()=>result});
global.fetch=async (url,opts={})=>{
  const address=String(url);
  if(address.startsWith('https://test-redis.upstash.io')) {
    const [cmd,...args]=JSON.parse(opts.body);
    if(cmd==='SET') {
      const [key,val,...options]=args;
      const nx=options.includes('NX');
      if(nx && redisData.has(key))return response({result:null});
      redisData.set(key,val);storedUpdates++;
      return response({result:'OK'});
    }
    if(cmd==='GET')return response({result:redisData.get(args[0])??null});
    if(cmd==='EVAL'){
      const [script,keyCount,key,expected,next]=args;
      assert.match(script,/redis.call\('SET'/);
      assert.equal(keyCount,1);
      if(redisData.get(key)!==expected)return response({result:0});
      redisData.set(key,next);storedUpdates++;
      return response({result:1});
    }
    throw new Error('Unexpected Redis command '+cmd);
  }
  if(address.includes('generativelanguage.googleapis.com')) {
    if(opts.method==='POST')providerPost++;else providerGet++;
    if(providerErr)throw new Error('Provider intentionally unavailable');
    if(holdPoll && opts.method!=='POST')await holdPoll.promise;
    if(!providerReplies.length)throw new Error('Unexpected Gemini request '+opts.method);
    return response(providerReplies.shift());
  }
  throw new Error('Unexpected fetch URL '+url);
};
const file='https://generativelanguage.googleapis.com/v1beta/files/abc123';
const params={url:'https://youtu.be/G-8cDsHLrD0',geminiFileUri:file,durationSeconds:90,chunkSeconds:240};
providerReplies=[{id:'v1_durable1',status:'in_progress'}];
const first=await startPersistentTranscriptionJob(params);
assert.equal(first.status,'in_progress');
assert.match(first.jobToken,/^ytj2\./);
assert.equal(providerPost,1);
const repeated=await Promise.all(Array.from({length:5},()=>startPersistentTranscriptionJob(params)));
assert.equal(providerPost,1,'start requests must use single reservation');
assert.ok(repeated.every(x=>x.jobToken===first.jobToken));

let releasePoll;
const latch=new Promise(resolve=>{releasePoll=resolve;});
holdPoll={promise:latch};
providerReplies=[{status:'in_progress'}];
const polling=getPersistentTranscriptionJob(first.jobToken);
for(let i=0;i<250&&providerGet===0;i++)await new Promise(r=>setTimeout(r,1));
assert.equal(providerGet,1);
const concurrent=await Promise.all(Array.from({length:4},()=>getPersistentTranscriptionJob(first.jobToken)));
assert.ok(concurrent.every(x=>x.status==='in_progress'));
assert.equal(providerGet,1,'only the leased worker should request provider status');
releasePoll();
holdPoll=null;
const current=await polling;
assert.equal(current.status,'in_progress');
providerReplies=[{status:'completed',steps:[{type:'model_output',content:[{type:'text',text:'[00:00:03] Speaker: finished'}]}]}];
const completed=await getPersistentTranscriptionJob(first.jobToken);
assert.equal(completed.status,'completed');
assert.equal(completed.transcript,'[00:00:03] Speaker: finished');
const afterComplete=await getPersistentTranscriptionJob(first.jobToken);
assert.equal(afterComplete.transcript,completed.transcript);
assert.equal(providerPost,1);
assert.equal(providerGet,2,'completed segment must be reused');

// Losing the Gemini credential while polling is recoverable because no POST
// was reserved. Resume the persisted interaction after the key is restored.
const keyPauseParams={...params,url:'https://youtu.be/2glIuHz77IY'};
providerReplies=[{id:'v1_key_paused',status:'in_progress'}];
const keyPaused=await startPersistentTranscriptionJob(keyPauseParams);
const keyPauseRedisKey='yt:transcript:job:v2:'+keyPaused.jobToken.split('.')[1];
const beforeKeyPausePost=providerPost;
delete process.env.GEMINI_API_KEY;
await assert.rejects(getPersistentTranscriptionJob(keyPaused.jobToken),/GEMINI_API_KEY/);
process.env.GEMINI_API_KEY='fixture-gemini-key';
const afterKeyPause=JSON.parse(redisData.get(keyPauseRedisKey));
assert.equal(afterKeyPause.phase,'active','GET-only failure must remain retryable');
assert.equal(afterKeyPause.result.status,'in_progress');
providerReplies=[{status:'completed',steps:[{type:'model_output',content:[{type:'text',text:'[00:00:01] Speaker: resumed after key restoration'}]}]}];
const resumedAfterKey=await getPersistentTranscriptionJob(keyPaused.jobToken);
assert.equal(resumedAfterKey.status,'completed');
assert.match(resumedAfterKey.transcript,/resumed after key restoration/);
assert.equal(providerPost,beforeKeyPausePost,'GET-only recovery must never resubmit provider POST');

// Another worker, after a process restart, sees a durable submission marker.
const newer={...params,url:'https://youtu.be/5k0tCrXdIIM'};
const serialized=JSON.stringify({videoId:'5k0tCrXdIIM',language:'ko-kr',durationSeconds:90,chunkSeconds:240,geminiFileUri:file,geminiMimeType:null});
const hash=createHmac('sha256',process.env.YOUTUBE_TRANSCRIPT_JOB_SIGNING_KEY).update(serialized).digest('hex');
const redisKey='yt:transcript:job:v2:'+hash;
const initial={version:2,phase:'starting',owner:'crashed-worker',createdAt:Date.now()-21*60_000,updatedAt:Date.now()-21*60_000,videoId:'5k0tCrXdIIM',language:'ko-KR'};
redisData.set(redisKey,JSON.stringify(initial));
const beforeUnknown=providerPost;
const quarantined=await startPersistentTranscriptionJob(newer);
assert.equal(quarantined.status,'failed');
assert.match(quarantined.error,/disappeared/);
assert.equal(providerPost,beforeUnknown,'a crashed POST must not be retried');
const blocked=await getPersistentTranscriptionJob(quarantined.jobToken);
assert.equal(blocked.status,'failed');

// A stale GET-only poll has a known interaction ID: recover without new POST.
const pollRecoveryParams={...params,url:'https://youtu.be/bdFgK45TuPA'};
providerReplies=[{id:'v1_stalepoll',status:'in_progress'}];
const recovering=await startPersistentTranscriptionJob(pollRecoveryParams);
const recoveryKey='yt:transcript:job:v2:'+recovering.jobToken.split('.')[1];
const staleRecord=JSON.parse(redisData.get(recoveryKey));
redisData.set(recoveryKey,JSON.stringify({...staleRecord,phase:'polling',owner:'crashed-poller',updatedAt:Date.now()-21*60_000}));
const postedBeforeRecovery=providerPost,gotBeforeRecovery=providerGet;
const reclaimed=await getPersistentTranscriptionJob(recovering.jobToken);
assert.equal(reclaimed.status,'in_progress');
providerReplies=[{status:'in_progress'}];
const resumedAfterCrash=await getPersistentTranscriptionJob(recovering.jobToken);
assert.equal(resumedAfterCrash.status,'in_progress');
assert.equal(providerGet,gotBeforeRecovery+1);
assert.equal(providerPost,postedBeforeRecovery);

// A retry POST is fenced durably before it enters the network.
const retryParams={...params,url:'https://youtu.be/5LNRvdyzmrY'};
providerReplies=[{id:'v1_retry_safe',status:'in_progress'}];
const retryStart=await startPersistentTranscriptionJob(retryParams);
const retryKey='yt:transcript:job:v2:'+retryStart.jobToken.split('.')[1];
const originalFetch=global.fetch;
let signalRetryPost,releaseRetryPost;
const enteredRetryPost=new Promise(r=>{signalRetryPost=r;});
const blockedRetryPost=new Promise(r=>{releaseRetryPost=r;});
global.fetch=async (url,options={})=>{
  if(String(url).includes('generativelanguage.googleapis.com') && options.method==='POST'){
    providerPost++;
    signalRetryPost();
    await blockedRetryPost;
    return response({id:'v1_post_completed_after_crash',status:'in_progress'});
  }
  return originalFetch(url,options);
};
providerReplies=[{status:'failed',error:{code:503,message:'503 retryable provider failure'}}];
const pendingRetry=getPersistentTranscriptionJob(retryStart.jobToken);
await enteredRetryPost;
const beforeQuarantine=JSON.parse(redisData.get(retryKey));
assert.equal(beforeQuarantine.phase,'submitting','retry POST fence persisted before submission');
redisData.set(retryKey,JSON.stringify({...beforeQuarantine,updatedAt:Date.now()-21*60_000}));
const forbiddenRepeat=await getPersistentTranscriptionJob(retryStart.jobToken);
assert.equal(forbiddenRepeat.status,'failed');
assert.match(forbiddenRepeat.error,/disappeared/);
const postedAtQuarantine=providerPost;
const duplicate=await getPersistentTranscriptionJob(retryStart.jobToken);
assert.equal(duplicate.status,'failed');
assert.equal(providerPost,postedAtQuarantine);
releaseRetryPost();
await pendingRetry.catch(()=>{});
global.fetch=originalFetch;

let invalid=false;
try {await getPersistentTranscriptionJob(first.jobToken.slice(0,-5)+'xxxxx');} catch(e) {invalid=/signature/.test(e.message);}
assert.equal(invalid,true);
assert.ok(storedUpdates>=6);

console.log(JSON.stringify({status:'PASS',cases:['atomic reservation dedup','cross-worker single poll lease','durable interaction ID resume','complete transcript persistence','unknown POST crash quarantine','stale GET recovery','durable POST fence','tampered token rejection'],providerPost,providerGet,storedUpdates},null,2));
Object.assign(process.env,oldEnv);
