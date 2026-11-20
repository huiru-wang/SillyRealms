import {expect,it} from 'vitest';
import {allowApiOrigin,parseWebOrigin} from './origin.js';
const host='http://127.0.0.1:5176',preview='http://127.0.0.1:5177',base='http://127.0.0.1:3001';
it('allows resources to preview documents while denying management reads and writes',()=>{
 expect(allowApiOrigin(preview,base+'/api/v1/worlds/id/resources/assets/a.png','GET',host)).toBe(true);
 expect(allowApiOrigin(preview,base+'/api/v1/worlds/id/resources/assets/a.png','POST',host)).toBe(false);
 for(const method of ['GET','POST','PATCH','DELETE'])expect(allowApiOrigin(preview,base+'/api/v1/worlds/id',method,host)).toBe(false);
 expect(allowApiOrigin(host,base+'/api/v1/worlds/id','PATCH',host)).toBe(true);
 expect(allowApiOrigin(undefined,base+'/api/v1/worlds','GET',host)).toBe(true);
 expect(allowApiOrigin('null',base+'/api/v1/worlds','GET',host)).toBe(false);
});
it('requires a canonical trusted web origin',()=>{
 expect(parseWebOrigin(host)).toBe(host);
 for(const value of [host+'/path','file:///tmp','https://user:pass@example.com'])expect(()=>parseWebOrigin(value)).toThrow();
});
