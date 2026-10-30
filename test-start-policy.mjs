import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdtemp,readFile,writeFile,readdir,rename,rm} from 'node:fs/promises';
import {createHmac} from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
const require=createRequire(import.meta.url);
let output;
try { output=require('./test-output/youtube-response-output.js'); }
catch(e) { if(e.code!=='MODULE_NOT_FOUND')throw e; output={sanitizeTranscriptResult:r=>r}; }
const wrap=output.sanitizeTranscriptResult;
const yt=require('./test-output/yt-dlp.js');
const jobs=require('./test-output/job-store.js');
const dir=await mkdtemp(path.join(os.tmpdir(),'yt-start-policy-'));
process.env.YOUTUBE_TRANSCRIPT_JOB_BACKEND='local';
process.env.YOUTUBE_TRANSCRIPT_JOB_DIR=dir;
process.env.YOUTUBE_TRANSCRIPT_JOB_SIGNING_KEY='fixture-start-policy-key';
process.env.GEMINI_API_KEY='fixture-start-policy-provider-key';
let providerPost=0,providerGet=0,captions=0;
let captionMode='success';
const transcript='[00:00:01] Complete first proposition.\n[00:03:01] Complete final proposition.';
yt.getYouTubeCaptionsWithYtDlp=async()=>{
  captions++;
  if(captionMode!=='success')throw new yt.YtDlpCaptionError('fixture caption unavailable',captionMode);
  return {transcript};
};
global.fetch=async(url,options={})=>{
  assert.match(String(url),/^https:\/\/generativelanguage\.googleapis\.com\/v1beta\/interactions(?:\/v1_\w+)?$/,'No live or unrelated network is allowed');
  const post=options.method==='POST';
  if(post)providerPost++;else providerGet++;
  return {ok:true,status:200,headers:new Headers(),json:async()=>post?{id:'v1_fixture_'+providerPost,status:'in_progress'}:{status:'completed',output_text:transcript}};
};
const failures=[];let cases=0;
async function check(name,fn){cases++;try{await fn();console.log('PASS '+name);}catch(e){failures.push(name+': '+e.message);console.log('FAIL '+name+': '+e.message);}finally{process.env.YOUTUBE_TRANSCRIPT_JOB_DIR=dir;}}
function checkPolicy(r){
  assert.equal(r.status,'completed');
  for (const field of ['responsePolicyVersion','responseDirective','responseContract']) assert.equal(r[field],undefined,field+' belongs to the separate skill');
  assert.equal(typeof r.transcript,'string');
  assert.ok(r.transcript.length>0);
}

