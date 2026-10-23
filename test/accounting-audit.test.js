'use strict';
require('./setup-payroll-on');
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), vm = require('node:vm');
const { createApp } = require('../src/server/app');
const { isDate } = require('../src/server/validate');
const pub = file => fs.readFileSync(path.join(__dirname, '..', 'public', file), 'utf8');
const plain = x => JSON.parse(JSON.stringify(x));

// Run the production browser formulas, as the existing posting/report tests do.
function calculations() {
  const app = pub('app.js'), pick = (a, b) => { const start = app.indexOf(a); assert.ok(start >= 0); const end = app.indexOf(b, start); assert.ok(end > start); return app.slice(start, end); };
  const c = vm.createContext({ Blob, S: { company: { fyStart: 1 }, assets: [], docs: [], entries: [], accounts: [], items: [] } });
  vm.runInContext(`
    ${pick('const r2=', 'const uid=')}
    const pad=n=>String(n).padStart(2,'0'),pd=s=>new Date(s+'T12:00:00'),iso=d=>d.getFullYear()+'-'+pad(d.getMonth()+1)+'-'+pad(d.getDate()),today=()=> '2026-10-23';
    ${pick('function fyStartOf(', 'function netIncome(')}
    const acct=id=>S.accounts.find(a=>a.id===id),byDetail=d=>S.accounts.find(a=>a.detail===d),acctName=id=>(acct(id)||{}).name||id;
    const contactName=()=> 'Test customer',isCreditKind=k=>k==='credit'||k==='vcredit',debitNormal=t=>['Asset','Expense','Cost of Goods Sold'].includes(t);
    const bal=(id,from,to)=>S.entries.filter(e=>(!from||e.date>=from)&&(!to||e.date<=to)).reduce((s,e)=>s+(e.lines||[]).filter(l=>l.account===id).reduce((t,l)=>t+(+l.debit||0)-(+l.credit||0),0),0)*(debitNormal(acct(id).type)?1:-1);
    const money=n=>String(n),mcell=money,T=s=>s,fmtDate=s=>s,emptyRow=()=>'',esc=String;
    const saveFile=(name,blob)=>{this.exported={name,blob}};
    ${pub('assets.js')}
    ${pub('fx.js')}
    ${pub('inventory.js')}
    ${pick('const pstOn=', '// Total per account')}
    ${pick('function groupBy(', 'const delBtn')}
    ${pick('function docPostLines(', '/** A saved document')}
    ${pick('const docRecord=', 'function docForm(')}
    this.H={ccaSchedule,vCca,ccaCsv,revalLines,revalPostLines,foreignRefundLines,acctFxBal,stockAt,stockPurchaseCosts,invCosts,invCostLines,calcLines,docRecord,docPostLines};
  `, c);
  return c;
}

test('CCA: last Class 8 disposal deducts the full remaining UCC and stays closed in later years', () => {
  const {S,H}=calculations();
  S.company.ccaOpening={'8':{fy:'2026-01-01',ucc:1000}};
  S.assets=[{id:'x',ccaClass:'8',ccaRate:20,cost:1000,acquired:'2025-01-01',disposed:'2026-06-01',proceeds:200,firstYear:'half'}];
  let r=H.ccaSchedule('2026-01-01')[0];
  assert.deepEqual([r.open,r.dis,r.cca,r.terminal,r.close],[1000,200,0,800,0]);
  r=H.ccaSchedule('2027-01-01')[0];assert.deepEqual([r.open,r.cca,r.terminal,r.close],[0,0,0,0]);
  S.assets.push({id:'future',ccaClass:'8',ccaRate:20,cost:2000,acquired:'2027-02-01',firstYear:'half'});
  assert.equal(H.ccaSchedule('2026-01-01')[0].terminal,800,'future purchases do not prevent this year’s terminal loss');
  r=H.ccaSchedule('2027-01-01')[0];assert.equal(r.open,0);assert.equal(r.add,2000);
});
test('CCA: surviving assets retain ordinary CCA; negative pools have recapture', () => {
  const {S,H}=calculations();S.company.ccaOpening={'8':{fy:'2026-01-01',ucc:1000}};
  S.assets=[{ccaClass:'8',ccaRate:20,cost:2000,acquired:'2025-01-01',firstYear:'half'}];
  let r=H.ccaSchedule('2026-01-01')[0];assert.deepEqual([r.cca,r.close,r.terminal],[200,800,0]);
  Object.assign(S.assets[0],{disposed:'2026-03-01',proceeds:1500});r=H.ccaSchedule('2026-01-01')[0];assert.deepEqual([r.recapture,r.cca,r.close],[500,0,0]);
});
test('CCA: fiscal-year closure works for a July start', () => {
  const {S,H}=calculations();S.company.fyStart=7;S.company.ccaOpening={'8':{fy:'2025-07-01',ucc:1000}};
  S.assets=[{ccaClass:'8',cost:1000,acquired:'2024-08-01',disposed:'2026-04-01',proceeds:200}];
  assert.equal(H.ccaSchedule('2025-07-01')[0].terminal,800);assert.equal(H.ccaSchedule('2026-07-01')[0].open,0);
});
test('CCA: Class 10.1 is explicitly manual in the worksheet and CSV, with no fabricated claim', async () => {
  const c=calculations(),{S,H}=c;S.company.ccaOpening={'10.1':{fy:'2026-01-01',ucc:20000}};
  S.assets=[{ccaClass:'10.1',cost:40000,acquired:'2025-01-01',disposed:'2026-06-01',proceeds:10000}];
  const r=H.ccaSchedule('2026-01-01')[0];assert.equal(r.manual,true);assert.equal(r.terminal,null);assert.equal(r.cca,null);
  assert.match(H.vCca('2026-01-01','',false),/Manual review required/);H.ccaCsv('2026-01-01');
  assert.match(await c.exported.blob.text(),/Manual review required: Class 10.1/);
});

