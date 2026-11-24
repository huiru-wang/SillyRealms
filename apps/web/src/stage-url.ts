export function stageURL(config:unknown,host:string,nonce:string):URL {
  const stage=(config as {stage?:{origin?:unknown;entryPath?:unknown}}|null)?.stage;
  if(!stage||stage.entryPath!=='/frame.html'||typeof stage.origin!=='string')throw Error('stage:host.invalidAddress');
  let parent:URL,origin:URL;
  try{parent=new URL(host);origin=new URL(stage.origin);}
  catch{throw Error('stage:host.invalidAddress');}
  if(origin.origin!==stage.origin)throw Error('stage:host.invalidAddress');
  if(!['http:','https:'].includes(origin.protocol)||origin.username||origin.password||origin.pathname!=='/'||origin.search||origin.hash)throw Error('stage:host.invalidAddress');
  if(origin.origin===parent.origin)throw Error('stage:host.separateOrigin');
  if(parent.protocol==='https:'&&origin.protocol!=='https:')throw Error('stage:host.httpsRequired');
  const url=new URL('/frame.html',origin);
  url.searchParams.set('hostOrigin',parent.origin);url.hash=nonce;
  return url;
}

/** Same isolated asset origin, separate readonly runtime and Host bridge. */
export function worldComponentURL(config:unknown,host:string,nonce:string):URL {
  const url=stageURL(config,host,nonce);
  url.pathname='/world-component.html';
  return url;
}
