import {createServer} from 'node:https';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {randomBytes,createHash,X509Certificate} from 'node:crypto';

// A controlled HTTPS image allowed by the unchanged Stage CSP. No public CDN dependency.
export async function cacheImageServer(directory){
 const key=join(directory,'image-key.pem'),cert=join(directory,'image-cert.pem');
 await promisify(execFile)('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',key,'-out',cert,'-days','1','-subj','/CN=localhost','-addext','subjectAltName=IP:127.0.0.1']);
 const certificate=await readFile(cert);
 // Trust only this ephemeral test key in the isolated Chrome profile. A blanket
 // ignore-certificate-errors leaves cert errors that disable Chrome's HTTP cache.
 const spki=createHash('sha256').update(new X509Certificate(certificate).publicKey.export({type:'spki',format:'der'})).digest('base64');
 const bytes=Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="green"/><!--'+randomBytes(128*1024).toString('hex')+'--></svg>');
 const requests=[];
 const server=createServer({key:await readFile(key),cert:certificate},(req,res)=>{
  const status=req.headers['if-none-match']==='"sr-cache-test"'?304:200;
  requests.push({url:req.url,status,bytes:status===200?bytes.length:0,cacheControl:req.headers['cache-control']??null,ifNoneMatch:req.headers['if-none-match']??null});
  res.writeHead(status,{'Content-Type':'image/svg+xml','Cache-Control':'public, max-age=3600','ETag':'"sr-cache-test"','Timing-Allow-Origin':'*',...(status===200?{'Content-Length':bytes.length}:{})});
  res.end(status===200?bytes:undefined);
 });
 await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve)});
 return {url:`https://127.0.0.1:${server.address().port}/image.svg`,spki,requests,size:bytes.length,close:()=>new Promise(resolve=>{server.close(resolve);server.closeAllConnections()})};
}
