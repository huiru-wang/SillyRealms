/** A preview document must never execute with the Studio origin. */
export function worldPreviewURL(origin:string,host:string,nonce:string):URL {
 const parent=new URL(host),target=new URL(origin);
 if(!['http:','https:'].includes(target.protocol)||target.origin!==origin||target.username||target.password)throw Error('世界预览来源配置无效');
 if(parent.origin===target.origin)throw Error('世界预览必须使用独立来源');
 if(parent.protocol==='https:'&&target.protocol!=='https:')throw Error('HTTPS 主站需要 HTTPS 预览来源');
 const url=new URL('/world-component.html',target);url.searchParams.set('hostOrigin',parent.origin);url.hash=nonce;return url;
}
