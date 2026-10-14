'use strict';
require('./setup-payroll-on'); // payroll on, as `npm test` does, so the server's own test run passes too
const test = require('node:test');
const assert = require('node:assert/strict');
const P = require('../public/payroll-calc.js');
const X = require('../public/payroll-xml.js');

/* CRA's 2026 T4 XML specification, as a list of each element's children in order: [name, required, max repeats].
   Checked here in plain JS (CRA doesn't publish the XSD outside its schema package). */
const T4_SPEC = {
  Submission: [['T619', 1], ['Return', 1]],
  T619: [['TransmitterAccountNumber', 0], ['TransmitterRepID', 0], ['sbmt_ref_id', 0], ['summ_cnt', 0], ['lang_cd', 1], ['TransmitterName', 1], ['TransmitterCountryCode', 1], ['CNTC', 1]],
  TransmitterAccountNumber: [['bn9', 0], ['bn15', 0], ['trust', 0], ['nr4', 0]],
  TransmitterName: [['l1_nm', 1]],
  'T619/CNTC': [['cntc_nm', 1], ['cntc_area_cd', 1], ['cntc_phn_nbr', 1], ['cntc_extn_nbr', 0], ['cntc_email_area', 1], ['sec_cntc_email_area', 0]],
  Return: [['T4', 1]],
  T4: [['T4Slip', 1, Infinity], ['T4Summary', 1]],
  T4Slip: [['EMPE_NM', 1], ['EMPE_ADDR', 0], ['sin', 1], ['empe_nbr', 0], ['bn', 1], ['rpp_dpsp_rgst_nbr', 0], ['cpp_qpp_xmpt_cd', 1], ['ei_xmpt_cd', 1],
    ['prov_pip_xmpt_cd', 0], ['empt_cd', 0], ['rpt_tcd', 1], ['empt_prov_cd', 1], ['empr_dntl_ben_rpt_cd', 1], ['T4_AMT', 1], ['OTH_INFO', 0]],
  EMPE_NM: [['snm', 1], ['gvn_nm', 0], ['init', 0]],
  EMPE_ADDR: [['addr_l1_txt', 0], ['addr_l2_txt', 0], ['cty_nm', 0], ['prov_cd', 0], ['cntry_cd', 0], ['pstl_cd', 0]],
  T4_AMT: [['empt_incamt', 0], ['cpp_cntrb_amt', 0], ['cppe_cntrb_amt', 0], ['qpp_cntrb_amt', 0], ['qppe_cntrb_amt', 0], ['empe_eip_amt', 0], ['rpp_cntrb_amt', 0],
    ['itx_ddct_amt', 0], ['ei_insu_ern_amt', 1], ['cpp_qpp_ern_amt', 1], ['unn_dues_amt', 0], ['chrty_dons_amt', 0], ['padj_amt', 0], ['prov_pip_amt', 0], ['prov_insu_ern_amt', 0]],
  T4Summary: [['bn', 1], ['EMPR_NM', 1], ['EMPR_ADDR', 0], ['CNTC', 1], ['tx_yr', 1], ['slp_cnt', 1], ['PPRTR_SIN', 0], ['rpt_tcd', 1], ['fileramendmentnote', 0], ['T4_TAMT', 1]],
  EMPR_NM: [['l1_nm', 1], ['l2_nm', 0], ['l3_nm', 0]],
  EMPR_ADDR: [['addr_l1_txt', 0], ['addr_l2_txt', 0], ['cty_nm', 0], ['prov_cd', 0], ['cntry_cd', 0], ['pstl_cd', 0]],
  'T4Summary/CNTC': [['cntc_nm', 1], ['cntc_area_cd', 1], ['cntc_phn_nbr', 1], ['cntc_extn_nbr', 0]],
  T4_TAMT: X.T4_TAMT_ORDER.map(k => [k, 0]),
};
const T4_LEAF = {
  sin: /^\d{9}$/, bn: /^\d{9}RP\d{4}$/, bn15: /^\d{9}RP\d{4}$/, cpp_qpp_xmpt_cd: /^[01]$/, ei_xmpt_cd: /^[01]$/, prov_pip_xmpt_cd: /^[01]$/, rpt_tcd: /^[OAC]$/,
  empt_prov_cd: /^(AB|BC|MB|NB|NL|NS|NT|NU|ON|PE|QC|SK|YT|US|ZZ)$/, empr_dntl_ben_rpt_cd: /^[1-5]$/, lang_cd: /^[EF]$/, TransmitterCountryCode: /^(CAN|USA)$/,
  sbmt_ref_id: /^[A-Za-z0-9]{1,8}$/, summ_cnt: /^\d{1,6}$/, cntc_area_cd: /^\d{3}$/, cntc_phn_nbr: /^\d{3}-\d{4}$/, tx_yr: /^\d{4}$/, slp_cnt: /^\d{1,7}$/,
  snm: /^.{1,20}$/, gvn_nm: /^.{1,12}$/, init: /^[A-Za-z]$/, l1_nm: /^.{1,35}$/, cntc_nm: /^.{1,35}$/, addr_l1_txt: /^.{1,30}$/, addr_l2_txt: /^.{1,30}$/, cty_nm: /^.{1,28}$/,
  prov_cd: /^[A-Z]{2}$/, cntry_cd: /^[A-Z]{3}$/, pstl_cd: /^[A-Z0-9-]{1,10}$/, rpp_dpsp_rgst_nbr: /^\d{7}$/,
};
const AMOUNT = /^\d{1,13}\.\d{2}$/;
/** Check a parsed tree against the spec: element order, required elements, repeats, leaf formats. Returns problems. */
function checkSpec(n, path = n.name, out = []) {
  const key = T4_SPEC[`${path.split('/').slice(-2).join('/')}`] ? path.split('/').slice(-2).join('/') : n.name;
  const spec = T4_SPEC[key];
  if (spec) {
    let i = 0;
    for (const [name, req, max = 1] of spec) {
      let count = 0;
      while (i < n.children.length && n.children[i].name === name) { count++; i++; }
      if (req && !count) out.push(`${path}: missing ${name}`);
      if (count > max) out.push(`${path}: ${name} ${count} times`);
    }
    if (i < n.children.length) out.push(`${path}: unexpected or out of order ${n.children[i].name}`);
    for (const c of n.children) checkSpec(c, path + '/' + c.name, out);
  } else if (n.children.length) {
    if (n.name !== 'OTH_INFO' && n.name !== 'TransmitterRepID') out.push(`${path}: unknown parent`);
    for (const c of n.children) checkSpec(c, path + '/' + c.name, out);
  } else {
    if (n.text === '') out.push(`${path}: empty`);
    const re = T4_LEAF[n.name] || (/_amt$|_incamt$|^tot_/.test(n.name) ? AMOUNT : null);
    if (re && !re.test(n.text)) out.push(`${path}: "${n.text}" doesn't fit ${re}`);
  }
  return out;
}