function fxFixture(kind='bill') {
  const c=calculations();c.S.accounts=[{id:'ar',name:'Receivables',type:'Asset',detail:'ar'},{id:'ap',name:'Payables',type:'Liability',detail:'ap'},{id:'fx',type:'Expense'}];
  c.S.docs=[{id:'d',kind,date:'2026-09-01',currency:'USD',fx:1.3,total:100}];return c;
}
test('FX: receivable, payable and credit revaluations post the correct direction for gains and losses', () => {
  for(const [kind,account,sign]of [['invoice','ar',1],['bill','ap',-1],['credit','ar',-1],['vcredit','ap',1]])for(const rate of [1.4,1.2]){
    const {S,H}=fxFixture(kind),delta=Math.round((rate-1.3)*100)*sign;
    const changes=H.revalLines('2026-09-30',{USD:rate}),lines=H.revalPostLines(changes,'fx');
    const ctl=lines.find(l=>l.account===account);assert.equal(ctl.debit-ctl.credit,delta,kind+' '+rate);
    assert.equal(lines.reduce((s,l)=>s+l.debit-l.credit,0),0);
    const offset=lines.find(l=>l.account==='fx');assert.equal(offset.debit-offset.credit,-delta);
  }
});
test('FX: repeated dates are idempotent; rate corrections, reversals and same-date settlement use only the delta', () => {
  const {S,H}=fxFixture('invoice');
  const post=(date,r)=>{const lines=H.revalPostLines(H.revalLines(date,{USD:r}),'fx');S.entries.push({date,fxReval:true,lines});return lines};
  post('2026-09-30',1.4);assert.equal(H.revalLines('2026-09-30',{USD:1.4}).length,0);
  assert.equal(H.revalLines('2026-09-30',{USD:1.5})[0].amount,10);
  assert.equal(H.revalLines('2026-09-30',{USD:1.3})[0].amount,-10,'returning to original rate reverses the existing gain');
  S.entries.push({date:'2026-10-01',fxReval:true,reversalOf:'r',lines:[{account:'ar',debit:0,credit:10},{account:'fx',debit:10,credit:0}]});
  assert.equal(H.revalLines('2026-10-31',{USD:1.4})[0].amount,10,'the previous reversal must be included');
  S.entries.push({date:'2026-09-30',applyTo:'d',amount:100,lines:[]});
  assert.equal(H.revalLines('2026-09-30',{USD:1.4})[0].amount,-10,'settling all documents still removes their prior revaluation');
  S.docs=[];assert.equal(H.revalLines('2026-09-30',{})[0].amount,-10,'removing the original document must not strand its FX adjustment');
});
test('FX: foreign credit-card liability increases with a higher CAD exchange rate, without changing foreign units', () => {
  const {S,H}=calculations();S.accounts=[{id:'card',type:'Liability',detail:'card',currency:'USD'},{id:'fx',type:'Expense'}];
  S.entries=[{date:'2026-09-01',lines:[{account:'card',debit:0,credit:130,fx:{cur:'USD',amt:100}}]}];
  const lines=H.revalPostLines(H.revalLines('2026-09-30',{USD:1.4}),'fx');
  const card=lines.find(l=>l.account==='card');assert.equal(card.credit,10);assert.equal(card.fx.amt,0);
  S.entries.push({date:'2026-09-30',fxReval:true,lines});assert.equal(H.acctFxBal('card','2026-09-30'),-100);assert.equal(H.revalLines('2026-09-30',{USD:1.4}).length,0);
});
test('FX: customer and vendor refunds preserve the credit carrying value and recognize the actual cash FX difference',()=>{
  for(const kind of ['credit','vcredit'])for(const foreignBank of [false,true])for(const cad of [120,130,140]){
    const {S,H}=fxFixture(kind);S.accounts.push({id:'bank',type:'Asset',detail:'bank',...(foreignBank?{currency:'USD'}:{})});
    const lines=H.foreignRefundLines(S.docs[0],100,'bank',cad,'fx'),bank=lines.find(l=>l.account==='bank'),ctl=lines.find(l=>l.account===(kind==='credit'?'ar':'ap'));
    assert.equal(ctl.debit-ctl.credit,kind==='credit'?130:-130);assert.equal(bank.debit-bank.credit,kind==='credit'?-cad:cad);
    assert.equal(lines.reduce((s,l)=>s+l.debit-l.credit,0),0);assert.equal(bank.fx?.amt,foreignBank?100:undefined);
    if(cad===130)assert.equal(lines.length,2);
  }
});

