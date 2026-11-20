export function parseTags(value:string):string[]{return [...new Set(value.split(/[,，\n]/).map(tag=>tag.trim()).filter(Boolean))];}
export function libraryReturn(value:string|null):string{
 const params=new URLSearchParams(value??'');
 const query=new URLSearchParams();for(const key of ['tag']){const item=params.get(key);if(item)query.set(key,item);}
 return '/worlds'+(query.size?'?'+query:'');
}
