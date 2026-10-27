'use strict';
// Standalone employee time-clock authentication. Disabled until Twilio Verify is configured.
// Employee session cookies are limited to /api/employee and cannot authenticate accounting APIs.
const crypto=require('node:crypto');
const COOKIE='sumlora_employee';
const sessions=new Map(), attempts=new Map();
const E164=/^\+1[2-9]\d{9}$/;
const normalizePhone=v=>{const d=String(v||'').replace(/\D/g,'');return d.length===10?'+1'+d:d.length===11&&d[0]==='1'?'+'+d:''};
const enabled=()=>!!(process.env.TWILIO_ACCOUNT_SID&&process.env.TWILIO_AUTH_TOKEN&&process.env.TWILIO_VERIFY_SERVICE_SID);
function checkRate(ip,phone){const key=ip+'|'+phone;const now=Date.now();const x=attempts.get(key)||{n:0,since:now};if(now-x.since>3600000){x.n=0;x.since=now}if(x.n>=8)throw Object.assign(Error('Too many attempts. Try again later.'),{status:429});x.n++;attempts.set(key,x);if(attempts.size>10000)for(const [k,v] of attempts)if(now-v.since>3600000)attempts.delete(k)}
async function verifyRequest(endpoint,fields){if(!enabled())throw Object.assign(Error('Employee SMS login is not configured.'),{status:503});
 const url='https://verify.twilio.com/v2/Services/'+encodeURIComponent(process.env.TWILIO_VERIFY_SERVICE_SID)+'/'+endpoint;
 const form=new URLSearchParams(fields);const auth=Buffer.from(process.env.TWILIO_ACCOUNT_SID+':'+process.env.TWILIO_AUTH_TOKEN).toString('base64');
 const res=await fetch(url,{method:'POST',headers:{Authorization:'Basic '+auth,'Content-Type':'application/x-www-form-urlencoded'},body:form,signal:AbortSignal.timeout(10000)});
 const body=await res.json().catch(()=>({}));if(!res.ok)throw Object.assign(Error('SMS verification unavailable. Please try again later.'),{status:503});
 return body;
}
function setSession(res,companyId,employeeId){const token=crypto.randomBytes(32).toString('hex'),hash=crypto.createHash('sha256').update(token).digest('hex');sessions.set(hash,{companyId,employeeId,until:Date.now()+8*3600000});res.setHeader('Set-Cookie',COOKIE+'='+token+'; Path=/api/employee; Max-Age=28800; HttpOnly; Secure; SameSite=Strict');return {ok:true}}
function session(req){const token=(String(req.headers.cookie||'').match(/(?:^|; )sumlora_employee=([a-f0-9]{64})(?:;|$)/)||[])[1];if(!token)return null;const k=crypto.createHash('sha256').update(token).digest('hex');const x=sessions.get(k);if(!x)return null;if(x.until<Date.now()){sessions.delete(k);return null}return x}
function logout(req,res){const token=(String(req.headers.cookie||'').match(/(?:^|; )sumlora_employee=([a-f0-9]{64})(?:;|$)/)||[])[1];if(token)sessions.delete(crypto.createHash('sha256').update(token).digest('hex'));res.setHeader('Set-Cookie',COOKIE+'=; Path=/api/employee; Max-Age=0; HttpOnly; Secure; SameSite=Strict');return{ok:true}}
module.exports={normalizePhone,enabled,checkRate,verifyRequest,setSession,session,logout};
