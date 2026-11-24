import {i18n} from '../../i18n/instance.ts';
/** A preview document must never execute with the Web origin. */
export function worldPreviewURL(origin:string,host:string,nonce:string):URL {
 const parent=new URL(host),target=new URL(origin);
 if(!['http:','https:'].includes(target.protocol)||target.origin!==origin||target.username||target.password)throw Error(i18n.t('worlds:invalidWorldPreviewOrigin'));
 if(parent.origin===target.origin)throw Error(i18n.t('worlds:worldPreviewsRequireASeparateOrigin'));
 if(parent.protocol==='https:'&&target.protocol!=='https:')throw Error(i18n.t('worlds:anHttpsHostRequiresAnHttpsPreview'));
 const url=new URL('/world-component.html',target);url.searchParams.set('hostOrigin',parent.origin);url.hash=nonce;return url;
}