function yearOfPays(emp, gross, prov, extra = {}) {
  const runs = [];
  const ytd = { pensionable: 0, cpp: 0, cpp2: 0, qpp: 0, qpp2: 0, ei: 0, qpip: 0, erQpip: 0 };
  for (let i = 0; i < 26; i++) {
    const d = new Date(Date.UTC(2026, 0, 9 + 14 * i)).toISOString().slice(0, 10);
    const r = P.calc({ date: '2026-07-15', prov, P: 26, gross, ytd: { ...ytd } });
    for (const k of ['cpp', 'cpp2', 'qpp', 'qpp2', 'ei', 'qpip']) ytd[k] = P.r2(ytd[k] + r.employee[k]);
    ytd.pensionable += gross; ytd.erQpip = P.r2(ytd.erQpip + r.employer.qpip);
    const net = P.r2(gross - Object.values(r.employee).reduce((s, v) => s + v, 0));
    runs.push({ payDate: d, lines: [{ employeeId: emp, prov, gross, rrsp: extra.rrsp || 0, union: extra.union || 0, ded: r.employee, er: r.employer, net, benefits: extra.benefits }] });
  }
  return runs;
}
const employees = [
  { id: 'e1', name: 'Pat O’Brien', prov: 'ON', sin: '130 692 544', dental: 3, address: '12 Main St\nApt 4\nOttawa ON K1A 0B1' },
  { id: 'q1', name: 'Marie-Ève J. Tremblay & Fils', prov: 'QC', sin: '130692551', dental: 1, addr: { line1: '400 rue <Sainte-Catherine>', city: 'Montréal', prov: 'QC', postal: 'H3B 1A1', country: 'CAN' } },
  { id: 'r1', name: 'Sam Lee', prov: 'ON', sin: '146454285', dental: 2, pensionType: 'rpp', rppNo: '1234567', paByYear: { 2026: 5100 }, address: '5 Elm Ave, Toronto, Ontario M5V 2T6' },
];
const runs = [...yearOfPays('e1', 3000, 'ON', { union: 20, benefits: { board: 50, auto: 25 } }), ...yearOfPays('q1', 4500, 'QC'), ...yearOfPays('r1', 2000, 'ON', { rrsp: 100 })];
const ye = P.yearEnd({ year: 2026, employees, payruns: runs });
const employer = { name: 'Maple & Oak Café Incorporated of Eastern Ontario', bn: '123456789 rp 0001', addr: { line1: '1 Rideau St', city: 'Ottawa', prov: 'ON', postal: 'K1N8S7', country: 'CAN' } };
const transmitter = { contact: 'Sher Sahray', phone: '(613) 555-1234 ext. 22', email: 'payroll@example.com' };

