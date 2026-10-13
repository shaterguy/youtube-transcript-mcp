#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
if (args.includes('--dump-single-json')) {
  const manual = args.some(value => value.includes('AAAAA000000')) ? {} : { ko:[{ext:'vtt'}] };
  console.log(JSON.stringify({id:'5k0tCrXdIIM',language:'ko',subtitles:manual,automatic_captions:{}}));
  process.exit(0);
}
const output = args[args.indexOf('-o')+1];
if (!output) process.exit(3);
const file=output.replace('%(id)s','5k0tCrXdIIM').replace('%(ext)s','vtt').replace('/.vtt','.ko.vtt');
fs.mkdirSync(path.dirname(file), {recursive:true});
fs.writeFileSync(file, 'WEBVTT\n\n00:00:01.000 --> 00:00:04.000\nOriginal caption sentence\n\n00:00:08.000 --> 00:00:10.000\nNext original sentence\n');
console.log('mock captions written');
