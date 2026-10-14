import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdtemp,readFile,writeFile,readdir,rm} from 'node:fs/promises';
import {createHmac,createHash} from 'node:crypto';
import os from 'node:os';import path from 'node:path';
const require=createRequire(import.meta.url),fsp=require('node:fs').promises;
const jobs=require('./test-output/job-store.js'),yt=require('./test-output/yt-dlp.js');
const root=await mkdtemp(path.join(os.tmpdir(),'yt-start-recovery-'));
process.env.YOUTUBE_TRANSCRIPT_JOB_BACKEND='local';process.env.YOUTUBE_TRANSCRIPT_JOB_SIGNING_KEY='fixture-recovery-signing';process.env.GEMINI_API_KEY='fixture-recovery-api';
const key=process.env.YOUTUBE_TRANSCRIPT_JOB_SIGNING_KEY;
const sign=s=>createHmac('sha256',key).update(s).digest('base64url');
const token=id=>'ytj2.'+id+'.'+sign('ytj2.'+id);
const transcript='[00:00:01] Complete fixture speech.';
const complete={status:'completed',jobToken:'legacy-fixture',videoId:'Old00000001',canonicalUrl:'https://www.youtube.com/watch?v=Old00000001',source:'yt-dlp',segmentation:'captions',durationSeconds:null,completedSegments:1,totalSegments:1,segments:[{startSeconds:0,endSeconds:null,modelIndex:0,model:'gemini-3.6-flash',attempts:0,status:'completed'}],transcript};
let post=0,gets=0,mode='success';
yt.getYouTubeCaptionsWithYtDlp=async()=>{if(mode==='captions')return{transcript};throw new yt.YtDlpCaptionError('fixture no caption',mode==='budget'?'acquisition_budget':'no_captions');};
global.fetch=async(url,options={})=>{
 assert.match(String(url),/^https:\/\/generativelanguage\.googleapis\.com\/v1beta\/interactions(?:\/v1_\w+)?$/,'Fixture rejects all other network');
 if(options.method==='POST'){
  post++;
  const dir=process.env.YOUTUBE_TRANSCRIPT_JOB_DIR;
  const records=await Promise.all((await readdir(dir)).filter(n=>n.endsWith('.json')).map(n=>readFile(path.join(dir,n),'utf8').then(JSON.parse)));
  assert.ok(records.some(r=>['starting','submitting'].includes(r.phase)),'POST must be durably fenced');
  if(mode==='quota'||mode==='longquota')return{ok:false,status:429,headers:new Headers({'Retry-After':mode==='longquota'?'120':'0'}),json:async()=>({error:{message:'Quota fixture'}})};
  return{ok:true,status:200,headers:new Headers(),json:async()=>({id:'v1_recovery_'+post,status:'in_progress'})};
 }
 gets++;return{ok:true,status:200,headers:new Headers(),json:async()=>({status:'completed',output_text:transcript})};
};
const failures=[];let cases=0;
async function check(name,fn){cases++;try{process.env.YOUTUBE_TRANSCRIPT_JOB_DIR=await mkdtemp(path.join(root,'case-'));await fn();console.log('PASS '+name);}catch(e){failures.push(name+': '+e.message);console.log('FAIL '+name+': '+e.message);}}
try{
 await check('proven no-POST missing key failure resumes with same token after correction',async()=>{
  mode='success';const before=post;delete process.env.GEMINI_API_KEY;
  let paused;
  try{paused=await jobs.startPersistentTranscriptionJob({url:'New00000001',durationSeconds:60});}finally{process.env.GEMINI_API_KEY='fixture-recovery-api';}
  assert.equal(post,before);assert.equal(paused.status,'blocked');assert.equal(paused.providerStatus,'not_submitted');assert.equal(paused.retryable,true);
  const resumed=await jobs.getPersistentTranscriptionJob(paused.jobToken);assert.equal(post,before+1);assert.equal(resumed.jobToken,paused.jobToken);
  const done=await jobs.getPersistentTranscriptionJob(resumed.jobToken);assert.equal(done.status,'completed');
 });
 await check('interrupted acquisition is resumed, not unknown; readOnly sends no POST',async()=>{
  mode='budget';const dir=process.env.YOUTUBE_TRANSCRIPT_JOB_DIR,id='a'.repeat(64),now=Date.now();
  await writeFile(path.join(dir,'yt:transcript:job:v2:'+id+'.json'),JSON.stringify({version:2,phase:'acquiring',owner:'crashed-acquisition',createdAt:now-999999,updatedAt:now-999999,videoId:'New00000002',language:'ko-KR',startArgs:{url:'New00000002',durationSeconds:60},acquisitionClaimUntil:now-1}));
  const before=post;const read=await jobs.getPersistentTranscriptionJob(token(id),{readOnly:true});assert.equal(read.providerStatus,'not_submitted');assert.equal(post,before);
  const resumed=await jobs.getPersistentTranscriptionJob(token(id));assert.equal(resumed.status,'in_progress');assert.equal(post,before+1);
  const record=JSON.parse(await readFile(path.join(dir,'yt:transcript:job:v2:'+id+'.json'),'utf8'));assert.equal(record.phase,'active');
 });
 await check('four initial POST429 failures retain cooldown and forbid early rePOST',async()=>{
  mode='quota';const before=post,started=Date.now();
  const limited=await jobs.startPersistentTranscriptionJob({url:'New00000003',durationSeconds:60});
  assert.equal(post,before+4);assert.equal(limited.status,'rate_limited');assert.equal(limited.shouldPoll,false);assert.equal(limited.retryable,true);assert.ok(limited.nextStatusCheckAt>=started+30000);assert.match(limited.segments[0].lastPostError,/429/);
  await jobs.getPersistentTranscriptionJob(limited.jobToken);assert.equal(post,before+4);
  await jobs.getPersistentTranscriptionJob(limited.jobToken,{readOnly:true});assert.equal(post,before+4);
 });
 await check('long Retry-After uses a clock/sleep spy; same job recovers only after cooldown',async()=>{
  mode='longquota';const before=post,realNow=Date.now,realTimer=global.setTimeout;let offset=0,sleeps=[];
  Date.now=()=>realNow()+offset;
  global.setTimeout=(callback,delay,...args)=>{
    if(delay>=100000){sleeps.push(delay);offset+=delay;return realTimer(callback,0,...args);}
    return realTimer(callback,delay,...args);
  };
  try{
   const started=Date.now();const limited=await jobs.startPersistentTranscriptionJob({url:'New00000004',durationSeconds:60});
   assert.equal(post,before+1);assert.equal(limited.status,'rate_limited');assert.ok(limited.nextStatusCheckAt>=started+120000);assert.deepEqual(sleeps,[],'Retry-After must be returned as state, not slept inside the request');
   await jobs.getPersistentTranscriptionJob(limited.jobToken);assert.equal(post,before+1);
   offset=limited.nextStatusCheckAt-realNow()+1;mode='success';
   await jobs.getPersistentTranscriptionJob(limited.jobToken,{readOnly:true});assert.equal(post,before+1,'readOnly after cooldown must not POST');
   const resumed=await jobs.getPersistentTranscriptionJob(limited.jobToken);assert.equal(post,before+2);assert.equal(resumed.status,'in_progress');assert.equal(resumed.segments[0].cooldownSkipped,undefined);assert.equal(resumed.segments[0].lastPostError,undefined);
   const completed=await jobs.getPersistentTranscriptionJob(limited.jobToken);assert.equal(completed.status,'completed');assert.equal(post,before+2);
  }finally{Date.now=realNow;global.setTimeout=realTimer;}
 });
 await check('unrelated corrupt legacy file preserved; repeated misses avoid full-store rereads',async()=>{
  mode='captions';const dir=process.env.YOUTUBE_TRANSCRIPT_JOB_DIR;
  for(let i=0;i<120;i++){
   const videoId='Old'+String(i).padStart(8,'0'),id=createHash('sha256').update('legacy-'+i).digest('hex');
   await writeFile(path.join(dir,'yt:transcript:job:v2:'+id+'.json'),JSON.stringify({version:2,phase:'completed',owner:'legacy',createdAt:1,updatedAt:2,videoId,language:'en-US',result:{...complete,videoId}}));
  }
  const corrupt=path.join(dir,'yt:transcript:job:v2:'+'b'.repeat(64)+'.json');await writeFile(corrupt,'broken-json');
  const original=fsp.readFile;let reads=0;fsp.readFile=async(...args)=>{reads++;return original(...args);};
  try{
   const first=await jobs.startPersistentTranscriptionJob({url:'New00000005',durationSeconds:60});assert.equal(first.status,'completed');assert.match(first.readWarning,/legacy.*cannot be fully verified/);
   const before=reads;const second=await jobs.startPersistentTranscriptionJob({url:'New00000006',durationSeconds:60});assert.equal(second.status,'completed');assert.ok(reads-before<20,`second miss read ${reads-before} files`);
  }finally{fsp.readFile=original;}
  assert.equal(await readFile(corrupt,'utf8'),'broken-json');
 });
 await check('caption invocation budget is not whole-job failure',async()=>{
  mode='budget';const before=post;const pending=await jobs.startPersistentTranscriptionJob({url:'New00000007',durationSeconds:60});assert.equal(post,before+1);assert.equal(pending.status,'in_progress');
  const done=await jobs.getPersistentTranscriptionJob(pending.jobToken);assert.equal(done.status,'completed');
 });
}finally{await rm(root,{recursive:true,force:true});}
console.log(JSON.stringify({status:failures.length?'FAIL':'PASS',cases,failures,fixtureProviderPost:post,fixtureProviderGet:gets,liveProviderCalls:0}));if(failures.length)process.exitCode=1;
