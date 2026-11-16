const { chromium } = require('playwright');
const BASE=process.env.BASE_URL, CHROME=process.env.CHROME_PATH;
if(!BASE)throw Error('Set BASE_URL');
(async()=>{
 const browser=await chromium.launch({headless:true,...(CHROME?{executablePath:CHROME}:{})});
 try{
  const context=await browser.newContext(),a=await context.newPage(),b=await context.newPage();
  await Promise.all([a.goto(`${BASE}/dashboard/#/signup`),b.goto(`${BASE}/dashboard/#/signup`)]);
  const dup=await Promise.allSettled([a.evaluate(()=>LeaseQProfiles.create('same@example.test','long-safe-password-a')),b.evaluate(()=>LeaseQProfiles.create('same@example.test','long-safe-password-b'))]);
  if(dup.filter(x=>x.status==='fulfilled').length!==1)throw Error('Concurrent duplicate signup was not serialized');
  const ids=await a.evaluate(()=>JSON.parse(localStorage.getItem('leaseq:profiles:v1:index')));if(ids.length!==1)throw Error('Concurrent duplicate left an inconsistent profile index');
  const others=await Promise.all([a.evaluate(()=>LeaseQProfiles.create('left@example.test','long-safe-password-c')),b.evaluate(()=>LeaseQProfiles.create('right@example.test','long-safe-password-d'))]);
  const all=await a.evaluate(()=>JSON.parse(localStorage.getItem('leaseq:profiles:v1:index')));if(all.length!==3||new Set(all).size!==3||new Set(others.map(x=>x.id)).size!==2)throw Error('Concurrent distinct signups lost an index entry');
  const checks=await a.evaluate(async(id)=>{
   const k=`leaseq:workspace:v1:${id}`,original=localStorage.getItem(k);let unknown=false,oversize=false,unsupported=false;
   localStorage.setItem(k,JSON.stringify({...JSON.parse(original),saved:{theme:'light',unexpected:true}}));try{LeaseQProfiles.load(id)}catch(e){unknown=/unsupported|corrupt/i.test(e.message)}
   localStorage.setItem(k,' '.repeat(66000));try{LeaseQProfiles.load(id)}catch(e){oversize=/storage limit/i.test(e.message)}localStorage.setItem(k,original);
   Object.defineProperty(navigator,'locks',{configurable:true,value:undefined});try{await LeaseQProfiles.create('nolock@example.test','long-safe-password-e')}catch(e){unsupported=/cannot safely coordinate/i.test(e.message)}delete navigator.locks;
   return {unknown,oversize,unsupported};
  },all[0]);
  if(!checks.unknown||!checks.oversize||!checks.unsupported)throw Error(`Corrupt/oversize/fallback checks failed: ${JSON.stringify(checks)}`);
  const blocked=await browser.newContext();await blocked.addInitScript(()=>{Object.defineProperty(window,'localStorage',{configurable:true,value:{getItem(){throw new DOMException('blocked','SecurityError')},setItem(){throw new DOMException('blocked','SecurityError')},removeItem(){throw new DOMException('blocked','SecurityError')}}});});
  const p=await blocked.newPage();await p.goto(`${BASE}/dashboard/#/signup`);await p.getByLabel('Email').fill('blocked@example.test');await p.getByLabel('Password').fill('long-safe-password-f');await p.getByRole('button',{name:'Create profile'}).click();await p.getByRole('alert').filter({hasText:/blocked|denied|storage/i}).waitFor();
  process.stdout.write(JSON.stringify({concurrent_same_email_single_winner:true,concurrent_distinct_profiles_preserved:true,unknown_fields_rejected:checks.unknown,oversize_blob_rejected:checks.oversize,unsupported_lock_fails_closed:checks.unsupported,storage_denial_shown:true})+'\n');
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exit(1)});