test('Inventory: saved PST cost agrees with the posted ledger, average cost, COGS and purchase returns', () => {
  const {S,H}=calculations();S.company={taxRate:12,pstRate:7,pstName:'PST'};
  S.accounts=[{id:'tax',detail:'tax'},{id:'pst',detail:'pst'},{id:'inv',type:'Asset'},{id:'ap',type:'Liability'}];
  S.items=[{id:'item',type:'inventory',assetAccount:'inv',cogsAccount:'cogs',cost:10}];
  const c=H.calcLines([{item:'item',account:'inv',qty:10,rate:10,taxCode:'std'}],l=>l.qty*l.rate,true);
  const ledger=H.docPostLines('bill',c,'ap'),doc=plain(H.docRecord(c));
  assert.equal(ledger.find(l=>l.account==='inv').debit,107);S.docs=[{id:'b',kind:'bill',date:'2026-09-01',...doc}];
  assert.equal(H.stockAt('item','2026-09-30').value,107);
  const sale={ls:[{item:'item',qty:2}]};H.invCosts('invoice',sale,'2026-09-02','sale');assert.equal(sale.ls[0].cost,21.4);
  S.docs.push({id:'sale',kind:'invoice',date:'2026-09-02',lines:sale.ls});assert.equal(H.stockAt('item','2026-09-30').value,85.6);
  S.docs.push({id:'return',kind:'vcredit',date:'2026-09-03',...doc});assert.equal(H.stockPurchaseCosts(S.docs[2])[0],107);
});
test('Inventory: PST allocation includes non-inventory lines, tax-exempt lines, discounts, FX and cent rounding', () => {
  const {S,H}=calculations();S.company={taxRate:12,pstRate:7,pstName:'RST'};S.accounts=[{id:'tax',detail:'tax'},{id:'pst',detail:'pst'}];
  const c=H.calcLines([{account:'inv',qty:1,rate:100,taxCode:'std'},{account:'other',qty:1,rate:100,taxCode:'std'},{account:'discount',qty:1,rate:-10,taxCode:'std'},{account:'exempt',qty:1,rate:100,taxCode:'none'}],l=>l.qty*l.rate,true);
  const saved=plain(H.docRecord(c));assert.deepEqual(plain(H.stockPurchaseCosts(saved)),c.ls.map(l=>l.post??l.net));
  assert.deepEqual(plain(H.stockPurchaseCosts({...saved,fx:1.4})),c.ls.map(l=>Math.round((l.post??l.net)*140)/100));
});
test('Dates: reject calendar normalization, accept actual leap days and month ends', () => {
  for(const d of ['2026-02-31','2026-02-29','2026-04-31','2026-13-01','2026-00-01','2026-01-00','2026-2-01'])assert.equal(isDate(d),false,d);
  for(const d of ['2024-02-29','2026-02-28','2026-04-30','2026-12-31'])assert.equal(isDate(d),true,d);
});

