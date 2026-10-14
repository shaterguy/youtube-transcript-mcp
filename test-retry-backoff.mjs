import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {spawnSync} from 'node:child_process';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
const require=createRequire(import.meta.url);
const {startGeminiTranscriptionJob:start,getGeminiTranscriptionJob:get}=require('./test-output/gemini-async.js');
const yt=require('./test-output/yt-dlp.js');
yt.getYouTubeCaptionsWithYtDlp=async()=>{throw new yt.YtDlpCaptionError('fixture without captions','no_captions')};
process.env.GEMINI_API_KEY='fixture-backoff-key';
let now=1800000000000, posts=0,gets=0,queue=[],sequence=0;
const realNow=Date.now,realRandom=Math.random,realFetch=global.fetch;
Date.now=()=>now;Math.random=()=>0.5;
const reply=(body,status=200,headers={})=>({ok:status>=200&&status<300,status,headers:new Headers(headers),json:async()=>body});
global.fetch=async(_uri,opts={})=>{opts.method==='POST'?posts++:gets++;assert.ok(queue.length,'unexpected provider call');return queue.shift();};
const args={url:'G-8cDsHLrD0',durationSeconds:199};
async function fresh(){queue=[reply({id:'v1_backoff_'+(++sequence),status:'in_progress'})];return start(args);}
async function rate(job,header='30'){queue=[reply({error:{message:'Rate limited'}},429,{'Retry-After':header})];const p=posts;const v=await get(job.jobToken,undefined,{readOnly:true});assert.equal(posts,p);return v;}
function child(script,input,env={}){const c=spawnSync(process.execPath,['--input-type=commonjs','-e',script],{cwd:process.cwd(),input:JSON.stringify(input),encoding:'utf8',env:{...process.env,...env}});assert.equal(c.status,0,c.stderr);return JSON.parse(c.stdout);}
let temp;
try{
 for(const [header,minimum] of [['120',120000],[new Date(now+120000).toUTCString(),120000],['3600',3600000]]){
  const j=await fresh(),v=await rate(j,header);assert.equal(v.segments[0].lastRetryAfterMs,minimum,'provider minimum must not be truncated');assert.ok(v.segments[0].nextStatusCheckAt-now>=minimum);const count=gets;const cooled=await get(v.jobToken,undefined,{readOnly:true});assert.equal(gets,count);assert.equal(cooled.segments[0].cooldownSkipped,true);
 }
 let j=await fresh();const before=posts;
 for(const base of [30000,60000,120000]){j=await rate(j);const delay=j.segments[0].nextStatusCheckAt-now;assert.ok(delay>=base&&delay<=base*1.1,'bounded positive jitter over exponential base');now=j.segments[0].nextStatusCheckAt;}
 assert.equal(posts,before);
 queue=[reply({status:'in_progress'})];j=await get(j.jobToken,undefined,{readOnly:true});assert.equal(j.segments[0].lastProviderStatus,'in_progress');assert.equal(j.segments[0].nextStatusCheckAt,undefined);
 j=await rate(j);assert.equal(j.segments[0].nextStatusCheckAt-now,31500,'2xx resets consecutive429 count');assert.equal(j.segments[0].lastProviderStatus,undefined,'failed latest observation cannot retain a stale provider status');
 const resumed=child(`const fs=require('fs');const x=JSON.parse(fs.readFileSync(0,'utf8'));Date.now=()=>x.now;global.fetch=async()=>{throw Error('network forbidden during persisted cooldown')};require('./test-output/gemini-async.js').getGeminiTranscriptionJob(x.token,undefined,{readOnly:true}).then(v=>console.log(JSON.stringify({next:v.segments[0].nextStatusCheckAt,skip:v.segments[0].cooldownSkipped}))).catch(e=>{console.error(e.message);process.exit(1)});`,{now,token:j.jobToken});
 assert.equal(resumed.next,j.segments[0].nextStatusCheckAt);assert.equal(resumed.skip,true);
 for(const header of ['nonsense','1e309','-1']){const bad=await rate(await fresh(),header);assert.ok(Number.isSafeInteger(bad.segments[0].nextStatusCheckAt));assert.ok(bad.segments[0].nextStatusCheckAt>now);}
 // Exercise actual retry timer chunking; GET429 deliberately bypasses this path.
 const timerJob=await fresh();
 const realTimeout=global.setTimeout,realClear=global.clearTimeout;const timers=[];
 global.setTimeout=(fn,ms)=>{if(ms===18000)return 1;timers.push(ms);now+=ms;queueMicrotask(fn);return 2;};
 global.clearTimeout=()=>{};
 try{queue=[reply({error:{message:'Temporary unavailable'}},503,{'Retry-After':'2147484'}),reply({status:'in_progress'})];const p=posts;const timed=await get(timerJob.jobToken,undefined,{readOnly:true});assert.equal(timed.segments[0].lastHttpStatus,200);assert.equal(posts,p);assert.ok(timers.length>=2);assert.ok(timers.every(x=>x>0&&x<=2147483647));assert.ok(timers.reduce((a,b)=>a+b,0)>=2147484000);}
 finally{global.setTimeout=realTimeout;global.clearTimeout=realClear;}
 for(const random of [0,0.999999999]){Math.random=()=>random;let cap=await fresh();for(let n=1;n<=9;n++){cap=await rate(cap);const base=Math.min(1800000,30000*2**(n-1)),delay=cap.segments[0].nextStatusCheckAt-now;assert.ok(delay>=base&&delay<=base*1.1);now=cap.segments[0].nextStatusCheckAt;}cap=await rate(cap,'3600');assert.ok(cap.segments[0].nextStatusCheckAt-now>=3600000);}
 Math.random=()=>0.5;
 const {startPersistentTranscriptionJob:ps,getPersistentTranscriptionJob:pg}=require('./test-output/job-store.js');temp=await mkdtemp(path.join(os.tmpdir(),'yt-backoff-regression-'));process.env.YOUTUBE_TRANSCRIPT_JOB_BACKEND='local';process.env.YOUTUBE_TRANSCRIPT_JOB_DIR=temp;
 queue=[reply({id:'v1_backoff_durable',status:'in_progress'})];let d=await ps(args);queue=[reply({error:{message:'Rate limited'}},429,{'Retry-After':'120'})];const p=posts;d=await pg(d.jobToken,{readOnly:true});assert.equal(posts,p);
 const disk=child(`const fs=require('fs');const x=JSON.parse(fs.readFileSync(0,'utf8'));Date.now=()=>x.now;global.fetch=async()=>{throw Error('network forbidden during durable cooldown')};require('./test-output/job-store.js').getPersistentTranscriptionJob(x.token,{readOnly:true}).then(v=>console.log(JSON.stringify({next:v.segments[0].nextStatusCheckAt,skip:v.segments[0].cooldownSkipped}))).catch(e=>{console.error(e.message);process.exit(1)});`,{now,token:d.jobToken});assert.equal(disk.next,d.segments[0].nextStatusCheckAt);assert.equal(disk.skip,true);
 console.log(JSON.stringify({status:'PASS',checks:['RetryAfter seconds/date120s and3600s preserved','exponential30/60/120 plus positive jitter','cooldown GET0','2xx reset','stale provider status removed','legacy and durable cooldown survive new process','invalid header finite fallback','long retry timer chunks','30min exponential cap and jitter endpoints','readOnly POST0']}));
}finally{Date.now=realNow;Math.random=realRandom;global.fetch=realFetch;if(temp)await rm(temp,{recursive:true,force:true});}
