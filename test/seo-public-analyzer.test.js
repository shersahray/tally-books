'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {createPublicSeoAnalyzer,normalizedUrl,publicIp,resolvePublic}=require('../src/server/seo-public-analyzer');

test('Only ordinary HTTPS public hostnames can be inspected',()=>{
  for(const bad of [
    'http://example.com/','https://localhost/','https://127.0.0.1/',
    'https://10.1.1.1/','https://[::1]/','https://example.com:8443/',
    'https://user:secret@example.com/','https://example.com/#frag',
    'file:///etc/passwd','https://metadata.google.internal/',
    'https://internal.local/','https://example.test/'
  ]) assert.throws(()=>normalizedUrl(bad),undefined,bad);
  assert.equal(normalizedUrl('https://www.example.com/path?q=1').href,'https://www.example.com/path?q=1');
});
test('DNS resolver rejects private, reserved and mixed public/private addresses',async()=>{
  for(const ip of ['127.0.0.1','10.2.3.4','192.168.5.1','172.17.0.2','169.254.169.254','100.100.100.200','198.18.1.1','192.0.2.25','203.0.113.1','::1','fc00::1','fe80::1','::ffff:127.0.0.1','2001:db8::1'])
    assert.equal(publicIp(ip),false,ip);
  assert.equal(publicIp('8.8.8.8'),true);
  assert.equal(publicIp('2606:4700:4700::1111'),true);
  await assert.rejects(()=>resolvePublic('example.com',async()=>[{address:'8.8.8.8',family:4},{address:'10.0.0.1',family:4}]),/private/);
  const found=await resolvePublic('example.com',async()=>[{address:'8.8.8.8',family:4}]);
  assert.equal(found.address,'8.8.8.8');
});
test('Analyzer returns page metadata, not other-site traffic data',async()=>{
  const analyzer=createPublicSeoAnalyzer({
    lookup:async()=>[{address:'8.8.8.8',family:4}],
    transport:async(u,ip)=>{
      assert.equal(ip.address,'8.8.8.8');
      assert.equal(u.href,'https://example.com/test');
      return '<html><head><title>Example &amp; Co</title><meta name="description" content="Test website"><link rel="canonical" href="https://example.com/test"></head><body><h1>Hello</h1></body></html>';
    }
  });
  const result=await analyzer.analyze('https://example.com/test');
  assert.equal(result.title,'Example & Co');
  assert.equal(result.issues.length,0);
  assert.equal(result.httpStatus,200);
  assert.ok(!('traffic' in result));
});
test('Analyzer caps admin-triggered inspections per hour',async()=>{
  const analyzer=createPublicSeoAnalyzer({
    lookup:async()=>[{address:'8.8.8.8',family:4}],
    transport:async()=>'<title>Example</title><meta name="description" content="Test"><link rel="canonical" href="https://example.com/"><h1>One</h1>'
  });
  for(let i=0;i<12;i++)await analyzer.analyze('https://example.com/');
  await assert.rejects(()=>analyzer.analyze('https://example.com/'),/Hourly analysis limit/);
});