try {
  await check('only check/start/get_job registration and shared wrapper',async()=>{
    const src=await readFile('app/mcp/route.ts','utf8');
    assert.deepEqual([...src.matchAll(/server\.registerTool\(\s*"([^"]+)"/g)].map(x=>x[1]),['check_connection','start_youtube_transcript_job','get_youtube_transcript_job']);
    assert.equal((src.match(/sanitizeTranscriptResult\(await /g)||[]).length,2);
    assert.ok(!src.includes('getCachedYouTubeTranscript'));
  });
  const args={url:'https://youtu.be/5k0tCrXdIIM',language:'en-US',durationSeconds:190};
  let immediate=await jobs.startPersistentTranscriptionJob(args);
  await check('caption immediate completion has verified source data; Gemini zero',async()=>{checkPolicy(wrap(immediate));assert.equal(providerPost,0);assert.equal(immediate.source,'yt-dlp');});
  await check('normalized video/language and changed hints reuse completion',async()=>{
    const before=captions;
    const cached=await jobs.startPersistentTranscriptionJob({...args,url:'https://www.youtube.com/watch?v=5k0tCrXdIIM&t=90',language:' EN-us ',durationSeconds:999,chunkSeconds:300});
    assert.equal(cached.jobToken,immediate.jobToken);assert.equal(captions,before);assert.equal(providerPost,0);
    assert.equal(cached.cacheKey,'5k0tCrXdIIM:en-us');checkPolicy(wrap(cached));
  });
  await check('stored completed/restart applies source data without persisted stale writing policy',async()=>{
    const name=(await readdir(dir)).find(n=>n.endsWith('.json'));
    const f=path.join(dir,name),record=JSON.parse(await readFile(f,'utf8'));
    record.result.responsePolicyVersion='stale';record.result.responseDirective='stale';record.result.responseContract={stale:true};
    await writeFile(f,JSON.stringify(record));
    const before=providerPost+providerGet;
    const resumed=await jobs.getPersistentTranscriptionJob(immediate.jobToken,{readOnly:true});
    checkPolicy(wrap(resumed));assert.equal(providerPost+providerGet,before);
  });
  await check('single start falls back when yt-dlp executable unavailable; active duplicate POST zero',async()=>{
    captionMode='executable_unavailable';
    const a={url:'G-8cDsHLrD0',language:'ko-KR',durationSeconds:60};
    const before=providerPost;
    const pending=await jobs.startPersistentTranscriptionJob(a);
    assert.equal(providerPost,before+1);assert.notEqual(pending.status,'completed');assert.equal(wrap(pending).responseContract,undefined);
    const duplicate=await jobs.startPersistentTranscriptionJob({...a,url:'https://youtu.be/G-8cDsHLrD0',language:' KO-kr ',durationSeconds:120,chunkSeconds:300});
    assert.equal(duplicate.jobToken,pending.jobToken);assert.equal(providerPost,before+1);
    const done=await jobs.getPersistentTranscriptionJob(pending.jobToken);checkPolicy(wrap(done));
    const again=await jobs.startPersistentTranscriptionJob(a);checkPolicy(wrap(again));assert.equal(providerPost,before+1);
  });
  await check('legacy acquisition-key completion reused; old signed token still valid',async()=>{
    process.env.YOUTUBE_TRANSCRIPT_JOB_DIR=await mkdtemp(path.join(dir,'legacy-complete-'));
    const legacyDir=process.env.YOUTUBE_TRANSCRIPT_JOB_DIR;
    const id='2glIuHz77IY';
    const payload=JSON.stringify({videoId:id,language:'en-us',durationSeconds:100,chunkSeconds:240,geminiFileUri:null,geminiMimeType:null});
    const hash=createHmac('sha256',process.env.YOUTUBE_TRANSCRIPT_JOB_SIGNING_KEY).update(payload).digest('hex');
    const token='ytj2.'+hash+'.'+createHmac('sha256',process.env.YOUTUBE_TRANSCRIPT_JOB_SIGNING_KEY).update('ytj2.'+hash).digest('base64url');
    const result={...immediate,videoId:id,canonicalUrl:'https://www.youtube.com/watch?v='+id};
    await writeFile(path.join(legacyDir,'yt:transcript:job:v2:'+hash+'.json'),JSON.stringify({version:2,phase:'completed',owner:'legacy-fixture',createdAt:1,updatedAt:2,videoId:id,language:'en-US',result}));
    const before=captions+providerPost+providerGet;
    const hit=await jobs.startPersistentTranscriptionJob({url:id,language:'EN-us'});
    assert.equal(hit.jobToken,token);checkPolicy(wrap(hit));checkPolicy(wrap(await jobs.getPersistentTranscriptionJob(token)));
    assert.equal(captions+providerPost+providerGet,before);
    process.env.YOUTUBE_TRANSCRIPT_JOB_DIR=dir;
  });
  await check('noncomplete/error/empty/partial completion never receives writing policy or text cache',async()=>{
    for(const status of ['queued','in_progress','failed','cancelled','incomplete','requires_action','rate_limited','blocked']){
      const r=wrap({...immediate,status,responseContract:{stale:true},responsePolicyVersion:'old',responseDirective:'old'});
      assert.equal(r.responseContract,undefined);assert.equal(r.transcript,undefined);assert.equal(r.cacheProvider,undefined);
    }
    for(const bad of [{transcript:''},{completedSegments:0},{segments:[]},{transcript:'---\ntitle: Metadata only\n---'}]){
      const r=wrap({...immediate,...bad});assert.notEqual(r.status,'completed');assert.equal(r.responseContract,undefined);assert.equal(r.transcript,undefined);
    }
  });
  await check('concurrent normalized starts reserve only one provider interaction',async()=>{
    captionMode='no_captions';const before=providerPost;
    const starts=await Promise.all(Array.from({length:8},(_,n)=>jobs.startPersistentTranscriptionJob({url:n%2?'https://youtu.be/5LNRvdyzmrY':'5LNRvdyzmrY',language:n%2?'ko-KR':' KO-kr ',durationSeconds:60+n,chunkSeconds:240+n})));
    assert.equal(providerPost,before+1);assert.ok(starts.every(r=>r.jobToken===starts[0].jobToken));
  });
  await check('legacy active job resumes without another provider POST',async()=>{
    captionMode='no_captions';const before=providerPost;
    const pending=await jobs.startPersistentTranscriptionJob({url:'R4Oe98D7yMU',language:'en-US',durationSeconds:60});
    assert.equal(providerPost,before+1);
    const currentId=pending.jobToken.split('.')[1];
    const legacyId=createHmac('sha256',process.env.YOUTUBE_TRANSCRIPT_JOB_SIGNING_KEY).update(JSON.stringify({videoId:'R4Oe98D7yMU',language:'en-us',durationSeconds:60,chunkSeconds:240,geminiFileUri:null,geminiMimeType:null})).digest('hex');
    await rename(path.join(dir,'yt:transcript:job:v2:'+currentId+'.json'),path.join(dir,'yt:transcript:job:v2:'+legacyId+'.json'));
    const resumed=await jobs.startPersistentTranscriptionJob({url:'https://youtu.be/R4Oe98D7yMU',language:' EN-us ',durationSeconds:60});
    assert.equal(resumed.jobToken.split('.')[1],legacyId);assert.equal(providerPost,before+1);
    checkPolicy(wrap(await jobs.getPersistentTranscriptionJob(resumed.jobToken)));assert.equal(providerPost,before+1);
  });
  await check('access-restricted video does not trigger fallback provider POST',async()=>{
    captionMode='video_unavailable';const before=providerPost;
    const denied=await jobs.startPersistentTranscriptionJob({url:'bdFgK45TuPA',durationSeconds:60});assert.equal(denied.status,'failed');assert.equal(providerPost,before);
  });
} finally {await rm(dir,{recursive:true,force:true});}
console.log(JSON.stringify({status:failures.length?'FAIL':'PASS',cases,failures,providerPost,providerGet,liveProviderCalls:0}));
if(failures.length)process.exitCode=1;
