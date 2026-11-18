export function stageURL(config:unknown,host:string,nonce:string):URL {
  const stage=(config as {stage?:{origin?:unknown;port?:unknown;entryPath?:unknown}}|null)?.stage;
  if(!stage||stage.entryPath!=='/frame.html'||!Number.isInteger(stage.port)||Number(stage.port)<1||Number(stage.port)>65535)throw Error('故事舞台地址配置无效');
  const parent=new URL(host);
  let origin:URL;
  if(stage.origin===null){origin=new URL(parent.origin);origin.port=String(stage.port);}
  else {
    if(typeof stage.origin!=='string')throw Error('故事舞台地址配置无效');
    origin=new URL(stage.origin);
  }
  if(!['http:','https:'].includes(origin.protocol)||origin.username||origin.password||origin.pathname!=='/'||origin.search||origin.hash)throw Error('故事舞台地址配置无效');
  if(origin.origin===parent.origin)throw Error('故事舞台必须使用独立地址');
  if(parent.protocol==='https:'&&origin.protocol!=='https:')throw Error('HTTPS 主站需要 HTTPS 故事舞台地址');
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
