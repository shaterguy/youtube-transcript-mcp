import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { normalizeSubtitle } = require('./test-output/yt-dlp.js');
const rolling = [
 'WEBVTT', '',
 '00:00:00.000 --> 00:00:01.000', 'We start now', '',
 '00:00:01.000 --> 00:00:02.000', 'We start now with context', '',
 '00:00:02.000 --> 00:00:03.000', 'with context and meaning', '',
 '00:00:15.000 --> 00:00:16.000', 'We start now', '',
].join('\n');
const result=normalizeSubtitle(rolling);
assert.equal(result.cues,2);
assert.equal(result.transcript, '[00:00:00] We start now with context and meaning\n[00:00:15] We start now');
const srt='1\n00:00:03,000 --> 00:00:04,000\n반복 발화\n\n2\n00:00:09,000 --> 00:00:10,000\n반복 발화\n';
assert.equal(normalizeSubtitle(srt).transcript,'[00:00:03] 반복 발화\n[00:00:09] 반복 발화');
assert.throws(()=>normalizeSubtitle('WEBVTT\nNo timed cues'),/valid timed speech cues/);
console.log(JSON.stringify({caption_parser:'PASS',cases:3}));

// Verify that a public-client fallback works without credentials after a bot challenge.
const { getYouTubeCaptionsWithYtDlp } = require('./test-output/yt-dlp.js');
const { promises: fs } = await import('node:fs');
const { tmpdir } = await import('node:os');
const path = await import('node:path');
const directory=await fs.mkdtemp(path.join(tmpdir(),'yt-dlp-bot-test-'));
const fake=path.join(directory,'mock-ytdlp');
const src=`#!${process.execPath}
const fs=require('node:fs');
const args=process.argv.slice(2);
if (!args.includes('--extractor-args')) {
  process.stderr.write("ERROR: Sign in to confirm you're not a bot.\\n");
  process.exit(1);
}
if (args.includes('--dump-single-json')) {
  process.stdout.write(JSON.stringify({language:'ko', automatic_captions:{ko:[{ext:'vtt'}]}}));
} else {
  const i=args.indexOf('-o');
  if (i<0 || !args.includes('--write-auto-subs')) process.exit(3);
  const file=args[i+1].replace('%(id)s','5k0tCrXdIIM').replace('%(ext)s','ko.vtt');
  fs.writeFileSync(file,'WEBVTT\\n\\n00:00:01.000 --> 00:00:03.000\\n가상 발화\\n');
}
`;
await fs.writeFile(fake,src,{mode:0o755});
const prior=process.env.YT_DLP_BIN;
try {
  process.env.YT_DLP_BIN=fake;
  const output=await getYouTubeCaptionsWithYtDlp('5k0tCrXdIIM','ko');
  assert.equal(output.kind,'automatic');
  assert.equal(output.language,'ko');
  assert.equal(output.transcript,'[00:00:01] 가상 발화');
  console.log(JSON.stringify({caption_client_fallback:'PASS',cases:1}));
} finally {
  if(prior===undefined) delete process.env.YT_DLP_BIN; else process.env.YT_DLP_BIN=prior;
  await fs.rm(directory,{recursive:true,force:true});
}
