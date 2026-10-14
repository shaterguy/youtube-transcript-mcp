import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdtemp,rm,readFile,writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
const require=createRequire(import.meta.url);
const {startPersistentTranscriptionJob:start,getPersistentTranscriptionJob:get}=require('./test-output/job-store.js');
const directory=await mkdtemp(path.join(os.tmpdir(),'yt-transcript-flow-'));
process.env.GEMINI_API_KEY='fixture-flow-key';
process.env.YOUTUBE_TRANSCRIPT_JOB_SIGNING_KEY='fixture-flow-signing';
process.env.YOUTUBE_TRANSCRIPT_JOB_BACKEND='local';
process.env.YOUTUBE_TRANSCRIPT_JOB_DIR=directory;
const fixture=path.join(directory,'yt-dlp-fixture');
await writeFile(fixture,(await readFile(path.resolve('./test-yt-dlp-fixture.cjs'),'utf8')).replace(/^#![^\n]*/, '#!'+process.execPath),{mode:0o755});
process.env.YT_DLP_BIN=fixture;
let post=0,reads=0;
global.fetch=async(uri,options={})=>{
  assert.match(String(uri),/^https:\/\/generativelanguage\.googleapis\.com\/v1beta\/interactions(?:\/v1_flow)?$/);
  if(options.method==='POST'){post++;return {ok:true,status:200,headers:new Headers(),json:async()=>({id:'v1_flow',status:'in_progress'})};}
  reads++;return {ok:true,status:200,headers:new Headers(),json:async()=>({status:'completed',output_text:'[00:00:01] Gemini fixture transcript'})};
};
try{
 const caption=await start({url:'https://youtu.be/5k0tCrXdIIM',language:'ko-KR',durationSeconds:90});
 assert.equal(caption.source,'yt-dlp');assert.match(caption.transcript,/\[00:00:01\] Original caption sentence/);assert.equal(post,0);
 const pending=await start({url:'AAAAA000000',durationSeconds:90});assert.equal(post,1);assert.notEqual(pending.status,'completed');
 const fallback=await get(pending.jobToken);assert.equal(fallback.source,'gemini');assert.equal(fallback.transcript,'[00:00:01] Gemini fixture transcript');assert.equal(post,1);assert.equal(reads,1);
 console.log(JSON.stringify({transcript_flow:'PASS',caption_bypasses_gemini:true,single_start_fallback:true,fixtureProviderPost:post,liveProviderCalls:0}));
}finally{await rm(directory,{recursive:true,force:true});}
