'use strict';
// Admin-only, single-page public HTTPS metadata inspector; intentionally not a crawler.
// The transport pins a publicly resolved IP into the TLS request to mitigate DNS rebinding.
const https = require('node:https');
const dns = require('node:dns');
const net = require('node:net');
const { metadata } = require('./seo-studio');

const problem = (message, status=400) => Object.assign(new Error(message), {status});
function normalizedUrl(input) {
  if (typeof input !== 'string' || input.length > 2048) throw problem('Enter an HTTPS website URL (maximum 2,048 characters).');
  let u;
  try { u = new URL(input.trim()); } catch { throw problem('Enter a valid full URL, such as https://example.com/.'); }
  if (u.protocol !== 'https:' || u.username || u.password || u.port && u.port !== '443' || u.hash)
    throw problem('Only public HTTPS URLs without credentials, custom ports, or fragments are supported.');
  if (u.hostname.length > 253 || !u.hostname.includes('.') || u.hostname.endsWith('.') || u.hostname.startsWith('.') ||
      u.hostname === 'localhost' || u.hostname.endsWith('.localhost') || u.hostname.endsWith('.local') ||
      u.hostname.endsWith('.internal') || u.hostname.endsWith('.test') || u.hostname.endsWith('.invalid') ||
      u.hostname.endsWith('.example') || u.hostname.endsWith('.onion') || net.isIP(u.hostname))
    throw problem('Use a publicly registered website hostname, not an IP address or local domain.');
  if (!/^[a-z0-9.-]+$/i.test(u.hostname)) throw problem('Unsupported hostname characters.');
  u.hash = ''; u.port = ''; // canonical inspection URL
  return u;
}
function publicIp(address) {
  const family=net.isIP(address);
  if (family===4) {
    const a=address.split('.').map(Number);
    const [x,y,z]=a;
    if (x===0||x===10||x===127||x>=224||x===169&&y===254||x===172&&y>=16&&y<=31||
        x===192&&(y===168||y===0||y===88&&z===99)||x===100&&y>=64&&y<=127||
        x===198&&(y===18||y===19||y===51&&z===100)||x===203&&y===0&&z===113||
        x===192&&y===0&&z===2||x===198&&y===51&&z===100||x===192&&y===0||
        x===255||x===169&&y===254) return false;
    // Prohibit all special low-address 0/8, loopback, link-local, multicast, reserved.
    return true;
  }
  if (family===6) {
    // Only global unicast 2000::/3; exclude documentation 2001:db8::/32.
    const head=address.toLowerCase();
    if (!/^[23][0-9a-f]{3}:/.test(head)) return false;
    if (head.startsWith('2001:db8:') || head==='2001:db8::') return false;
    // IPv4-mapped addresses aren't 2000::/3, therefore excluded above.
    return true;
  }
  return false;
}
async function resolvePublic(host, lookup=dns.promises.lookup) {
  let records;
  try { records=await lookup(host, {all:true, verbatim:true}); }
  catch { throw problem('Could not resolve the website hostname.',422); }
  if (!Array.isArray(records) || !records.length || records.some(r=>!publicIp(r.address)))
    throw problem('Website resolves to a private, reserved, or unsupported address.',422);
  // Pin the resolved address. TLS hostname validation and SNI still use the original domain.
  return records[0];
}
function retrievePage(url, resolved, requestFn=https.request) {
  return new Promise((resolve,reject)=>{
    let settled=false, bytes=0; const chunks=[];
    const fail=e=>{if(!settled){settled=true;reject(e);}};
    const req=requestFn(url, {
      method:'GET', agent:false, maxHeaderSize:16384,
      headers:{'User-Agent':'SumloraSEOStudio/1.0 (+https://sumlora.ca)',Accept:'text/html'},
      lookup:(hostname,opts,cb)=>cb(null,resolved.address,resolved.family),
      timeout:8000
    },res=>{
      const status=res.statusCode||0;
      if(status>=300&&status<400) { res.destroy();return fail(problem('This page redirects. Enter its final public HTTPS URL directly.',422)); }
      if(status!==200){res.destroy();return fail(problem('Website returned HTTP '+status+'.',422));}
      if(!/^text\/html(?:\s*;|$)/i.test(res.headers['content-type']||'')) {
        res.destroy();return fail(problem('The URL did not return an HTML page.',422));
      }
      const declared=Number(res.headers['content-length']||0);
      if(declared>512*1024){res.destroy();return fail(problem('Website HTML is too large to inspect.',422));}
      res.on('data',chunk=>{
        bytes+=chunk.length;
        if(bytes>512*1024){res.destroy();return fail(problem('Website HTML exceeded the 512 KB limit.',422));}
        chunks.push(chunk);
      });
      res.on('end',()=>{if(!settled){settled=true;resolve(Buffer.concat(chunks).toString('utf8'));}});
      res.on('error',e=>fail(problem('Website connection failed.',502)));
    });
    req.on('timeout',()=>{req.destroy();fail(problem('Website took too long to respond.',504));});
    req.on('error',()=>fail(problem('Could not securely fetch the website.',502)));
    req.end();
  });
}
function createPublicSeoAnalyzer(options={}) {
  const lookup=options.lookup || dns.promises.lookup;
  const transport=options.transport || retrievePage;
  const attempts=[];
  async function analyze(input) {
    const now=Date.now();
    while(attempts.length&&attempts[0]<now-3600000)attempts.shift();
    if(attempts.length>=12)throw problem('Hourly analysis limit reached. Please try again later.',429);
    attempts.push(now);
    const target=normalizedUrl(input);
    const resolved=await resolvePublic(target.hostname,lookup);
    const body=await transport(target,resolved);
    const result=metadata(body,target.href);
    return {
      checkedAt:new Date().toISOString(),url:target.href,httpStatus:200,
      title:result.title,description:result.description,h1:result.h1,
      canonical:result.canonical,robots:result.robots,issues:result.issues,
      note:'Single-page technical metadata check only. No keyword rankings, traffic estimates, or full-site crawl. Redirects are not followed.'
    };
  }
  return {analyze};
}
module.exports={createPublicSeoAnalyzer,normalizedUrl,publicIp,resolvePublic,retrievePage};
