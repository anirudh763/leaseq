'use strict';
/* Optional Supabase Auth + RLS connector. No default endpoint, persisted key or automatic sync. */
(() => {
  const MAX_RESPONSE=65536, MAX_DATA=16000, MAX_KEY=4096;
  function endpointOrigin(value){
    if(typeof value!=='string'||value.length>2048)throw Error('Enter the Supabase project origin.');
    let url;try{url=new URL(value);}catch{throw Error('Enter a valid Supabase project origin.');}
    if(url.username||url.password||url.pathname!=='/'||url.search||url.hash)throw Error('Use the project origin only; paths, credentials, queries and fragments are not accepted.');
    if(url.protocol!=='https:'&&!(url.protocol==='http:'&&['localhost','127.0.0.1','[::1]'].includes(url.hostname)))throw Error('Use HTTPS for remote Supabase projects; HTTP is allowed only on loopback.');
    return url.origin;
  }
  function publicKey(value){
    if(typeof value!=='string'||!value.trim()||value.length>MAX_KEY)throw Error('Enter the Supabase publishable or anon key (maximum 4,096 characters).');
    const key=value.trim();
    if(key.startsWith('sb_secret_'))throw Error('A Supabase secret key is forbidden in browser code; use a publishable or legacy anon key.');
    try{const parts=key.split('.');if(parts.length===3){const payload=JSON.parse(atob(parts[1].replace(/-/g,'+').replace(/_/g,'/')));if(payload.role==='service_role')throw Error('A service_role/admin key is forbidden in browser code.');}}catch(error){if(error.message.includes('service_role'))throw error;}
    return key;
  }
  const sleep=(ms)=>new Promise((resolve)=>setTimeout(resolve,ms));
  const canonical=(value)=>JSON.stringify(value&&typeof value==='object'&&!Array.isArray(value)?Object.keys(value).sort().reduce((out,key)=>{out[key]=JSON.parse(canonical(value[key]));return out;},{}):Array.isArray(value)?value.map((item)=>JSON.parse(canonical(item))):value);
  async function boundedBody(response,controller){
    if(response.status===204)return '';
    if(!response.body||typeof response.body.getReader!=='function')throw Error('This browser cannot safely bound the Supabase response body.');
    const reader=response.body.getReader(),chunks=[];let size=0;
    try{
      while(true){
        const {done,value}=await reader.read();if(done)break;
        size+=value.byteLength;if(size>MAX_RESPONSE){controller.abort();try{await reader.cancel();}catch{}throw Object.assign(Error('Cloud response exceeds the 65,536-byte limit.'),{nonRetryable:true});}
        chunks.push(value);
      }
    }finally{try{reader.releaseLock();}catch{}}
    const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength;}
    return new TextDecoder('utf-8',{fatal:true}).decode(bytes);
  }
  class SupabaseRlsProvider{
    constructor(origin,key){this.origin=endpointOrigin(origin);this.anonKey=publicKey(key);this.session=null;this.controllers=new Set();this.epoch=0;}
    async request(path,{method='GET',body,auth=true,retries=method==='GET'?2:1,prefer=false}={}){
      if(path.startsWith('/')===false||path.startsWith('//'))throw Error('Invalid Supabase API path.');
      const epoch=this.epoch;let lastError;
      for(let attempt=0;attempt<retries;attempt++){
        const controller=new AbortController();this.controllers.add(controller);const timeout=setTimeout(()=>controller.abort(),8000);
        try{
          const headers={Accept:'application/json','Content-Type':'application/json','apikey':this.anonKey};
          if(prefer)headers.Prefer='return=representation';
          if(auth){if(!this.session?.accessToken)throw Error('Sign in to the configured Supabase project first.');headers.Authorization=`Bearer ${this.session.accessToken}`;}
          const response=await fetch(this.origin+path,{method,headers,body:body===undefined?undefined:JSON.stringify(body),credentials:'omit',cache:'no-store',redirect:'error',signal:controller.signal});
          if(epoch!==this.epoch)throw Error('Cloud operation was canceled because the session changed.');
          const declared=Number(response.headers.get('content-length')||0);if(declared>MAX_RESPONSE){controller.abort();throw Object.assign(Error('Cloud response exceeds the 65,536-byte limit.'),{nonRetryable:true});}
          const raw=await boundedBody(response,controller);
          if(epoch!==this.epoch||controller.signal.aborted)throw Error('Cloud operation was canceled because the session changed.');
          let data=null;if(raw){try{data=JSON.parse(raw);}catch{throw Object.assign(Error('Supabase returned invalid JSON.'),{nonRetryable:true});}}
          if(response.status>=500&&attempt+1<retries){await sleep(150*(attempt+1));continue;}
          if(epoch!==this.epoch||controller.signal.aborted)throw Error('Cloud operation was canceled because the session changed.');
          return {status:response.status,data};
        }catch(error){lastError=error;if(epoch!==this.epoch||controller.signal.aborted||error?.nonRetryable)throw error;if(attempt+1<retries){await sleep(150*(attempt+1));continue;}throw error;}
        finally{clearTimeout(timeout);this.controllers.delete(controller);}
      }
      throw lastError||Error('Supabase request failed.');
    }
    async signIn(email,password){
      if(typeof email!=='string'||email.length>254||typeof password!=='string'||password.length<1||password.length>1024)throw Error('Enter a valid Supabase email and password.');
      if(this.session)await this.logout();else this.logoutLocal();const epoch=this.epoch;
      const r=await this.request('/auth/v1/token?grant_type=password',{method:'POST',auth:false,retries:1,body:{email:email.trim(),password}});
      if(epoch!==this.epoch)throw Error('Cloud sign-in was canceled.');
      if(r.status!==200||typeof r.data?.access_token!=='string'||typeof r.data?.user?.id!=='string')throw Error('Supabase did not authenticate this account. Check project settings and credentials.');
      this.session={accessToken:r.data.access_token,refreshToken:typeof r.data.refresh_token==='string'?r.data.refresh_token:null,userId:r.data.user.id,email:typeof r.data.user.email==='string'?r.data.user.email:null};
      return {userId:this.session.userId,email:this.session.email};
    }
    async read(){
      if(!this.session)throw Error('Sign in to the configured Supabase project first.');
      const q=`?select=user_id,revision,data,deleted_at&user_id=eq.${encodeURIComponent(this.session.userId)}&limit=2`;
      const r=await this.request('/rest/v1/leaseq_workspaces'+q);
      if(r.status!==200||!Array.isArray(r.data))throw Error(`Supabase workspace read failed (HTTP ${r.status}).`);
      if(r.data.length>1)throw Error('RLS table returned duplicate workspace rows; no data was changed.');
      if(!r.data.length)return null;
      const row=r.data[0];if(row.user_id!==this.session.userId||!Number.isInteger(row.revision)||row.revision<1)throw Error('Supabase workspace identity or revision is invalid.');
      if(row.deleted_at!==null&&typeof row.deleted_at!=='string')throw Error('Supabase workspace deletion marker is invalid.');
      const deleted=typeof row.deleted_at==='string';const data=deleted?{}:window.LeaseQProfiles.validateData(row.data);
      return {revision:row.revision,deleted,data};
    }
    async write(data,expectedRevision){
      if(!this.session)throw Error('Sign in to the configured Supabase project first.');
      const clean=window.LeaseQProfiles.validateData(data);if(!Object.keys(clean).length)throw Error('Select at least one safe local category before syncing.');
      if(new TextEncoder().encode(JSON.stringify(clean)).byteLength>MAX_DATA)throw Error('Selected cloud data exceeds the 16,000-byte limit.');
      const userId=this.session.userId;
      if(expectedRevision===null){
        const r=await this.request('/rest/v1/leaseq_workspaces?select=user_id,revision,data,deleted_at',{method:'POST',prefer:true,body:{user_id:userId,revision:1,data:clean,deleted_at:null}});
        if(r.status===409)return {ok:false,conflict:true,remote:await this.read()};
        if(r.status<200||r.status>=300)throw Error(`Supabase workspace insert failed (HTTP ${r.status}).`);
        if(!Array.isArray(r.data)||r.data.length!==1||r.data[0].user_id!==userId||r.data[0].revision!==1||r.data[0].deleted_at!==null)throw Error('Supabase returned an unexpected workspace row after insert.');
        return {ok:true,revision:1};
      }
      if(!Number.isInteger(expectedRevision)||expectedRevision<1)throw Error('Remote revision is invalid.');
      const filter=`?user_id=eq.${encodeURIComponent(userId)}&revision=eq.${expectedRevision}&select=user_id,revision,data,deleted_at`;
      const r=await this.request('/rest/v1/leaseq_workspaces'+filter,{method:'PATCH',prefer:true,body:{revision:expectedRevision+1,data:clean,deleted_at:null}});
      if(r.status<200||r.status>=300)throw Error(`Supabase workspace update failed (HTTP ${r.status}).`);
      if(!Array.isArray(r.data)||r.data.length!==1)return {ok:false,conflict:true,remote:await this.read()};
      if(r.data[0].user_id!==userId||r.data[0].revision!==expectedRevision+1)throw Error('Supabase returned an unexpected workspace revision.');
      return {ok:true,revision:expectedRevision+1};
    }
    async sync(data){
      const remote=await this.read();if(!remote)return this.write(data,null);
      if(remote.deleted)return {ok:false,conflict:true,remote,reason:'A remote deletion marker exists.'};
      if(canonical(window.LeaseQProfiles.validateData(data))===canonical(remote.data))return {ok:true,unchanged:true,revision:remote.revision};
      return {ok:false,conflict:true,remote,reason:'Remote and local revisions differ; choose which copy to keep.'};
    }
    async deleteRemote(expectedRevision){
      if(!this.session)throw Error('Sign in to the configured Supabase project first.');
      if(!Number.isInteger(expectedRevision)||expectedRevision<1)throw Error('Read the current remote revision before deleting it.');
      const filter=`?user_id=eq.${encodeURIComponent(this.session.userId)}&revision=eq.${expectedRevision}&select=user_id,revision,data,deleted_at`;
      const r=await this.request('/rest/v1/leaseq_workspaces'+filter,{method:'PATCH',prefer:true,body:{revision:expectedRevision+1,data:{},deleted_at:new Date().toISOString()}});
      if(r.status<200||r.status>=300)throw Error(`Supabase deletion marker failed (HTTP ${r.status}).`);
      if(!Array.isArray(r.data)||r.data.length!==1)return {ok:false,conflict:true,remote:await this.read()};
      return {ok:true,revision:expectedRevision+1,deleted:true};
    }
    logoutLocal(){this.epoch++;for(const c of this.controllers)c.abort();this.controllers.clear();this.session=null;}
    async logout(){
      const session=this.session;this.logoutLocal();if(!session)return;
      const controller=new AbortController(),timeout=setTimeout(()=>controller.abort(),3000);
      try{await fetch(this.origin+'/auth/v1/logout',{method:'POST',headers:{apikey:this.anonKey,Authorization:`Bearer ${session.accessToken}`},credentials:'omit',cache:'no-store',redirect:'error',signal:controller.signal});}catch{}finally{clearTimeout(timeout);}
    }
  }
  window.LeaseQSync=Object.freeze({SupabaseRlsProvider,endpointOrigin,publicKey,maxDataBytes:MAX_DATA});
})();
