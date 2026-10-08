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
assert.equal(retry.status,'in_progress');assert.equal(retry.segments[0].modelIndex,1);
assert.notEqual(retry.jobToken,recover.jobToken);
queue=[reply({status:'completed',steps:[{type:'model_output',content:[{type:'text',text:'[00:00:01] 화자: 성공'}]}]})];
const ready=await getGeminiTranscriptionJob(retry.jobToken);
assert.equal(ready.status,'completed');

// Files API URI uses native physical clip offsets instead of YouTube prompt scoping.
queue=[reply({id:'v1_gemfile',status:'in_progress'})];
const fileJob=await startGeminiTranscriptionJob({url:'G-8cDsHLrD0',durationSeconds:60,
   geminiFileUri:'https://generativelanguage.googleapis.com/v1beta/files/abc123',geminiMimeType:'video/mp4'});
assert.equal(fileJob.segmentation,'file-clips');
assert.deepEqual(calls.at(-1).payload.input[0].processing,{type:'static',start_offset:0,end_offset:60});
assert.equal(calls.at(-1).payload.input[0].mime_type,'video/mp4');

console.log(JSON.stringify({status:'PASS',cases:['503 backoff','YouTube time-window scopes','all-segment assembly','signed token rejection','empty-result rejection','provider failed retry + model fallback','Gemini Files native clipping'],completed_segments:completed.totalSegments,recovered_model:retry.segments[0].model},null,2));
