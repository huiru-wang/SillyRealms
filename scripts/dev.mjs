import {spawn} from 'node:child_process';
const grouped=process.platform!=='win32';
const commands=[...(!process.argv.includes('--studio')?[['@sillyrealms/server','dev']]:[]),['@sillyrealms/studio','dev:host'],['@sillyrealms/studio','dev:stage']];
const children=commands.map(([name,script])=>spawn('pnpm',['--filter',name,script],{stdio:'inherit',detached:grouped}));
let stopping=false;
function stop(){if(stopping)return;stopping=true;for(const child of children){try{if(grouped&&child.pid)process.kill(-child.pid,'SIGTERM');else child.kill('SIGTERM');}catch{ /* Already exited. */ }}}
for(const signal of ['SIGINT','SIGTERM'])process.once(signal,stop);
for(const child of children){child.once('error',error=>{console.error(error.message);process.exitCode=1;stop();});child.once('exit',code=>{if(!stopping){process.exitCode=code??1;stop();}});}
