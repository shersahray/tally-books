'use strict';
// Read-only GL selection for audit testing. The debit total is the total of each balanced
// journal entry; auditors must verify that it represents the gross source document.
function ledgerCandidates(entries,{limit=200}={}) {
  if(!Array.isArray(entries)||!Number.isInteger(limit)||limit<1||limit>500)throw new TypeError('Invalid GL selection');
  return entries.filter(e=>e&&typeof e.id==='string'&&Array.isArray(e.lines))
    .slice(-limit).map(e=>{
      const debit=e.lines.reduce((sum,l)=>sum+(Number(l?.debit)||0),0);
      const credit=e.lines.reduce((sum,l)=>sum+(Number(l?.credit)||0),0);
      return {id:e.id,date:e.date||'',invoiceNumber:e.ref||'',vendor:e.memo||e.payee||'',
        amount:Math.round(debit*100)/100,balanced:Math.abs(debit-credit)<0.011,
        warning:'Journal debit total is not necessarily an invoice total; verify before matching'};
    }).filter(e=>e.balanced&&e.amount>0);
}
module.exports={ledgerCandidates};
