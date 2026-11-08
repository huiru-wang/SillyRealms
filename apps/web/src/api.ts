export async function api(path:string,options:RequestInit={}) {
  const response=await fetch('/api/'+path,{...options,headers:{...(options.body&&!(options.body instanceof FormData)?{'content-type':'application/json'}:{}),...options.headers}});
  const result=await response.json();
  if(!response.ok || result.code!=='OK')throw Error((result.code??'INVALID_RESPONSE')+': '+(result.message??'请求失败'));
  return result.data;
}
export const json=(data:unknown)=>JSON.stringify(data);
