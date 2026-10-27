'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const auth=require('../src/server/employee-auth');
test('phone login normalization only accepts North American numbers',()=>{
 assert.equal(auth.normalizePhone('(613) 555-0199'),'+16135550199');
 assert.equal(auth.normalizePhone('+1 613-555-0199'),'+16135550199');
 assert.equal(auth.normalizePhone('abc'),'');
 assert.equal(auth.normalizePhone('123'),'');
});
test('employee session cookie cannot authenticate the main app by its path',()=>{
 const headers={};
 const res={setHeader:(key,value)=>headers[key]=value};
 auth.setSession(res,'co1','worker1');
 assert.match(headers['Set-Cookie'],/Path=\/api\/employee;/);
 assert.match(headers['Set-Cookie'],/HttpOnly; Secure; SameSite=Strict/);
 const cookie=headers['Set-Cookie'].split(';')[0];
 assert.deepEqual(auth.session({headers:{cookie}}).companyId,'co1');
 auth.logout({headers:{cookie}},res);
 assert.equal(auth.session({headers:{cookie}}),null);
});
