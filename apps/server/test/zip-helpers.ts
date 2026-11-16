import { fromBuffer, type Entry, type ZipFile as InputZip } from 'yauzl';
import { ZipFile } from 'yazl';

export async function zipFixture(entries:Array<{name:string;data:string|Buffer;mode?:number}>):Promise<Buffer> {
  const zip=new ZipFile();
  for(const entry of entries)zip.addBuffer(Buffer.isBuffer(entry.data)?entry.data:Buffer.from(entry.data),entry.name,{mode:entry.mode});
  const output:Buffer[]=[];
  const done=new Promise<Buffer>((resolve,reject)=>{
    zip.outputStream.on('data',(chunk:Buffer)=>output.push(chunk));
    zip.outputStream.on('end',()=>resolve(Buffer.concat(output)));
    zip.outputStream.on('error',reject);
    zip.on('error',reject);
  });
  zip.end();return done;
}
export async function unzipFixture(bytes:Uint8Array):Promise<Map<string,Buffer>> {
  const zip=await new Promise<InputZip>((resolve,reject)=>fromBuffer(Buffer.from(bytes),{lazyEntries:true},(error,value)=>error?reject(error):resolve(value!)));
  const files=new Map<string,Buffer>();
  await new Promise<void>((resolve,reject)=>{
    zip.on('error',reject);zip.on('end',resolve);
    zip.on('entry',(entry:Entry)=>{
      if(entry.fileName.endsWith('/')){zip.readEntry();return;}
      zip.openReadStream(entry,(error,stream)=>{
        if(error){reject(error);return;}
        const chunks:Buffer[]=[];
        stream!.on('data',(chunk:Buffer)=>chunks.push(chunk));
        stream!.on('error',reject);
        stream!.on('end',()=>{files.set(entry.fileName,Buffer.concat(chunks));zip.readEntry();});
      });
    });
    zip.readEntry();
  });
  return files;
}
export async function readExportedCard(response:Response):Promise<any> {
  const files=await unzipFixture(new Uint8Array(await response.arrayBuffer()));
  return JSON.parse(files.get('world.json')!.toString('utf8'));
}
