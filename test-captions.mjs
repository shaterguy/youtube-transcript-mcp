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
