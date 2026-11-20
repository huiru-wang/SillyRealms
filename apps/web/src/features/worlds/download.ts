
export async function readWorldDownload(response:Response,fallback:string){
 if(!response.ok){
  const error=await response.json().catch(()=>null) as {errorCode?:string;errorMessage?:string}|null;
  throw new Error(error?.errorMessage??'下载失败，请重试');
 }
 const disposition=response.headers.get('Content-Disposition');
 if(!disposition?.startsWith('attachment;'))throw new Error('下载响应无效');
 let name=fallback;
 const encoded=/filename\*=UTF-8''([^;]+)/i.exec(disposition),plain=/filename="([^"]+)"/.exec(disposition);
 if(encoded){try{name=decodeURIComponent(encoded[1]);}catch{}}else if(plain)name=plain[1];
 return {blob:await response.blob(),filename:name.replace(/[\\/\x00-\x1f]/g,'_')};
}
export async function downloadWorld(id:string,kind:'export'|'original'){
 const result=await readWorldDownload(await fetch('/api/v1/worlds/'+encodeURIComponent(id)+'/'+kind),kind==='export'?'world.zip':'original.json');
 const url=URL.createObjectURL(result.blob),link=document.createElement('a');link.href=url;link.download=result.filename;
 document.body.append(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);
}
