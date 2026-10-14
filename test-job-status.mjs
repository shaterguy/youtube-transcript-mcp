import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {createHmac} from 'node:crypto';
import {mkdtemp,readFile,writeFile,readdir,rm} from 'node:fs/promises';
import os from 'node:os';import path from 'node:path';
const require=createRequire(import.meta.url);
const mod=require('./test-output/gemini-async.js');
const store=require('./test-output/job-store.js');
process.env.GEMINI_API_KEY='fixture-status-key';
const args={url:'G-8cDsHLrD0',durationSeconds:199,geminiFileUri:'https://generativelanguage.googleapis.com/v1beta/files/statusfixture'};
let now=1800000000000,queue=[],posts=0,gets=0,seq=0;
const realNow=Date.now,realRandom=Math.random,realFetch=global.fetch,realTimeout=global.setTimeout,realClear=global.clearTimeout;
Date.now=()=>now;Math.random=()=>0;
global.setTimeout=(fn,ms)=>{if(ms===18000)return 1;now+=ms;queueMicrotask(fn);return 2;};global.clearTimeout=()=>{};
const reply=(body,status=200,headers={})=>({ok:status>=200&&status<300,status,headers:new Headers(headers),json:async()=>body});
global.fetch=async(_url,opts={})=>{opts.method==='POST'?posts++:gets++;assert.ok(queue.length,'unexpected provider call');const x=queue.shift();if(x instanceof Error)throw x;return x;};
async function fresh(){queue=[reply({id:'v1_status_'+(++seq),status:'in_progress'})];return mod.startGeminiTranscriptionJob(args);}
function encode(state){const body=Buffer.from(JSON.stringify(state)).toString('base64url');return body+'.'+createHmac('sha256',process.env.GEMINI_API_KEY).update(body).digest('base64url');}
let dir;
try{
 let j=await fresh();queue=[reply({error:{message:'quota'}},429,{'Retry-After':'120'})];const p=posts;j=await mod.getGeminiTranscriptionJob(j.jobToken,undefined,{readOnly:true});
 assert.equal(j.status,'rate_limited','GET429 must stop in_progress');assert.equal(j.shouldPoll,false);assert.equal(j.retryable,true);assert.equal(j.providerStatus,'unknown');assert.match(j.reason,/429|quota/i);assert.equal(j.nextStatusCheckAt,j.segments[0].nextStatusCheckAt);assert.ok(j.nextStatusCheckAt>=now+120000);assert.equal(posts,p);
 const g=gets;let cool=await mod.getGeminiTranscriptionJob(j.jobToken,undefined,{readOnly:true});assert.equal(cool.status,'rate_limited');assert.equal(cool.shouldPoll,false);assert.equal(gets,g);
 now=j.nextStatusCheckAt;queue=[reply({status:'in_progress'})];j=await mod.getGeminiTranscriptionJob(j.jobToken,undefined,{readOnly:true});assert.equal(j.status,'in_progress');assert.equal(j.shouldPoll,true);assert.equal(j.providerStatus,'in_progress');assert.equal(j.nextStatusCheckAt,undefined);
 queue=[reply({status:'completed',output_text:'[00:00:01] complete'})];j=await mod.getGeminiTranscriptionJob(j.jobToken,undefined,{readOnly:true});assert.equal(j.status,'completed');assert.equal(j.shouldPoll,false);assert.equal(j.retryable,false);assert.ok(j.transcript);
 queue=[reply({error:{message:'invalid request'}},400)];const rejected=await mod.startGeminiTranscriptionJob(args);assert.equal(rejected.status,'blocked');assert.equal(rejected.retryable,false);assert.equal(rejected.shouldPoll,false);const rejectedPosts=posts;const rejectionRead=await mod.getGeminiTranscriptionJob(rejected.jobToken,undefined,{readOnly:true});assert.equal(rejectionRead.status,'blocked');assert.equal(rejectionRead.retryable,false);assert.equal(posts,rejectedPosts);
 for(const [http,retryable] of [[401,false],[403,false],[404,false],[503,true]]){j=await fresh();queue=Array.from({length:http===503?4:1},()=>reply({error:{message:'read failed'}},http));const p=posts;j=await mod.getGeminiTranscriptionJob(j.jobToken,undefined,{readOnly:true});assert.equal(j.status,'blocked');assert.equal(j.retryable,retryable);assert.equal(j.shouldPoll,false);assert.equal(j.providerStatus,'unknown');assert.equal(posts,p);}
 j=await fresh();queue=Array.from({length:4},()=>new Error('network timeout'));j=await mod.getGeminiTranscriptionJob(j.jobToken,undefined,{readOnly:true});assert.equal(j.status,'blocked');assert.equal(j.shouldPoll,false);assert.equal(j.retryable,true);
 for(const status of ['requires_action','failed','cancelled','incomplete']){j=await fresh();queue=[reply({status,error:{message:'temporary 503 but provider stopped'}})];const p=posts;j=await mod.getGeminiTranscriptionJob(j.jobToken);assert.equal(j.status,status);assert.equal(j.providerStatus,status);assert.equal(j.shouldPoll,false);assert.equal(j.retryable,false);assert.equal(posts,p,'terminal provider state must not restart silently');}
 for(const status of ['cancelled','incomplete']) {const oldView={...j,status:'failed',segments:[{...j.segments[0],status:'failed',lastProviderStatus:status}]};const migrated=mod.normalizeTranscriptionJobResult(oldView);assert.equal(migrated.status,status);assert.equal(migrated.shouldPoll,false);assert.equal(migrated.retryable,false);}
 // Old signed tokens with persisted cooldown already carry the evidence needed for new public states.
 j=await fresh();let old=JSON.parse(Buffer.from(j.jobToken.split('.')[0],'base64url'));Object.assign(old.segments[0],{lastError:'HTTP 429: quota',lastReadError:'HTTP 429: quota',lastHttpStatus:429,nextStatusCheckAt:now+60000});const legacy=encode(old);const count=gets;j=await mod.getGeminiTranscriptionJob(legacy,undefined,{readOnly:true});assert.equal(j.status,'rate_limited');assert.equal(gets,count);
 // A completed segment must not hide a blocked segment or publish partial text.
 old.segments.push({...old.segments[0],interactionId:'v1_other',lastReadError:undefined,lastError:undefined,lastHttpStatus:undefined,nextStatusCheckAt:undefined});queue=[reply({status:'completed',output_text:'[00:00:01] partial'})];j=await mod.getGeminiTranscriptionJob(encode(old),undefined,{readOnly:true});assert.equal(j.status,'rate_limited');assert.equal(j.transcript,undefined);
 dir=await mkdtemp(path.join(os.tmpdir(),'yt-status-contract-'));process.env.YOUTUBE_TRANSCRIPT_JOB_BACKEND='local';process.env.YOUTUBE_TRANSCRIPT_JOB_DIR=dir;
 queue=[reply({id:'v1_durable_status',status:'in_progress'})];let d=await store.startPersistentTranscriptionJob(args);queue=[reply({error:{message:'quota'}},429,{'Retry-After':'60'})];d=await store.getPersistentTranscriptionJob(d.jobToken,{readOnly:true});assert.equal(d.status,'rate_limited');
 const file=path.join(dir,(await readdir(dir)).find(x=>x.endsWith('.json')));let record=JSON.parse(await readFile(file,'utf8'));assert.equal(record.phase,'active');
 // Restore old in_progress facade and verify normal and concurrent polling reads expose the error.
 record.result.status='in_progress';record.result.segments[0].status='in_progress';record.phase='polling';record.updatedAt=now;await writeFile(file,JSON.stringify(record));const gc=gets;const observed=await store.getPersistentTranscriptionJob(d.jobToken,{readOnly:true});assert.equal(observed.status,'rate_limited');assert.equal(observed.shouldPoll,false);assert.equal(gets,gc);
 record.phase='active';await writeFile(file,JSON.stringify(record));d=await store.getPersistentTranscriptionJob(d.jobToken,{readOnly:true});assert.equal(d.status,'rate_limited');assert.equal(gets,gc);
 now=d.nextStatusCheckAt;queue=[reply({status:'completed',output_text:'[00:00:01] recovered'})];d=await store.getPersistentTranscriptionJob(d.jobToken,{readOnly:true});assert.equal(d.status,'completed');assert.match(d.transcript,/recovered/);
 console.log('STATUS_CONTRACT_PASS:429/cooldown/recovery/401/403/404/503/timeout/requires_action/failed/cancelled/incomplete/mixed/legacy/durable/concurrent; provider POST only fixtures');
}finally{Date.now=realNow;Math.random=realRandom;global.fetch=realFetch;global.setTimeout=realTimeout;global.clearTimeout=realClear;if(dir)await rm(dir,{recursive:true,force:true});}
