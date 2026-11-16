"use strict";
/* Optional browser-local convenience profiles. They never grant API authority. */
(() => {
  const INDEX = "leaseq:profiles:v1:index", PREFIX = "leaseq:profile:v1:", DATA = "leaseq:workspace:v1:";
  const VERSION = 1, ITERATIONS = 600000, MAX_PROFILES = 1000, MAX_ITEM_BYTES = 65536;
  const BACKUP_MAX_BYTES = 65536, BACKUP_MAX_PLAINTEXT = 16000;
  const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  const PROFILE_KEYS = ["app","schema","id","email","kdf","workFactor","salt","verifier"];
  const encoder = new TextEncoder();
  const bytesToHex = (b) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
  const read = (key) => {
    const raw = localStorage.getItem(key);
    if (raw === null) return null;
    if (encoder.encode(raw).byteLength > MAX_ITEM_BYTES) throw Error("Local profile data exceeds the browser storage limit.");
    try { return JSON.parse(raw); } catch { throw Error("Local profile data is corrupted. Clear the damaged browser profile data before continuing."); }
  };
  function exactKeys(value, keys, label) {
    if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some((k) => !keys.includes(k)))
      throw Error(`${label} contains an unsupported or corrupt field.`);
  }
  function validEmail(v) { return typeof v === "string" && v.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v); }
  function profileRecord(id) {
    if (typeof id !== "string" || !ID.test(id)) throw Error("Local profile index contains an invalid ID.");
    const r=read(PREFIX+id);
    if (!r) throw Error("Local profile record is missing or corrupted.");
    exactKeys(r,PROFILE_KEYS,"Profile record");
    if(r.app!=="leaseq"||r.schema!==VERSION||r.id!==id||!validEmail(r.email)||r.kdf!=="PBKDF2-HMAC-SHA-256"||r.workFactor!==ITERATIONS||typeof r.salt!=="string"||!/^(?:[a-f0-9]{2}){16}$/i.test(r.salt)||typeof r.verifier!=="string"||!/^(?:[a-f0-9]{2}){32}$/i.test(r.verifier)) throw Error("Local profile record is corrupted or uses an unsupported format.");
    return r;
  }
  function profileIds() {
    const raw=localStorage.getItem(INDEX);
    if(raw===null)return [];
    if(encoder.encode(raw).byteLength>MAX_ITEM_BYTES)throw Error("Local profile data exceeds the browser storage limit.");
    let ids;try{ids=JSON.parse(raw);}catch{throw Error("Local profile data is corrupted. Clear the damaged browser profile data before continuing.");}
    if(!Array.isArray(ids)||ids.length>MAX_PROFILES||ids.some(id=>typeof id!=="string"||!ID.test(id))||new Set(ids).size!==ids.length) throw Error("Local profile index is corrupted or exceeds the supported limit.");
    return ids;
  }
  function safeData(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw Error("Saved settings are invalid.");
    const allowed=["theme","submitDraft","submitText","submitFields","guestSimulation"];
    exactKeys(value,allowed,"Saved settings");
    const out = {};
    if (value.theme !== undefined) { if(value.theme!=="light"&&value.theme!=="dark")throw Error("Saved theme is invalid.");out.theme=value.theme; }
    for(const k of ["submitDraft","submitText"]) if(value[k]!==undefined){if(typeof value[k]!=="string"||value[k].length>12000)throw Error(`Saved ${k} is invalid or too large.`);out[k]=value[k];}
    if(value.submitFields!==undefined){
      const f=value.submitFields, fields=["kind","priority","attempts","due","delay"];
      exactKeys(f,fields,"Saved submit fields"); const clean={};
      for(const k of Object.keys(f)){if(typeof f[k]!=="string"||f[k].length>128)throw Error(`Saved field ${k} is invalid or too large.`);clean[k]=f[k];}
      out.submitFields=clean;
    }
    if(value.guestSimulation!==undefined){
      const g=value.guestSimulation; exactKeys(g,["state","attempts","maxAttempts","events","text","result","eventsDropped"],"Saved guest simulation");
      if(g.text!==undefined&&typeof g.text!=="string")throw Error("Saved guest simulation text is invalid.");
      if(g.result!==undefined&&g.result!==null&&(!g.result||typeof g.result!=="object"||Array.isArray(g.result)))throw Error("Saved guest simulation result is invalid.");
      const savedText=g.text===undefined?"":g.text,savedResult=g.result===undefined?null:g.result;
      const validResult=savedResult===null||(savedResult&&typeof savedResult==="object"&&!Array.isArray(savedResult)&&Object.keys(savedResult).length===2&&Number.isInteger(savedResult.words)&&savedResult.words>=0&&savedResult.words<=10000&&Number.isInteger(savedResult.lines)&&savedResult.lines>=0&&savedResult.lines<=10000);
      if(!["queued","leased","done","dead"].includes(g.state)||!Number.isInteger(g.attempts)||g.attempts<0||g.attempts>100||!Number.isInteger(g.maxAttempts)||g.maxAttempts<1||g.maxAttempts>100||g.attempts>g.maxAttempts||!Array.isArray(g.events)||g.events.length>40||g.events.some((item)=>typeof item!=="string"||item.length>500)||savedText.length>10000||!validResult)throw Error("Saved guest simulation is invalid or too large.");
      const eventsDropped=g.eventsDropped===undefined?null:g.eventsDropped;
      if(eventsDropped!==null&&(!Number.isSafeInteger(eventsDropped)||eventsDropped<0))throw Error("Saved guest simulation event count is invalid.");
      out.guestSimulation={state:g.state,attempts:g.attempts,maxAttempts:g.maxAttempts,events:[...g.events],eventsDropped,text:savedText,result:savedResult?{words:savedResult.words,lines:savedResult.lines}:null};
    }
    if (encoder.encode(JSON.stringify(out)).byteLength > 16000) throw Error("Saved work exceeds the local storage limit.");
    return out;
  }
  async function profileLock(action) {
    if(!navigator.locks||typeof navigator.locks.request!=="function") throw Error("This browser cannot safely coordinate local profiles across tabs. Use the synthetic demo or connect directly to your LeaseQ API.");
    return navigator.locks.request("leaseq-local-profiles-v1",{mode:"exclusive"},action);
  }
  async function derive(password, salt) {
    const key = await crypto.subtle.importKey("raw", encoder.encode(password), "PBKDF2", false, ["deriveBits"]);
    return crypto.subtle.deriveBits({ name:"PBKDF2", hash:"SHA-256", salt, iterations:ITERATIONS }, key, 256);
  }
  const b64url=(bytes)=>btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/g,"");
  function unb64url(value,maxLength){
    if(typeof value!=="string"||value.length>maxLength||!/^[A-Za-z0-9_-]+$/.test(value))throw Error("Encrypted backup contains an invalid binary field.");
    const raw=atob(value.replace(/-/g,"+").replace(/_/g,"/")+"=".repeat((4-value.length%4)%4));
    const bytes=Uint8Array.from(raw,(c)=>c.charCodeAt(0));if(b64url(bytes)!==value)throw Error("Encrypted backup contains a malformed binary field.");return bytes;
  }
  function backupPassword(password){if(typeof password!=="string"||password.length<12||password.length>1024)throw Error("Use a backup passphrase between 12 and 1024 characters.");return password;}
  const preparedBackups=new WeakMap();
  async function exportBackup(id,password,selection){
    backupPassword(password);
    exactKeys(selection,["preferences","drafts","simulation"],"Backup selection");
    if(Object.values(selection).some((v)=>typeof v!=="boolean")||!Object.values(selection).some(Boolean))throw Error("Select at least one category to include in the encrypted backup.");
    const source=load(id),saved={};
    if(selection.preferences&&source.theme)saved.theme=source.theme;
    if(selection.drafts){for(const key of ["submitDraft","submitText","submitFields"])if(source[key]!==undefined)saved[key]=source[key];}
    if(selection.simulation){if(!source.guestSimulation)throw Error("This profile has no saved simulator scenario to include.");saved.guestSimulation=source.guestSimulation;}
    const payload={app:"leaseq",schema:VERSION,saved:safeData(saved)};
    const plain=encoder.encode(JSON.stringify(payload));if(plain.byteLength>BACKUP_MAX_PLAINTEXT)throw Error("Selected backup data exceeds the 16,000-byte limit.");
    const salt=crypto.getRandomValues(new Uint8Array(16)),iv=crypto.getRandomValues(new Uint8Array(12));
    const material=await crypto.subtle.importKey("raw",encoder.encode(password),"PBKDF2",false,["deriveKey"]);
    const key=await crypto.subtle.deriveKey({name:"PBKDF2",hash:"SHA-256",salt,iterations:ITERATIONS},material,{name:"AES-GCM",length:256},false,["encrypt"]);
    const ciphertext=new Uint8Array(await crypto.subtle.encrypt({name:"AES-GCM",iv,additionalData:encoder.encode("leaseq:backup:v1"),tagLength:128},key,plain));
    const envelope={app:"leaseq",schema:VERSION,format:"leaseq-encrypted-backup",kdf:"PBKDF2-HMAC-SHA-256",iterations:ITERATIONS,cipher:"AES-256-GCM",salt:b64url(salt),iv:b64url(iv),ciphertext:b64url(ciphertext)};
    const result=JSON.stringify(envelope,null,2);if(encoder.encode(result).byteLength>BACKUP_MAX_BYTES)throw Error("Encrypted backup exceeds the 65,536-byte file limit.");return result;
  }
  async function prepareBackup(text,password){
    backupPassword(password);if(typeof text!=="string"||encoder.encode(text).byteLength>BACKUP_MAX_BYTES)throw Error("Choose a JSON backup no larger than 65,536 bytes.");
    let envelope;try{envelope=JSON.parse(text);}catch{throw Error("Backup is not valid JSON.");}
    exactKeys(envelope,["app","schema","format","kdf","iterations","cipher","salt","iv","ciphertext"],"Encrypted backup");
    if(envelope.app!=="leaseq"||envelope.schema!==VERSION||envelope.format!=="leaseq-encrypted-backup"||envelope.kdf!=="PBKDF2-HMAC-SHA-256"||envelope.iterations!==ITERATIONS||envelope.cipher!=="AES-256-GCM")throw Error("Backup app, version, or cryptographic parameters are unsupported.");
    const salt=unb64url(envelope.salt,32),iv=unb64url(envelope.iv,24),ciphertext=unb64url(envelope.ciphertext,24000);
    if(salt.length!==16||iv.length!==12||ciphertext.length<16||ciphertext.length>BACKUP_MAX_PLAINTEXT+16)throw Error("Encrypted backup has invalid lengths.");
    try{
      const material=await crypto.subtle.importKey("raw",encoder.encode(password),"PBKDF2",false,["deriveKey"]);
      const key=await crypto.subtle.deriveKey({name:"PBKDF2",hash:"SHA-256",salt,iterations:ITERATIONS},material,{name:"AES-GCM",length:256},false,["decrypt"]);
      const plain=await crypto.subtle.decrypt({name:"AES-GCM",iv,additionalData:encoder.encode("leaseq:backup:v1"),tagLength:128},key,ciphertext);
      if(plain.byteLength>BACKUP_MAX_PLAINTEXT)throw Error("decrypted size limit");
      const payload=JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(plain));exactKeys(payload,["app","schema","saved"],"Backup payload");
      if(payload.app!=="leaseq"||payload.schema!==VERSION)throw Error("Backup payload app or schema is unsupported.");
      const safe=safeData(payload.saved);if(!Object.keys(safe).length)throw Error("Backup contains no selected supported data.");
      const prepared=Object.freeze({categories:Object.keys(safe),hasSimulation:!!safe.guestSimulation,theme:safe.theme||null});preparedBackups.set(prepared,safe);return prepared;
    }catch(error){if(error?.message?.includes("unsupported")||error?.message?.includes("Saved")||error?.message?.includes("Backup payload"))throw error;throw Error("Passphrase is incorrect or the backup is damaged; current profile data was not changed.");}
  }
  function commitBackup(id,prepared){
    profileRecord(id);const saved=preparedBackups.get(prepared);if(!saved)throw Error("Preview this encrypted backup again before restoring it.");
    const merged=safeData({...load(id),...saved});
    const raw=JSON.stringify({app:"leaseq",schema:VERSION,id,saved:merged});if(encoder.encode(raw).byteLength>MAX_ITEM_BYTES)throw Error("Restored profile data exceeds the local storage limit.");
    // One Storage.setItem is the commit point; validation and decryption changed nothing.
    localStorage.setItem(DATA+id,raw);preparedBackups.delete(prepared);return merged;
  }
  function validPassword(password){return typeof password==="string"&&password.length>=10&&password.length<=1024;}
  async function create(email,password) {
    if(typeof email!=="string")throw Error("Enter a valid email address.");
    email=email.trim().toLowerCase(); if(!validEmail(email))throw Error("Enter a valid email address.");
    if(!validPassword(password))throw Error("Use a password between 10 and 1024 characters.");
    const id=crypto.randomUUID(),salt=crypto.getRandomValues(new Uint8Array(16));
    const verifier=bytesToHex(await derive(password,salt));
    const rec={app:"leaseq",schema:VERSION,id,email,kdf:"PBKDF2-HMAC-SHA-256",workFactor:ITERATIONS,salt:bytesToHex(salt),verifier};
    return profileLock(()=>{
      const ids=profileIds(); if(ids.length>=MAX_PROFILES)throw Error("This browser already has the maximum number of local profiles.");
      for(const existingId of ids) if(profileRecord(existingId).email===email)throw Error("A profile with this email already exists on this browser.");
      try{
        localStorage.setItem(PREFIX+id,JSON.stringify(rec));
        localStorage.setItem(DATA+id,JSON.stringify({app:"leaseq",schema:VERSION,id,saved:{theme:"light"}}));
        localStorage.setItem(INDEX,JSON.stringify([...ids,id]));
      }catch(e){try{localStorage.removeItem(PREFIX+id);localStorage.removeItem(DATA+id);}catch(_){}throw e;}
      return {id,email};
    });
  }
  async function login(email,password) {
    if(typeof email!=="string")throw Error("Email or password is incorrect.");
    email=email.trim().toLowerCase(); if(!validEmail(email)||!validPassword(password))throw Error("Email or password is incorrect.");
    const ids=profileIds(); let match=null;
    for(const id of ids){const r=profileRecord(id);if(r.email===email){match=r;break;}}
    if(!match)throw Error("Email or password is incorrect.");
    const actual=new Uint8Array(await derive(password,Uint8Array.from(match.salt.match(/../g),x=>parseInt(x,16))));
    const expected=Uint8Array.from(match.verifier.match(/../g),x=>parseInt(x,16));
    let diff=actual.length^expected.length;for(let i=0;i<expected.length;i++)diff|=actual[i]^expected[i];
    if(diff)throw Error("Email or password is incorrect.");
    return {id:match.id,email:match.email};
  }
  function load(id){
    profileRecord(id);
    const r=read(DATA+id); if(!r)throw Error("Saved local profile data is missing.");
    exactKeys(r,["app","schema","id","saved"],"Saved profile record");
    if(r.app!=="leaseq"||r.schema!==VERSION||r.id!==id)throw Error("Saved local profile data is corrupted or unsupported.");
    return safeData(r.saved);
  }
  function save(id,value){
    profileRecord(id); const saved=safeData(value);
    const raw=JSON.stringify({app:"leaseq",schema:VERSION,id,saved});
    if(encoder.encode(raw).byteLength>MAX_ITEM_BYTES)throw Error("Saved work exceeds the browser storage limit.");
    localStorage.setItem(DATA+id,raw);
  }
  window.LeaseQProfiles=Object.freeze({create,login,load,save,validateData:safeData,exportBackup,prepareBackup,commitBackup,iterations:ITERATIONS,backupMaxBytes:BACKUP_MAX_BYTES});
})();
