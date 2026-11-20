import {spawn} from 'node:child_process';
const grouped=process.platform!=='win32';
const built = process.argv.includes('--built');
const commands = [
  ['@sillyrealms/studio-v2', built ? 'preview' : 'dev'],
  ['@sillyrealms/studio-v2', built ? 'preview:world-preview' : 'dev:world-preview'],
];
if (!process.argv.includes('--studio')) commands.unshift(['@sillyrealms/server-v2', built ? 'start' : 'dev']);
const children=commands.map(([name,script])=>spawn('pnpm',['--filter',name,script],{stdio:'inherit',detached:grouped}));
let stopping=false;
function stop(){if(stopping)return;stopping=true;for(const child of children){try{if(grouped&&child.pid)process.kill(-child.pid,'SIGTERM');else child.kill('SIGTERM');}catch{ /* Already exited. */ }}}
for(const signal of ['SIGINT','SIGTERM'])process.once(signal,stop);
for(const child of children){child.once('error',error=>{console.error(error.message);process.exitCode=1;stop();});child.once('exit',code=>{if(!stopping){process.exitCode=code??1;stop();}});}