let server,dir,base,cookie,co;
before(async()=>{
  dir=fs.mkdtempSync(path.join(os.tmpdir(),'sumlora-accounting-fixes-'));server=createApp({dataDir:dir,autoBackup:false,autoFeeds:false});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));base='http://127.0.0.1:'+server.address().port;
  const setup=await fetch(base+'/api/auth/setup',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:'Audit test',username:'audit@example.com',password:'correct horse battery staple'})});
  assert.equal(setup.status,200);cookie=setup.headers.get('set-cookie').split(';')[0];
  co=(await request('POST','/api/companies',{name:'Accounting regressions',province:'ON'})).body.company.id;
  await call('PUT','/records/contacts/customer',{name:'Customer',kind:'customer'});
});
after(async()=>{if(server)await server.shutdown();if(dir)fs.rmSync(dir,{recursive:true,force:true})});
async function request(method,url,body){const r=await fetch(base+url,{method,headers:{'Content-Type':'application/json',cookie},body:body===undefined?undefined:JSON.stringify(body)});return{status:r.status,body:await r.json()};}
const call=(method,url,body)=>request(method,'/api/c/'+co+url,body);
const invoice=(extra={})=>({kind:'invoice',date:'2026-09-01',contactId:'customer',lines:[{account:'a4000',qty:1,rate:100,taxCode:'none'}],sub:100,tax:0,total:100,...extra});
test('Server: inconsistent documents and payment metadata are rejected atomically, with valid partial payments kept',async()=>{
  let r=await call('POST','/batch',{writes:[{op:'set',collection:'contacts',id:'rolled-back',data:{name:'Never saved',kind:'customer'}},{op:'set',collection:'docs',id:'bad',data:invoice({total:999})}]});assert.equal(r.status,400);
  assert.ok(!(await call('GET','/state')).body.contacts.some(c=>c.id==='rolled-back'));
  for(const extra of [{sub:999},{tax:5},{taxParts:[{name:'GST',rate:5,amount:5}]},{carried:true,total:999},{lines:[{account:'a4000',qty:'oops',rate:100}]}])assert.equal((await call('PUT','/records/docs/bad',invoice(extra))).status,400);
  assert.equal((await call('PUT','/records/docs/i',invoice())).status,200);
  assert.equal((await call('PUT','/records/docs/fake-opening',invoice({carried:true}))).status,400,'a plain record write cannot fabricate a migrated opening balance');
  const payment={type:'payment',date:'2026-09-02',applyTo:'i',amount:100,bank:'a1000',contactId:'customer',lines:[{account:'a1000',debit:1,credit:0},{account:'a1200',debit:0,credit:1}]};
  assert.equal((await call('PUT','/records/entries/p',payment)).status,400);
  assert.equal((await call('PUT','/records/entries/p',{...payment,type:'journal'})).status,400,'journals cannot fake settlement metadata');
  assert.equal((await call('PUT','/records/entries/p',{...payment,amount:20,lines:[{account:'a1000',debit:20,credit:0},{account:'a1200',debit:0,credit:20}]})).status,200);
  assert.equal((await call('PUT','/records/docs/i',invoice({lines:[{account:'a4000',qty:1,rate:10}],sub:10,total:10}))).status,400,'cannot shrink below settled amount');
  assert.equal((await call('PUT','/records/docs/i',invoice({currency:'USD',fx:1.3}))).status,409,'cannot change the currency of a settled document');
});
test('Server: correct CAD and foreign payments and refunds survive the new checks',async()=>{
  assert.equal((await call('PUT','/records/docs/us',invoice({currency:'USD',fx:1.3}))).status,200);
  let r=await call('PUT','/records/entries/us-pay',{type:'payment',date:'2026-09-02',applyTo:'us',amount:100,currency:'USD',fx:1.4,cad:140,bank:'a1000',lines:[{account:'a1000',debit:140,credit:0},{account:'a1200',debit:0,credit:130},{account:'a4000',debit:0,credit:10}]});assert.equal(r.status,200,JSON.stringify(r.body));
  assert.equal((await call('PUT','/records/docs/credit',invoice({kind:'credit'}))).status,200);
  r=await call('PUT','/records/entries/refund',{type:'refund',date:'2026-09-02',applyTo:'credit',amount:20,bank:'a1000',lines:[{account:'a1200',debit:20,credit:0},{account:'a1000',debit:0,credit:20}]});assert.equal(r.status,200,JSON.stringify(r.body));
  assert.equal((await call('PUT','/records/accounts/us-bank',{name:'USD bank',code:'1099',type:'Asset',detail:'bank',currency:'USD'})).status,200);
  assert.equal((await call('PUT','/records/docs/us2',invoice({currency:'USD',fx:1.3}))).status,200);
  const foreign={type:'payment',date:'2026-09-02',applyTo:'us2',amount:100,currency:'USD',fx:1.4,bank:'us-bank',lines:[{account:'us-bank',debit:140,credit:0,fx:{cur:'USD',amt:1}},{account:'a1200',debit:0,credit:130},{account:'a4000',debit:0,credit:10}]};
  assert.equal((await call('PUT','/records/entries/us2-pay',foreign)).status,400,'foreign units must match too');
  foreign.lines[0].fx.amt=100;r=await call('PUT','/records/entries/us2-pay',foreign);assert.equal(r.status,200,JSON.stringify(r.body));
  assert.equal((await call('PUT','/records/docs/us-credit',invoice({kind:'credit',currency:'USD',fx:1.3}))).status,200);
  const c=calculations();c.S.accounts=(await call('GET','/state')).body.accounts;
  r=await call('PUT','/records/entries/us-refund',{type:'refund',date:'2026-09-02',applyTo:'us-credit',amount:100,currency:'USD',fx:1.4,cad:140,bank:'a1000',lines:plain(c.H.foreignRefundLines({kind:'credit',currency:'USD',fx:1.3},100,'a1000',140,'a6000'))});assert.equal(r.status,200,JSON.stringify(r.body));
});
test('Server: a document and its ledger control posting change together, and duplicates roll back',async()=>{
  const doc=invoice(),entry={type:'invoice',date:doc.date,docId:'linked',lines:[{account:'a1200',debit:100,credit:0},{account:'a4000',debit:0,credit:100}]};
  const write=(collection,id,data)=>({op:'set',collection,id,data});
  assert.equal((await call('POST','/batch',{writes:[write('docs','linked',doc),write('entries','d_linked',entry)]})).status,200);
  const next=invoice({lines:[{account:'a4000',qty:1,rate:200,taxCode:'none'}],sub:200,total:200});
  assert.equal((await call('PUT','/records/docs/linked',next)).status,400);
  assert.equal((await call('PUT','/records/entries/duplicate',entry)).status,400);
  assert.equal((await call('PUT','/records/entries/d_linked',{...entry,lines:[{account:'a1200',debit:1,credit:0},{account:'a4000',debit:0,credit:1}]})).status,400);
  const r=await call('POST','/batch',{writes:[write('docs','linked',next),write('entries','d_linked',{...entry,lines:[{account:'a1200',debit:200,credit:0},{account:'a4000',debit:0,credit:200}]})]});assert.equal(r.status,200,JSON.stringify(r.body));
  const state=(await call('GET','/state')).body;assert.equal(state.docs.find(d=>d.id==='linked').total,200);assert.ok(!state.entries.some(e=>e.id==='duplicate'));
});
test('Server: form rounding for fractional quantities, discounts and saved tax parts is retained',async()=>{
  let r=await call('PUT','/records/docs/fraction',invoice({lines:[{account:'a4000',qty:1.005,rate:1,taxCode:'none'}],sub:1.01,total:1.01}));assert.equal(r.status,200,JSON.stringify(r.body));
  r=await call('PUT','/records/docs/taxed',invoice({lines:[{account:'a4000',qty:1,rate:110,taxCode:'std'},{account:'a4000',qty:1,rate:-10,taxCode:'std'}],sub:100,tax:13,total:113,taxParts:[{name:'HST',rate:13,amount:13}]}));assert.equal(r.status,200,JSON.stringify(r.body));
});
test('Server: invalid dates fail, and concurrent calculations from the same revision cannot both post',async()=>{
  const journal={type:'journal',date:'2026-02-31',lines:[{account:'a1000',debit:1,credit:0},{account:'a3000',debit:0,credit:1}]};
  assert.equal((await call('PUT','/records/entries/bad-date',journal)).status,400);
  const rev=(await call('GET','/state')).body.rev;
  const body=id=>({expectedRev:rev,writes:[{op:'set',collection:'entries',id,data:{...journal,date:'2026-09-30'}}]});
  const rs=await Promise.all([call('POST','/batch',body('race1')),call('POST','/batch',body('race2'))]);assert.deepEqual(rs.map(r=>r.status).sort(),[200,409]);
  const entries=(await call('GET','/state')).body.entries;assert.equal(entries.filter(e=>e.id==='race1'||e.id==='race2').length,1);
});
