const assert=require('node:assert/strict');
const fs=require('node:fs');
const http=require('node:http');
const path=require('node:path');
const vm=require('node:vm');
let row=null,failReads=0,failWrites=0,blockNextRead=false,releaseRead=null,oversizeRead=false,malformedInsert=false;
const calls=[];
const server=http.createServer((req,res)=>{
  const url=new URL(req.url,'http://127.0.0.1');let raw='';req.on('data',(c)=>raw+=c);req.on('end',async()=>{
    calls.push({method:req.method,path:url.pathname+url.search,auth:req.headers.authorization,key:req.headers.apikey,prefer:req.headers.prefer});
    if(url.pathname==='/auth/v1/token'){res.writeHead(200,{'Content-Type':'application/json'}).end(JSON.stringify({access_token:'cloud-access-memory-only',refresh_token:'cloud-refresh-memory-only',user:{id:'user-a',email:'cloud@example.test'}}));return;}
    if(url.pathname==='/auth/v1/logout'){res.writeHead(204).end();return;}
    if(url.pathname==='/rest/v1/leaseq_workspaces'&&req.method==='GET'){
      if(blockNextRead){blockNextRead=false;await new Promise((resolve)=>releaseRead=resolve);}
      if(oversizeRead){oversizeRead=false;res.writeHead(200,{'Content-Type':'application/json'}).end(' '.repeat(70000));return;}
      if(failReads-->0){res.writeHead(503,{'Content-Type':'application/json'}).end('{}');return;}
      if(!row||url.searchParams.get('user_id')!==`eq.${row.user_id}`){res.writeHead(200,{'Content-Type':'application/json'}).end('[]');return;}
      res.writeHead(200,{'Content-Type':'application/json'}).end(JSON.stringify([row]));return;
    }
    if(url.pathname==='/rest/v1/leaseq_workspaces'&&req.method==='POST'){
      if(failWrites-- >0){res.writeHead(503,{'Content-Type':'application/json'}).end('{}');return;}
      if(row){res.writeHead(409,{'Content-Type':'application/json'}).end('{}');return;}
      row=JSON.parse(raw);const reply=malformedInsert?[{...row,revision:2}]:[row];malformedInsert=false;res.writeHead(201,{'Content-Type':'application/json'}).end(JSON.stringify(reply));return;
    }
    if(url.pathname==='/rest/v1/leaseq_workspaces'&&req.method==='PATCH'){
      const revision=Number(url.searchParams.get('revision')?.replace('eq.',''));
      if(!row||row.user_id!=='user-a'||url.searchParams.get('user_id')!=='eq.user-a'||row.revision!==revision){res.writeHead(200,{'Content-Type':'application/json'}).end('[]');return;}
      row={...row,...JSON.parse(raw)};res.writeHead(200,{'Content-Type':'application/json'}).end(JSON.stringify([row]));return;
    }
    res.writeHead(404).end();
  });
});
const listen=()=>new Promise((resolve)=>server.listen(0,'127.0.0.1',()=>resolve(server.address().port)));
const close=()=>new Promise((resolve)=>server.close(resolve));
(async()=>{
 const port=await listen();const base=`http://127.0.0.1:${port}`;
 const storage=new Map();const browser={window:{LeaseQProfiles:{validateData(v){const keys=['theme','submitDraft','submitText','submitFields','guestSimulation'];if(!v||typeof v!=='object'||Array.isArray(v)||Object.keys(v).some(k=>!keys.includes(k)))throw Error('unsafe sync data');return JSON.parse(JSON.stringify(v));}}},fetch,URL,URLSearchParams,AbortController,TextEncoder,TextDecoder,Error,JSON,Object,Array,Number,String,Set,Map,Promise,setTimeout,clearTimeout,Date,atob,localStorage:{setItem:(k,v)=>storage.set(k,v)}};
 vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../../leaseq/dashboard/assets/sync.js'),'utf8'),browser);
 const Sync=browser.window.LeaseQSync;let checks=0;const check=(fn)=>{fn();checks++;};
 check(()=>assert.equal(Sync.endpointOrigin(base),base));
 check(()=>assert.throws(()=>Sync.endpointOrigin('http://example.test'),/HTTPS/));
 check(()=>assert.throws(()=>Sync.endpointOrigin(base+'/path'),/origin only/));
 check(()=>assert.throws(()=>Sync.endpointOrigin('https://user:pass@example.test'),/origin only/));
 const encoded=Buffer.from(JSON.stringify({role:'service_role'})).toString('base64url');
 check(()=>assert.throws(()=>new Sync.SupabaseRlsProvider(base,`x.${encoded}.sig`),/service_role/));
 check(()=>assert.throws(()=>new Sync.SupabaseRlsProvider(base,'sb_secret_forbidden'),/secret key is forbidden/));
 const p=new Sync.SupabaseRlsProvider(base,'publishable-anon-key');
 const user=await p.signIn('cloud@example.test','cloud-password');
 check(()=>assert.equal(user.userId,'user-a'));
 check(()=>assert.equal(calls.at(-1).key,'publishable-anon-key'));
 check(()=>assert.equal(calls.at(-1).auth,undefined));
 failReads=1;const missing=await p.read();check(()=>assert.equal(missing,null));
 check(()=>assert.equal(calls.filter(c=>c.method==='GET').length,2));
 const data={theme:'dark',guestSimulation:{state:'done',attempts:1,maxAttempts:3,events:['completed'],text:'two words',result:{words:2,lines:1}}};
 let r=await p.sync(data);check(()=>assert.deepEqual(JSON.parse(JSON.stringify(r)),{ok:true,revision:1}));
 check(()=>assert.equal(calls.at(-1).prefer,'return=representation'));
 r=await p.sync(data);check(()=>assert.deepEqual(JSON.parse(JSON.stringify(r)),{ok:true,unchanged:true,revision:1}));
 const reordered={guestSimulation:{result:{lines:1,words:2},text:'two words',maxAttempts:3,attempts:1,events:['completed'],state:'done'},theme:'dark'};
 r=await p.sync(reordered);check(()=>assert.equal(r.unchanged,true));
 r=await p.sync({theme:'light'});check(()=>assert.equal(r.conflict,true));check(()=>assert.equal(r.remote.revision,1));
 r=await p.write({theme:'light'},1);check(()=>assert.equal(r.ok,true));check(()=>assert.equal(r.revision,2));
 r=await p.deleteRemote(2);check(()=>assert.equal(r.deleted,true));
 const tombstone=await p.read();check(()=>assert.equal(tombstone.deleted,true));
 r=await p.sync(data);check(()=>assert.equal(r.conflict,true));
 r=await p.write(data,3);check(()=>assert.equal(r.revision,4));
 const restored=await p.read();check(()=>assert.equal(restored.deleted,false));
 const previousRow=row;row=null;
 const absentRevision=await p.write(data,4);
 check(()=>assert.deepEqual(JSON.parse(JSON.stringify(absentRevision)),{ok:false,conflict:true,remote:null}));
 check(()=>assert.equal(row,null));row=previousRow;
 row=null;malformedInsert=true;
 await assert.rejects(p.write(data,null),/unexpected workspace row/);checks++;
 row=null;oversizeRead=true;
 await assert.rejects(p.read(),/65,536-byte limit/);checks++;
 row=previousRow;
 await assert.rejects(p.write({token:'forbidden'},4),/unsafe sync data/);checks++;
 await assert.rejects(p.write({submitDraft:'x'.repeat(17000)},4),/16,000-byte/);checks++;
 check(()=>assert(calls.every((c)=>c.auth===undefined||c.auth==='Bearer cloud-access-memory-only')));
 check(()=>assert.equal([...storage.values()].some(v=>String(v).includes('cloud-access-memory-only')),false));
 blockNextRead=true;const pending=p.read();await new Promise(setImmediate);p.logoutLocal();releaseRead?.();await assert.rejects(pending,/canceled|aborted/i);checks++;
 check(()=>assert.equal(p.session,null));
 await p.signIn('cloud@example.test','cloud-password');await p.logout();
 check(()=>assert.equal(p.session,null));check(()=>assert.equal(calls.at(-1).path,'/auth/v1/logout'));
 console.log(JSON.stringify({checks,requests:calls.length}));
 await close();
})().catch(async(e)=>{console.error(e);await close();process.exitCode=1;});