test('T4 XML: well-formed, CRA element order, required elements and formats', () => {
  const out = X.t4Xml({ ye, employees, employer, transmitter, ref: 'ABC-123' });
  assert.ok(out.xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>\n<Submission xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">'));
  const root = X.parseXml(out.xml);
  assert.equal(root.name, 'Submission');
  assert.deepEqual(checkSpec(root), []);
  const t619 = X.kid(root, 'T619');
  assert.equal(X.kid(X.kid(t619, 'TransmitterAccountNumber'), 'bn15').text, '123456789RP0001');
  assert.equal(X.kid(t619, 'sbmt_ref_id').text, 'ABC123', 'no hyphens in the submission reference');
  assert.equal(X.kid(t619, 'summ_cnt').text, '1');
  const cntc = X.kid(t619, 'CNTC');
  assert.deepEqual(['cntc_area_cd', 'cntc_phn_nbr', 'cntc_extn_nbr'].map(k => X.kid(cntc, k).text), ['613', '555-1234', '22']);
  assert.equal(out.xml.match(/<T4Slip>/g).length, 3);
  assert.equal(out.slips, 3);
});

test('T4 XML: slip boxes, exemptions, codes and the RPP number', () => {
  const root = X.parseXml(X.t4Xml({ ye, employees, employer, transmitter }).xml);
  const slips = X.kids(X.kid(X.kid(root, 'Return'), 'T4'), 'T4Slip');
  const bySin = Object.fromEntries(slips.map(s => [X.kid(s, 'sin').text, s]));
  const amt = (s, k) => (X.kid(X.kid(s, 'T4_AMT'), k) || { text: '' }).text;
  const pat = bySin['130692544'], qc = bySin['130692551'], rpp = bySin['146454285'];
  const tPat = ye.slips.find(s => s.employeeId === 'e1').t4;
  assert.equal(X.kid(X.kid(pat, 'EMPE_NM'), 'snm').text, "O'Brien", 'a curly apostrophe becomes one CRA accepts');
  assert.equal(amt(pat, 'empt_incamt'), tPat[14].toFixed(2));
  assert.equal(amt(pat, 'cpp_cntrb_amt'), '4230.45');
  assert.equal(amt(pat, 'cppe_cntrb_amt'), tPat['16A'].toFixed(2));
  assert.equal(amt(pat, 'unn_dues_amt'), '520.00');
  assert.equal(amt(pat, 'ei_insu_ern_amt'), '68900.00');
  assert.equal(amt(pat, 'qpp_cntrb_amt'), '', 'empty optional boxes are left out');
  assert.equal(X.kid(pat, 'empt_prov_cd').text, 'ON');
  assert.equal(X.kid(pat, 'empr_dntl_ben_rpt_cd').text, '3');
  assert.equal(X.kid(pat, 'prov_pip_xmpt_cd'), null, 'PPIP code only for Quebec');
  const oth = X.kid(pat, 'OTH_INFO');
  assert.equal(X.kid(oth, 'hm_brd_lodg_amt').text, '1300.00', 'code 30');
  assert.equal(X.kid(oth, 'prsnl_vhcl_amt').text, '650.00', 'code 34');
  const addr = X.kid(pat, 'EMPE_ADDR');
  assert.deepEqual(['addr_l1_txt', 'addr_l2_txt', 'cty_nm', 'prov_cd', 'cntry_cd', 'pstl_cd'].map(k => X.kid(addr, k).text), ['12 Main St', 'Apt 4', 'Ottawa', 'ON', 'CAN', 'K1A0B1']);
  // Quebec: QPP, PPIP boxes; name parts; characters escaped.
  assert.equal(amt(qc, 'qpp_cntrb_amt'), '4479.30'); assert.equal(amt(qc, 'qppe_cntrb_amt'), '416.00');
  assert.equal(amt(qc, 'prov_pip_amt'), '442.90'); assert.equal(amt(qc, 'prov_insu_ern_amt'), '103000.00');
  assert.equal(X.kid(qc, 'prov_pip_xmpt_cd').text, '0');
  const nm = X.kid(qc, 'EMPE_NM');
  assert.deepEqual(['snm', 'gvn_nm', 'init'].map(k => X.kid(nm, k).text), ['Fils', 'Marie-Ève', 'J']);
  assert.equal(X.kid(X.kid(qc, 'EMPE_ADDR'), 'addr_l1_txt').text, '400 rue Sainte-Catherine', 'characters CRA doesn’t accept are dropped');
  // RPP: box 20, 50 and 52.
  assert.equal(amt(rpp, 'rpp_cntrb_amt'), '2600.00'); assert.equal(X.kid(rpp, 'rpp_dpsp_rgst_nbr').text, '1234567'); assert.equal(amt(rpp, 'padj_amt'), '5100.00');
  assert.equal(X.kid(X.kid(rpp, 'EMPE_ADDR'), 'cty_nm').text, 'Toronto');
});

test('T4 XML: the summary totals are the sum of the slips', () => {
  const out = X.t4Xml({ ye, employees, employer, transmitter });
  const root = X.parseXml(out.xml), t4 = X.kid(X.kid(root, 'Return'), 'T4');
  const slips = X.kids(t4, 'T4Slip'), sum = X.kid(t4, 'T4Summary'), tamt = X.kid(sum, 'T4_TAMT');
  const add = k => slips.reduce((t, s) => t + Number((X.kid(X.kid(s, 'T4_AMT'), k) || { text: 0 }).text), 0).toFixed(2);
  const tot = k => X.kid(tamt, k).text;
  assert.equal(tot('tot_empt_incamt'), add('empt_incamt'));
  assert.equal(tot('tot_empe_cpp_amt'), add('cpp_cntrb_amt'));
  assert.equal(tot('tot_empe_cppe_amt'), add('cppe_cntrb_amt'));
  assert.equal(tot('tot_empe_eip_amt'), add('empe_eip_amt'));
  assert.equal(tot('tot_rpp_cntrb_amt'), add('rpp_cntrb_amt'));
  assert.equal(tot('tot_itx_ddct_amt'), add('itx_ddct_amt'));
  assert.equal(tot('tot_padj_amt'), add('padj_amt'));
  // Employer amounts match the year-end summary (box 27, 27A and 19), not QPP.
  assert.equal(tot('tot_empr_cpp_amt'), ye.t4sum[27].toFixed(2));
  assert.equal(tot('tot_empr_cppe_amt'), ye.t4sum['27A'].toFixed(2));
  assert.equal(tot('tot_empr_eip_amt'), ye.t4sum[19].toFixed(2));
  assert.equal(tot('tot_empt_incamt'), ye.t4sum[14].toFixed(2));
  assert.equal(X.kid(sum, 'slp_cnt').text, '3'); assert.equal(X.kid(sum, 'tx_yr').text, '2026');
  const nm = X.kid(sum, 'EMPR_NM');
  assert.equal(X.kid(nm, 'l1_nm').text, 'Maple & Oak Café Incorporated');
  assert.equal(X.kid(nm, 'l2_nm').text, 'of Eastern Ontario');
  assert.ok(out.xml.includes('Maple &amp; Oak'), '& is escaped');
  assert.equal(X.kid(X.kid(sum, 'CNTC'), 'cntc_extn_nbr').text, '22');
});

test('T4 XML: problems are listed and stop the file', () => {
  const bad = [{ ...employees[0], sin: '123', address: '' }, { ...employees[1], dental: 0 }];
  const ye2 = P.yearEnd({ year: 2026, employees: bad, payruns: runs.filter(r => r.lines[0].employeeId !== 'r1') });
  const ps = X.t4Problems({ ye: ye2, employees: bad, employer: { name: 'X', bn: '123' }, transmitter: { contact: '', phone: '555', email: 'nope' } });
  const codes = ps.map(p => p.code);
  for (const c of ['bn', 'transmitter-bn', 'contact', 'phone', 'email', 'slip-sin-invalid', 'slip-dental', 'addr-missing']) assert.ok(codes.includes(c), c);
  assert.equal(ps.find(p => p.code === 'addr-missing').level, 'warn');
  assert.throws(() => X.t4Xml({ ye: ye2, employees: bad, employer: { name: 'X', bn: '123' }, transmitter }), e => e.code === 'PROBLEMS' && e.problems.length > 0);
  // A RepID alone identifies the transmitter (Represent a Client).
  const rep = X.t4Xml({ ye, employees, employer, transmitter: { ...transmitter, bn: 'none', repId: 'ab12cd3' } });
  const t619 = X.kid(X.parseXml(rep.xml), 'T619');
  assert.equal(X.kid(t619, 'TransmitterAccountNumber'), null);
  assert.equal(X.kid(X.kid(t619, 'TransmitterRepID'), 'RepID').text, 'AB12CD3');
  assert.deepEqual(checkSpec(X.parseXml(rep.xml)), []);
});

test('Address parsing and helpers', () => {
  assert.deepEqual(X.parseAddress('12 Main St\nApt 4\nOttawa ON K1A 0B1'), { line1: '12 Main St', line2: 'Apt 4', city: 'Ottawa', prov: 'ON', postal: 'K1A0B1', country: 'CAN' });
  assert.deepEqual(X.parseAddress('5 Elm Ave, Toronto, Ontario M5V 2T6'), { line1: '5 Elm Ave', line2: '', city: 'Toronto', prov: 'ON', postal: 'M5V2T6', country: 'CAN' });
  assert.deepEqual(X.parseAddress('99 Rue Principale\nGatineau, Québec\nJ8X 1C1\nCanada'), { line1: '99 Rue Principale', line2: '', city: 'Gatineau', prov: 'QC', postal: 'J8X1C1', country: 'CAN' });
  assert.deepEqual(X.addressProblems(X.parseAddress('somewhere')), ['city', 'prov', 'postal']);
  assert.equal(X.addressOf({ address: 'x', addr: { line1: '1 A St', city: 'B', prov: 'on', postal: 'K1A0B1' } }).prov, 'ON');
  assert.equal(X.esc(`a&b<c>"d'e\u0001`), 'a&amp;b&lt;c&gt;&quot;d&apos;e');
  assert.equal(X.amt(1234.5), '1234.50'); assert.equal(X.amt(-3), '0.00'); assert.equal(X.amt('0.005'), '0.01');
  assert.deepEqual(X.splitPhone('1-613-555-0199'), { area: '613', number: '555-0199', ext: '', ok: true });
  assert.equal(X.splitPhone('555-0199').ok, false);
  assert.deepEqual(X.splitName('Cher'), { first: '', initial: '', last: 'Cher' });
  assert.throws(() => X.parseXml('<a><b></a>'), /Not well-formed/);
  assert.throws(() => X.parseXml('<a>x & y</a>'), /bare &/);
  assert.equal(X.parseXml('<a q="1&amp;2"><b>&lt;x&gt;</b></a>').children[0].text, '<x>');
});

/* ---------- ROE ---------- */
const roeEmp = { id: 'emp01', name: 'Jordan A. Smith', sin: '130692544', address: '7 King St W\nToronto ON M5H 1A1' };
const lines = [
  { from: '2026-08-02', to: '2026-08-15', payDate: '2026-08-21', insurable: 2000, hours: 80 },
  { from: '2026-08-30', to: '2026-09-12', payDate: '2026-09-18', insurable: 2100, hours: 84 },
  { from: '2026-09-13', to: '2026-09-26', payDate: '2026-10-02', insurable: 2500, hours: 80.5, separationVac: 400 },
];
const calc = P.roe({ freq: 'biweekly', finalPeriodEnd: '2026-09-26', lines });
const roe = { reason: 'E', reasonCode: 'E03', firstDay: '2026-08-02', lastDay: '2026-09-26', finalEnd: '2026-09-26', occupation: 'Line cook', recall: 'N', contact: 'Sher Sahray',
  phone: '416 555 0100 x 7', holDate: '2026-10-12', holAmt: 160, otherCd: 'Y00', otherAmt: 900, comments: 'Back to school & studies',
  calc: { type: calc.type, hours: calc.hours, vacation: calc.vacation, periods: calc.periods.map(p => ({ n: p.n, from: p.from, to: p.to, amount: p.amount })) } };

test('ROE XML: header, blocks in order, pay periods from the final one back to the first day worked', () => {
  const out = X.roeXml({ items: [{ roe, employee: roeEmp }], employer: { bn: '123456789RP0001' }, product: { vendor: 'Sumlora', name: 'Sumlora', version: '1.3.0' } });
  assert.ok(out.xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>\n<ROEHEADER FileVersion="W-2.0" SoftwareVendor="Sumlora" ProductName="Sumlora" ProductVersion="1.3.0">'));
  const root = X.parseXml(out.xml);
  const r = X.kid(root, 'ROE');
  assert.deepEqual(r.attrs, { PrintingLanguage: 'E', Issue: 'D' });
  const ORDER = ['B2', 'B3', 'B5', 'B6', 'B8', 'B9', 'B10', 'B11', 'B12', 'B13', 'B14', 'B15A', 'B15C', 'B16', 'B17A', 'B17B', 'B17C', 'B18', 'B19', 'B20'];
  const got = r.children.map(c => c.name);
  assert.deepEqual(got, ORDER.filter(n => got.includes(n)), 'blocks in the specification’s order');
  for (const req of ['B5', 'B6', 'B8', 'B9', 'B10', 'B11', 'B12', 'B14', 'B15A', 'B15C', 'B16']) assert.ok(got.includes(req), req);
  assert.equal(X.kid(r, 'B2'), null, 'no serial number on a new ROE');
  assert.equal(X.kid(r, 'B3').text, 'emp01');
  assert.equal(X.kid(r, 'B5').text, '123456789RP0001'); assert.equal(X.kid(r, 'B6').text, 'B'); assert.equal(X.kid(r, 'B8').text, '130692544');
  const b9 = X.kid(r, 'B9');
  assert.deepEqual(b9.children.map(c => [c.name, c.text]), [['FN', 'Jordan'], ['MN', 'A'], ['LN', 'Smith'], ['A1', '7 King St W'], ['A2', 'Toronto'], ['A3', 'Ontario, Canada'], ['PC', 'M5H1A1']]);
  assert.deepEqual(X.kid(r, 'B14').children.map(c => [c.name, c.text]), [['CD', 'N']]);
  assert.equal(X.kid(r, 'B15A').text, '245', 'hours rounded up to a whole number');
  const pps = X.kids(X.kid(r, 'B15C'), 'PP');
  assert.deepEqual(pps.map(p => [p.attrs.nbr, X.kid(p, 'AMT').text]), [['1', '2100.00'], ['2', '2100.00'], ['3', '0.00'], ['4', '2000.00']],
    'PP1 is the final period; periods with no pay are 0.00; nothing before the first day worked');
  const b16 = X.kid(r, 'B16');
  assert.deepEqual(b16.children.map(c => [c.name, c.text]), [['CD', 'E03'], ['FN', 'Sher'], ['LN', 'Sahray'], ['AC', '416'], ['TEL', '5550100'], ['EXT', '7']]);
  assert.deepEqual(X.kid(X.kid(r, 'B17A'), 'VP').children.map(c => [c.name, c.text]), [['CD', '2'], ['AMT', '400.00']]);
  assert.deepEqual(X.kid(X.kid(r, 'B17B'), 'SH').children.map(c => [c.name, c.text]), [['DT', '2026-10-12'], ['AMT', '160.00']]);
  assert.deepEqual(X.kid(X.kid(r, 'B17C'), 'OM').children.map(c => [c.name, c.text]), [['CD', 'Y00'], ['AMT', '900.00']]);
  assert.equal(X.kid(r, 'B18').text, 'Back to school & studies');
  assert.ok(out.xml.includes('Back to school &amp; studies'));
});

test('ROE XML: several ROEs in one file, and problems listed before anything is made', () => {
  const two = X.roeXml({ items: [{ roe, employee: roeEmp }, { roe: { ...roe, reasonCode: '' , reason: 'A' }, employee: { ...roeEmp, id: 'e2', name: 'Alex Roy' } }], employer: { bn: '123456789RP0001' }, lang: 'F' });
  const roes = X.kids(X.parseXml(two.xml), 'ROE');
  assert.equal(roes.length, 2); assert.equal(two.count, 2);
  assert.equal(X.kid(X.kid(roes[1], 'B16'), 'CD').text, 'A00');
  assert.equal(roes[1].attrs.PrintingLanguage, 'F'); assert.equal(X.kid(roes[1], 'B20').text, 'F');
  const badEmp = { name: 'Solo', sin: '000000000', address: '' };
  const err = (() => { try { X.roeXml({ items: [{ roe: { ...roe, contact: 'Me', phone: '123', reason: 'K', reasonCode: '', comments: '', otherCd: '' }, employee: badEmp }], employer: { bn: 'x' } }); } catch (e) { return e; } })();
  assert.equal(err.code, 'PROBLEMS');
  const codes = err.problems.map(p => p.code + (p.part ? ':' + p.part : ''));
  for (const c of ['bn', 'sin', 'name', 'addr:line1', 'addr:city', 'addr:prov', 'addr:postal', 'contact', 'phone', 'other-code', 'comments']) assert.ok(codes.includes(c), c);
  assert.throws(() => X.roeXml({ items: [] }), /at least one/);
});

test('ROE only counts pay since the employee’s previous ROE', () => {
  const all = [
    { from: '2026-03-01', to: '2026-03-14', payDate: '2026-03-20', insurable: 1800, hours: 72 },
    { from: '2026-03-15', to: '2026-03-28', payDate: '2026-04-03', insurable: 1800, hours: 72 }, // first ROE ended here (leave of absence)
    { from: '2026-08-30', to: '2026-09-12', payDate: '2026-09-18', insurable: 2100, hours: 84 },
    { from: '2026-09-13', to: '2026-09-26', payDate: '2026-10-02', insurable: 2500, hours: 80 },
  ];
  const { since, lines: after } = P.roeSince(all, [{ reason: 'N', finalEnd: '2026-03-28' }, { reason: 'x', finalEnd: '' }]);
  assert.equal(since, '2026-03-28');
  assert.deepEqual(after.map(l => l.to), ['2026-09-12', '2026-09-26']);
  const r = P.roe({ freq: 'biweekly', finalPeriodEnd: '2026-09-26', lines: after });
  assert.equal(r.totalEarnings, 4600); assert.equal(r.hours, 164);
  const before = P.roe({ freq: 'biweekly', finalPeriodEnd: '2026-09-26', lines: all });
  assert.equal(before.totalEarnings, 8200, 'without the fix the earlier pay was counted again');
  assert.deepEqual(P.roeSince(all, []).lines.length, 4, 'a first ROE counts everything');
  assert.equal(P.roeSince(all, undefined).since, '');
});

/* ---------- the server keeps the new fields, and checks them ---------- */
const V = require('../src/server/validate');
test('Server: employee address parts, ROE codes, transmitter and employer address', () => {
  const base = { name: 'Ann Lee', prov: 'ON', freq: 'biweekly', payType: 'salary', rate: 50000 };
  const e = V.validateRecord('employees', 'e1', { ...base, address: 'old text', addr: { line1: '1 A St', city: 'Ottawa', prov: 'on', postal: 'k1a 0b1', extra: 1 } });
  assert.deepEqual(e.addr, { line1: '1 A St', line2: '', city: 'Ottawa', prov: 'ON', postal: 'K1A0B1', country: 'CAN' });
  assert.equal(e.address, 'old text', 'the free-text address is kept');
  assert.equal(V.validateRecord('employees', 'e1', { ...base, addr: { line1: '', city: '' } }).addr, null);
  assert.equal(V.validateRecord('employees', 'e1', base).addr, undefined, 'employees without parts are left alone');
  assert.throws(() => V.validateRecord('employees', 'e1', { ...base, addr: { line1: '1 A St', postal: '12345' } }), /postal code/);
  assert.throws(() => V.validateRecord('employees', 'e1', { ...base, addr: { line1: '1 A St', prov: 'XX' } }), /province/);
  assert.equal(V.validateRecord('employees', 'e1', { ...base, addr: { line1: '1 A St', city: 'Buffalo', prov: 'NY', postal: '14201-1234', country: 'USA' } }).addr.postal, '14201-1234');
  assert.throws(() => V.validateRecord('employees', 'e1', { ...base, roes: [{ reason: 'E', reasonCode: 'quit' }] }), /reason code/);
  assert.throws(() => V.validateRecord('employees', 'e1', { ...base, roes: [{ reason: 'E', otherCd: '<x>' }] }), /other money/);
  assert.equal(V.validateRecord('employees', 'e1', { ...base, roes: [{ reason: 'E', reasonCode: 'E03', otherCd: 'Y00' }] }).roes[0].otherCd, 'Y00');
  const c = V.validateCompany({ name: 'X', payroll: { transmitter: { repId: 'ab-12', name: 'Firm', contact: 'Sher S', phone: '613 555 1234', email: 'bad', email2: 'b@c.ca', junk: 1 },
    employerAddr: { line1: '1 Rideau St', city: 'Ottawa', prov: 'ON', postal: 'K1N 8S7' } } });
  assert.deepEqual(c.payroll.transmitter, { repId: 'AB12', name: 'Firm', contact: 'Sher S', phone: '613 555 1234', email: '', email2: 'b@c.ca' });
  assert.equal(c.payroll.employerAddr.postal, 'K1N8S7');
});
