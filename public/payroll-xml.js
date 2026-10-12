/*
 * Sumlora electronic payroll files:
 *   - T4 return XML (T619 transmittal + T4 slips + T4 Summary) for CRA's "Internet file transfer (XML)"
 *     in My Business Account / Represent a Client, following CRA's 2026 XML specifications
 *     ("T619, Electronic Transmittal" and "T4, Statement of Remuneration Paid").
 *   - ROE Web "payroll extract" XML (FileVersion W-2.0) for Service Canada's ROE Web bulk upload
 *     ("ROE Web user requirements – Appendix D").
 *
 * Works in the browser (window.TallyXML) and in Node (require) so the tests can check it.
 *
 * Rules from the specifications that shape this file:
 *   - UTF-8, `<?xml version="1.0" encoding="UTF-8"?>` on the first line with nothing before it.
 *   - Optional elements with no value are left out (CRA rejects empty optional tags).
 *   - Amounts: two decimals, "." separator, no spaces, commas or "$"; never negative.
 *   - CRA keeps only its "acceptable characters" in names and addresses and drops the rest, so they're dropped
 *     here first; & < > " ' are escaped as entities.
 *   - Since the 2025 T619, the transmitter is identified by the account it signs in with (bn15, or a RepID when
 *     filing through Represent a Client). The old MM555555 transmitter number for self-filers is gone.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.TallyXML = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* ---------- helpers ---------- */
  const ENT = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' };
  /** Escape text for XML content or an attribute value. Control characters XML 1.0 can't carry are dropped. */
  const esc = v => String(v ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/g, '').replace(/[&<>"']/g, c => ENT[c]);
  const digits = v => String(v ?? '').replace(/\D/g, '');
  const num = v => (Number.isFinite(Number(v)) ? Number(v) : 0);
  const r2 = n => Math.round((num(n) + Number.EPSILON) * 100) / 100;
  /** 1234.5 → "1234.50". Negative amounts aren't allowed in either file. */
  const amt = n => Math.max(0, r2(n)).toFixed(2);
  const ACC = "A-Za-z0-9\\u00c0-\\u00d6\\u00d8-\\u00f6\\u00f8-\\u00ff\\u0152\\u0153"; // letters, digits, French accented letters
  // CRA's acceptable character sets (T619 specification, "Acceptable characters").
  const SETS = {
    name: new RegExp(`[^${ACC}'&.\\- ]`, 'g'),
    address: new RegExp(`[^${ACC}'&.\\- /#,(){}\\[\\]]`, 'g'),
    keyboard: new RegExp(`[^${ACC}'&.\\- /#,(){}\\[\\]"\\\\|?!$%*+:;@]`, 'g'),
    contact: new RegExp(`[^${ACC}'\\- ]`, 'g'),
  };
  /** Keep only the characters CRA accepts for that kind of field, squeeze spaces, cut to `max`. */
  function clean(v, kind, max) {
    let s = String(v ?? '').replace(/[\r\n\t]+/g, ' ').replace(/[\u2018\u2019\u02bc]/g, "'").replace(/[\u2013\u2014]/g, '-');
    if (kind && SETS[kind]) s = s.replace(SETS[kind], ' ');
    s = s.replace(/\s+/g, ' ').trim();
    return max ? s.slice(0, max).trim() : s;
  }
  /** <tag>text</tag>, or '' when the value is empty and the tag is optional. */
  const el = (tag, v, required) => (v === undefined || v === null || v === '') && !required ? '' : `<${tag}>${esc(v)}</${tag}>`;
  /** A parent element: left out when nothing is inside, unless required. */
  const grp = (tag, inner, required, attrs = '') => (inner || required ? `<${tag}${attrs}>${inner}</${tag}>` : '');

  const PROVINCES = ['AB', 'BC', 'MB', 'NB', 'NL', 'NS', 'NT', 'NU', 'ON', 'PE', 'QC', 'SK', 'YT'];
  const PROV_NAMES = { AB: 'Alberta', BC: 'British Columbia', MB: 'Manitoba', NB: 'New Brunswick', NL: 'Newfoundland and Labrador', NS: 'Nova Scotia',
    NT: 'Northwest Territories', NU: 'Nunavut', ON: 'Ontario', PE: 'Prince Edward Island', QC: 'Quebec', SK: 'Saskatchewan', YT: 'Yukon' };
  const PROV_ALIASES = { 'PEI': 'PE', 'P.E.I.': 'PE', 'QU\u00c9BEC': 'QC', 'QUEBEC': 'QC', 'NFLD': 'NL', 'NEWFOUNDLAND': 'NL', 'COLOMBIE-BRITANNIQUE': 'BC', 'NOUVEAU-BRUNSWICK': 'NB',
    'NOUVELLE-\u00c9COSSE': 'NS', 'TERRITOIRES DU NORD-OUEST': 'NT', '\u00ceLE-DU-PRINCE-\u00c9DOUARD': 'PE', 'TERRE-NEUVE-ET-LABRADOR': 'NL', 'PQ': 'QC', 'NWT': 'NT', 'YK': 'YT', 'NF': 'NL' };
  const POSTAL = /^[ABCEGHJ-NPRSTVXY]\d[ABCEGHJ-NPRSTV-Z]\d[ABCEGHJ-NPRSTV-Z]\d$/;
  const postalCA = v => String(v ?? '').toUpperCase().replace(/[\s-]/g, '');
  function provCode(v) {
    const s = String(v ?? '').trim().toUpperCase().replace(/\.$/, '');
    if (PROVINCES.includes(s)) return s;
    if (PROV_ALIASES[s]) return PROV_ALIASES[s];
    const hit = Object.entries(PROV_NAMES).find(([, n]) => n.toUpperCase() === s);
    return hit ? hit[0] : '';
  }

  /** "Marie-Ève J. Tremblay" → { first: 'Marie-Ève', initial: 'J', last: 'Tremblay' }. The last word is the surname. */
  function splitName(full) {
    const w = String(full ?? '').trim().split(/\s+/).filter(Boolean);
    if (!w.length) return { first: '', initial: '', last: '' };
    if (w.length === 1) return { first: '', initial: '', last: w[0] };
    const last = w.pop(), first = w.shift(), initial = w.length ? w[0].replace(/[^A-Za-z\u00c0-\u00ff]/g, '').charAt(0).toUpperCase() : '';
    return { first, initial, last };
  }
  /** "(613) 555-1234 ext. 22" → { area: '613', number: '555-1234', ext: '22' }. */
  function splitPhone(p) {
    const [main, ...rest] = String(p ?? '').split(/\s*(?:x|ext\.?|poste|#)\s*/i);
    let d = digits(main);
    if (d.length === 11 && d[0] === '1') d = d.slice(1);
    if (d.length !== 10) return { area: '', number: '', ext: digits(rest.join('')), ok: false };
    return { area: d.slice(0, 3), number: d.slice(3, 6) + '-' + d.slice(6), ext: digits(rest.join('')), ok: true };
  }

  /**
   * Best guess at the parts of a free-text Canadian address (for employees saved before addresses had parts):
   *   "12 Main St\nApt 4\nOttawa ON K1A 0B1" → { line1: '12 Main St', line2: 'Apt 4', city: 'Ottawa', prov: 'ON', postal: 'K1A0B1', country: 'CAN' }
   * The person checks it on the form before it's used.
   */
  function parseAddress(text) {
    const out = { line1: '', line2: '', city: '', prov: '', postal: '', country: 'CAN' };
    let lines = String(text ?? '').split(/\r?\n|,(?=\s*[A-Za-z\u00c0-\u00ff])/).map(s => s.trim()).filter(Boolean);
    if (!lines.length) return out;
    if (/^canada$/i.test(lines[lines.length - 1])) lines.pop();
    // Postal code: anywhere on the last line or alone on a line.
    const pcRe = /\b([A-Za-z]\d[A-Za-z])\s?-?(\d[A-Za-z]\d)\b/;
    for (let i = lines.length - 1; i >= 0; i--) {
      const m = lines[i].match(pcRe);
      if (m) { out.postal = (m[1] + m[2]).toUpperCase(); lines[i] = lines[i].replace(m[0], '').trim(); if (!lines[i]) lines.splice(i, 1); break; }
    }
    // Province: the last word(s) of the last line, as a code or a name.
    if (lines.length) {
      let last = lines[lines.length - 1];
      const words = last.split(/\s+/);
      for (let n = Math.min(4, words.length); n >= 1; n--) {
        const code = provCode(words.slice(-n).join(' '));
        if (code) { out.prov = code; last = words.slice(0, -n).join(' ').replace(/,\s*$/, '').trim(); break; }
      }
      if (out.prov || out.postal) {
        if (last) { out.city = last; lines.pop(); }
        else { lines.pop(); if (lines.length > 1) out.city = lines.pop(); }
      }
    }
    out.line1 = lines[0] || '';
    out.line2 = lines.slice(1).join(' ');
    return out;
  }
  /** An employee's address parts: the structured fields if any were entered, else a guess from the old text. */
  function addressOf(e) {
    const a = e && e.addr && typeof e.addr === 'object' ? e.addr : null;
    if (a && (a.line1 || a.city || a.postal)) return { line1: a.line1 || '', line2: a.line2 || '', city: a.city || '', prov: provCode(a.prov) || String(a.prov || '').toUpperCase(), postal: a.postal || '', country: a.country || 'CAN', guessed: false };
    return { ...parseAddress(e && e.address), guessed: true };
  }
  /** Problems with an address, by part: 'line1', 'city', 'prov', 'postal' (empty array when fine). */
  function addressProblems(a) {
    const p = [];
    if (!clean(a.line1)) p.push('line1');
    if (!clean(a.city)) p.push('city');
    const can = !a.country || a.country === 'CAN';
    if (can && !PROVINCES.includes(a.prov)) p.push('prov');
    if (can ? !POSTAL.test(postalCA(a.postal)) : !clean(a.postal)) p.push('postal');
    return p;
  }

  const BN15 = /^\d{9}RP\d{4}$/;
  const bn15 = v => String(v ?? '').toUpperCase().replace(/\s/g, '');
  /** A unique submission reference: up to 8 letters and digits (no spaces, hyphens or symbols). */
  const submissionRef = (now = Date.now()) => now.toString(36).toUpperCase().slice(-8);

  /* ---------- T619 + T4 ---------- */
  /*
   * t4Problems({ ye, employees, employer, transmitter }) — everything that would get the file rejected, or a slip
   * returned. Each problem: { level: 'error'|'warn', code, name?, prov?, part? }.
   *   ye:          the result of TallyPayroll.yearEnd()
   *   employer:    { name, bn, addr: { line1, line2, city, prov, postal, country } }
   *   transmitter: { bn, repId, name, contact, phone, email, email2 }  (bn defaults to the employer's)
   */
  function t4Problems({ ye, employees, employer = {}, transmitter = {} }) {
    const out = [];
    const emp = new Map((employees || []).map(e => [e.id, e]));
    const bn = bn15(employer.bn);
    if (!BN15.test(bn)) out.push({ level: 'error', code: 'bn' });
    if (!clean(employer.name, 'name')) out.push({ level: 'error', code: 'employer-name' });
    const tb = bn15(transmitter.bn || employer.bn), rep = String(transmitter.repId || '').trim();
    if (rep && !/^[A-Za-z0-9]{1,7}$/.test(rep)) out.push({ level: 'error', code: 'repid' });
    if (!BN15.test(tb) && !rep) out.push({ level: 'error', code: 'transmitter-bn' });
    if (!clean(transmitter.contact, 'contact')) out.push({ level: 'error', code: 'contact' });
    if (!splitPhone(transmitter.phone).ok) out.push({ level: 'error', code: 'phone' });
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(transmitter.email || '').trim())) out.push({ level: 'error', code: 'email' });
    if (employer.addr) for (const part of addressProblems(employer.addr)) out.push({ level: 'warn', code: 'employer-addr', part });
    if (!ye || !ye.slips || !ye.slips.length) out.push({ level: 'error', code: 'no-slips' });
    const seen = new Set();
    for (const s of (ye && ye.slips) || []) {
      const e = emp.get(s.employeeId) || {}, who = { name: s.name, prov: s.prov };
      for (const c of s.checks || []) if (c.level === 'error') out.push({ level: 'error', code: 'slip-' + c.code, ...who });
      if (!splitName(e.name || s.name).last) out.push({ level: 'error', code: 'surname', ...who });
      if (!PROVINCES.includes(s.prov)) out.push({ level: 'error', code: 'slip-prov', ...who });
      if (seen.has(s.employeeId)) continue; // address checks once per employee
      seen.add(s.employeeId);
      const a = addressOf(e);
      if (!clean(e.address) && a.guessed) { out.push({ level: 'warn', code: 'addr-missing', ...who }); continue; }
      for (const part of addressProblems(a)) out.push({ level: 'warn', code: 'addr', part, ...who });
      if (a.guessed) out.push({ level: 'warn', code: 'addr-guessed', ...who });
    }
    return out;
  }

  // T4 "other information" codes Sumlora fills in, and their XML elements.
  const OTH_INFO = { 30: 'hm_brd_lodg_amt', 34: 'prsnl_vhcl_amt', 40: 'oth_tx_ben_amt' };

  function addrXml(tag, a, required) {
    if (!a) return '';
    const can = !a.country || a.country === 'CAN';
    const inner = el('addr_l1_txt', clean(a.line1, 'address', 30)) + el('addr_l2_txt', clean(a.line2, 'address', 30)) + el('cty_nm', clean(a.city, 'address', 28)) +
      el('prov_cd', can ? (PROVINCES.includes(a.prov) ? a.prov : '') : (/^[A-Z]{2}$/.test(a.prov || '') ? a.prov : 'ZZ')) +
      el('cntry_cd', /^[A-Z]{3}$/.test(a.country || '') ? a.country : 'CAN') +
      el('pstl_cd', can ? (POSTAL.test(postalCA(a.postal)) ? postalCA(a.postal) : '') : clean(a.postal, 'address', 10).toUpperCase());
    return grp(tag, inner, required);
  }

  /** One <T4Slip>. */
  function t4SlipXml(s, e, bn) {
    const t = s.t4, n = splitName(e.name || s.name), qc = s.prov === 'QC';
    const nm = el('snm', clean(n.last, 'name', 20), true) + el('gvn_nm', clean(n.first, 'name', 12)) + el('init', /^[A-Za-z]$/.test(n.initial) ? n.initial : '');
    const opt = v => (r2(v) > 0 ? amt(v) : '');
    const amounts =
      el('empt_incamt', opt(t[14])) +
      el('cpp_cntrb_amt', opt(t[16])) + el('cppe_cntrb_amt', opt(t['16A'])) +
      el('qpp_cntrb_amt', opt(t[17])) + el('qppe_cntrb_amt', opt(t['17A'])) +
      el('empe_eip_amt', opt(t[18])) + el('rpp_cntrb_amt', opt(t[20])) + el('itx_ddct_amt', opt(t[22])) +
      el('ei_insu_ern_amt', amt(t[24]), true) + el('cpp_qpp_ern_amt', amt(t[26]), true) +
      el('unn_dues_amt', opt(t[44])) + el('padj_amt', opt(t[52])) +
      (qc ? el('prov_pip_amt', opt(t[55])) + el('prov_insu_ern_amt', amt(t[56])) : '');
    const codes = Object.entries(s.other || {}).filter(([k, v]) => OTH_INFO[k] && r2(v) > 0).slice(0, 6);
    const ex = t[28] || {};
    const sin = digits(t[12]).length === 9 ? digits(t[12]) : '000000000';
    return '<T4Slip>' +
      grp('EMPE_NM', nm, true) +
      addrXml('EMPE_ADDR', (() => { const a = addressOf(e); return addressProblems(a).length === 4 ? null : a; })()) +
      el('sin', sin, true) +
      el('bn', bn, true) +
      el('rpp_dpsp_rgst_nbr', /^\d{7}$/.test(digits(t[50])) ? digits(t[50]) : '') +
      el('cpp_qpp_xmpt_cd', ex.cppQpp ? '1' : '0', true) +
      el('ei_xmpt_cd', ex.ei ? '1' : '0', true) +
      (qc ? el('prov_pip_xmpt_cd', ex.ppip ? '1' : '0') : '') +
      el('rpt_tcd', 'O', true) +
      el('empt_prov_cd', s.prov, true) +
      el('empr_dntl_ben_rpt_cd', [1, 2, 3, 4, 5].includes(Number(t[45])) ? String(t[45]) : '', true) +
      grp('T4_AMT', amounts, true) +
      grp('OTH_INFO', codes.map(([k, v]) => el(OTH_INFO[k], amt(v))).join('')) +
      '</T4Slip>';
  }

  /** Totals for the T4 Summary, from the slips themselves (so they always equal the sum of the slips in the file). */
  function t4Totals(ye) {
    const s = ye.slips, sum = f => r2(s.reduce((t, x) => t + num(f(x)), 0));
    const notQc = s.filter(x => x.prov !== 'QC');
    return {
      tot_empt_incamt: sum(x => x.t4[14]), tot_empe_cpp_amt: sum(x => x.t4[16]), tot_empe_cppe_amt: sum(x => x.t4['16A']),
      tot_empe_eip_amt: sum(x => x.t4[18]), tot_rpp_cntrb_amt: sum(x => x.t4[20]), tot_itx_ddct_amt: sum(x => x.t4[22]),
      tot_padj_amt: sum(x => x.t4[52]), tot_empr_cpp_amt: r2(notQc.reduce((t, x) => t + num((x.er || {}).cpp), 0)),
      tot_empr_cppe_amt: r2(notQc.reduce((t, x) => t + num((x.er || {}).cpp2), 0)), tot_empr_eip_amt: sum(x => (x.er || {}).ei),
    };
  }
  const T4_TAMT_ORDER = ['tot_empt_incamt', 'tot_empe_cpp_amt', 'tot_empe_cppe_amt', 'tot_empe_eip_amt', 'tot_rpp_cntrb_amt', 'tot_itx_ddct_amt',
    'tot_padj_amt', 'tot_empr_cpp_amt', 'tot_empr_cppe_amt', 'tot_empr_eip_amt'];

  /** Employer name over up to three 30-character lines (l1_nm, l2_nm, l3_nm). */
  function nameLines(name) {
    const words = clean(name, 'name').split(' ').filter(Boolean), lines = [''];
    for (const w of words) {
      const cur = lines[lines.length - 1];
      if (!cur) lines[lines.length - 1] = w.slice(0, 30);
      else if ((cur + ' ' + w).length <= 30) lines[lines.length - 1] = cur + ' ' + w;
      else if (lines.length < 2) lines.push(w.slice(0, 30));
      else break; // line 3 is for "care of" / "attention"
    }
    return lines;
  }

  /*
   * t4Xml({ ye, employees, employer, transmitter, lang, ref })
   * Returns { xml, ref, slips, totals, problems }. Throws (err.problems) when there's an error that CRA would reject.
   */
  function t4Xml({ ye, employees, employer = {}, transmitter = {}, lang = 'E', ref } = {}) {
    const problems = t4Problems({ ye, employees, employer, transmitter });
    const errors = problems.filter(p => p.level === 'error');
    if (errors.length) throw Object.assign(new Error('The T4 file can’t be made yet: ' + errors.map(p => p.code).join(', ')), { code: 'PROBLEMS', problems });
    const emp = new Map((employees || []).map(e => [e.id, e]));
    const bn = bn15(employer.bn), tb = bn15(transmitter.bn || employer.bn), rep = String(transmitter.repId || '').trim().toUpperCase();
    const sref = String(ref || submissionRef()).replace(/[^A-Za-z0-9]/g, '').slice(0, 8);
    const ph = splitPhone(transmitter.phone);
    const t619 = '<T619>' +
      (BN15.test(tb) ? grp('TransmitterAccountNumber', el('bn15', tb)) : '') +
      (rep ? grp('TransmitterRepID', el('RepID', rep)) : '') +
      el('sbmt_ref_id', sref, true) +
      el('summ_cnt', '1', true) +
      el('lang_cd', lang === 'F' ? 'F' : 'E', true) +
      grp('TransmitterName', el('l1_nm', clean(transmitter.name || employer.name, 'keyboard', 35), true), true) +
      el('TransmitterCountryCode', 'CAN', true) +
      grp('CNTC', el('cntc_nm', clean(transmitter.contact, 'contact', 35), true) + el('cntc_area_cd', ph.area, true) + el('cntc_phn_nbr', ph.number, true) +
        el('cntc_extn_nbr', ph.ext.slice(0, 12)) + el('cntc_email_area', String(transmitter.email).trim().slice(0, 60), true) +
        el('sec_cntc_email_area', String(transmitter.email2 || '').trim().slice(0, 60)), true) +
      '</T619>';
    const slips = ye.slips.map(s => t4SlipXml(s, emp.get(s.employeeId) || { name: s.name, address: s.address }, bn));
    const totals = t4Totals(ye);
    const names = nameLines(employer.name);
    const summary = '<T4Summary>' +
      el('bn', bn, true) +
      grp('EMPR_NM', el('l1_nm', names[0], true) + el('l2_nm', names[1] || ''), true) +
      (employer.addr ? addrXml('EMPR_ADDR', employer.addr) : '') +
      grp('CNTC', el('cntc_nm', clean(transmitter.contact, 'contact', 22), true) + el('cntc_area_cd', ph.area, true) + el('cntc_phn_nbr', ph.number, true) +
        el('cntc_extn_nbr', ph.ext.slice(0, 5)), true) +
      el('tx_yr', String(ye.year), true) +
      el('slp_cnt', String(ye.slips.length), true) +
      el('rpt_tcd', 'O', true) +
      grp('T4_TAMT', T4_TAMT_ORDER.map(k => el(k, k === 'tot_empt_incamt' || totals[k] > 0 ? amt(totals[k]) : '')).join(''), true) +
      '</T4Summary>';
    const xml = '<?xml version="1.0" encoding="UTF-8"?>\n<Submission xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">\n' + t619 + '\n<Return><T4>\n' + slips.join('\n') + '\n' + summary + '\n</T4></Return>\n</Submission>\n';
    return { xml, ref: sref, slips: slips.length, totals, problems };
  }

  /* ---------- ROE Web payroll extract (W-2.0) ---------- */
  // Service Canada's codes for "other monies" (block 17C, Table 12). ins: insurable, so it's also in pay period 1 (15C).
  const ROE_OTHER_MONIES = [
    ['B05', 'Holiday bonus', true], ['B06', 'Production or incentive bonus', true], ['B07', 'Event bonus', true], ['B08', 'Staying, contract-completion or end-of-season bonus', true],
    ['B09', 'Separation or retirement bonus', true], ['B10', 'Closure bonus', true], ['B11', 'Other bonus', true], ['E00', 'Severance pay', false], ['G00', 'Gratuities', true],
    ['H00', 'Honorariums', false], ['I00', 'Sick leave credits', true], ['J00', 'Retroactive pay adjustment', true], ['O00', 'Other', true], ['Q00', 'Profit sharing', true],
    ['R00', 'Retiring allowance or retirement leave credits', false], ['S00', 'Settlement pay', true], ['T00', 'Payout of banked overtime', true],
    ['U12', 'Supplementary unemployment benefits: maternity, parental, compassionate or family caregiver', false], ['U13', 'Supplementary unemployment benefits: layoff', false],
    ['U14', 'Supplementary unemployment benefits: illness', false], ['U15', 'Supplementary unemployment benefits: training', false], ['Y00', 'Pay in lieu of notice', true],
  ];
  const ROE_TYPES = ['B', 'M', 'O', 'S', 'E', 'H', 'W'];
  const isDate = v => /^\d{4}-\d{2}-\d{2}$/.test(String(v || ''));

  /*
   * One ROE, as the screen saves it, with the employee and employer:
   *   r:   { reason, reasonCode?, firstDay, lastDay, finalEnd, occupation, recall, recallDate, contact, phone, holDate, holAmt,
   *          otherCd, otherAmt, comments, serial, amends?, calc: { type, hours, periods: [{ n, amount }], vacation } }
   *   emp: { id, name, sin, address, addr }
   * roeProblems(...) → [{ level, code, part? }]
   */
  function roeProblems(r, emp, employer = {}) {
    const p = [], c = r && r.calc;
    if (!BN15.test(bn15(employer.bn))) p.push({ level: 'error', code: 'bn' });
    const sin = digits(emp && emp.sin);
    if (sin.length !== 9 || /^0+$/.test(sin)) p.push({ level: 'error', code: 'sin' });
    const n = splitName(emp && emp.name);
    if (!n.first || !n.last) p.push({ level: 'error', code: 'name' });
    for (const part of addressProblems(addressOf(emp))) p.push({ level: 'error', code: 'addr', part });
    if (!r || !/^[A-Z]$/.test(String(r.reason || '').charAt(0))) p.push({ level: 'error', code: 'reason' });
    if (!isDate(r && r.firstDay) || !isDate(r && r.lastDay) || !isDate(r && r.finalEnd)) p.push({ level: 'error', code: 'dates' });
    if (r && r.recall === 'Y' && !isDate(r.recallDate)) p.push({ level: 'error', code: 'recall' });
    if (!c || !ROE_TYPES.includes(c.type)) p.push({ level: 'error', code: 'calc' });
    else {
      const h = Math.ceil(num(c.hours));
      if (h < 1 || h > 8904) p.push({ level: 'error', code: 'hours' });
      const pp1 = (c.periods || []).find(x => +x.n === 1);
      if (!pp1 || !(r2(pp1.amount) >= 1)) p.push({ level: 'warn', code: 'pp1' });
    }
    const contact = splitName(r && r.contact);
    if (!contact.first || !contact.last) p.push({ level: 'error', code: 'contact' });
    if (!splitPhone(r && r.phone).ok) p.push({ level: 'error', code: 'phone' });
    if (r && num(r.otherAmt) > 0 && !ROE_OTHER_MONIES.some(([k]) => k === r.otherCd)) p.push({ level: 'error', code: 'other-code' });
    if (r && /^K00$|^K15$/.test(roeReasonCode(r)) && !clean(r.comments)) p.push({ level: 'error', code: 'comments' });
    return p;
  }
  /** Block 16 code: three characters (A → A00, unless a specific code like E03 or K12 was chosen). */
  const roeReasonCode = r => (/^[A-Z]\d{2}$/.test(r.reasonCode || '') ? r.reasonCode : String(r.reason || '').charAt(0) + '00');
  /** Pay periods for block 15C: from the final one back to the one with the first day worked, never more than CRA's count. */
  function roePayPeriods(r) {
    const list = ((r.calc && r.calc.periods) || []).filter(p => +p.n >= 1).sort((a, b) => a.n - b.n);
    const out = [];
    for (const p of list) {
      out.push(p);
      if (isDate(p.from) && isDate(r.firstDay) && p.from <= r.firstDay) break; // the period with the first day worked is the last one needed
      if (isDate(p.to) && isDate(r.firstDay) && p.to < r.firstDay) { out.pop(); break; }
    }
    return out.slice(0, 53);
  }

  /** One <ROE> element. */
  function roeOne(r, emp, employer, lang) {
    const n = splitName(emp.name), a = addressOf(emp), c = r.calc, con = splitName(r.contact), ph = splitPhone(r.phone);
    const t = (v, max) => clean(v, 'keyboard', max);
    const pp = roePayPeriods(r).map((p, i) => `<PP nbr="${i + 1}">${el('AMT', amt(p.amount), true)}</PP>`).join('');
    const vac = r2(c.vacation) > 0 ? `<VP nbr="1">${el('CD', '2', true)}${el('AMT', amt(c.vacation), true)}</VP>` : '';
    const hol = r2(r.holAmt) > 0 ? `<SH nbr="1">${el('DT', isDate(r.holDate) ? r.holDate : '')}${el('AMT', amt(r.holAmt), true)}</SH>` : '';
    const oth = r2(r.otherAmt) > 0 ? `<OM nbr="1">${el('CD', r.otherCd, true)}${el('AMT', amt(r.otherAmt), true)}</OM>` : '';
    const recall = r.recall === 'Y' || r.recall === 'N' ? r.recall : 'U';
    return `<ROE PrintingLanguage="${lang}" Issue="D">` +
      el('B2', /^[WM]\d{8}$/.test(String(r.amends || '')) ? r.amends : '') +
      el('B3', String(r.payrollRef || emp.id || '').replace(/[^A-Za-z0-9]/g, '').slice(0, 26)) +
      el('B5', bn15(employer.bn), true) +
      el('B6', c.type, true) +
      el('B8', digits(emp.sin), true) +
      grp('B9', el('FN', t(n.first, 20), true) + el('MN', n.initial ? n.initial : '') + el('LN', t(n.last, 28), true) +
        el('A1', t([a.line1, a.line2].filter(Boolean).join(' '), 35), true) + el('A2', t(a.city, 35), true) +
        el('A3', t([PROV_NAMES[a.prov] || a.prov, a.country && a.country !== 'CAN' ? a.country : 'Canada'].filter(Boolean).join(', '), 35)) +
        el('PC', postalCA(a.postal).slice(0, 10), true), true) +
      el('B10', r.firstDay, true) + el('B11', r.lastDay, true) + el('B12', r.finalEnd, true) +
      el('B13', t(r.occupation, 40)) +
      grp('B14', el('CD', recall, true) + el('DT', recall === 'Y' && isDate(r.recallDate) ? r.recallDate : ''), true) +
      el('B15A', String(Math.min(8904, Math.max(1, Math.ceil(num(c.hours))))), true) +
      grp('B15C', pp, true) +
      grp('B16', el('CD', roeReasonCode(r), true) + el('FN', t(con.first, 20), true) + el('LN', t(con.last, 28), true) +
        el('AC', ph.area, true) + el('TEL', digits(ph.number), true) + el('EXT', ph.ext.slice(0, 8)), true) +
      grp('B17A', vac) + grp('B17B', hol) + grp('B17C', oth) +
      el('B18', t(r.comments, 160)) +
      el('B20', lang) +
      '</ROE>';
  }

  /*
   * roeXml({ items: [{ roe, employee }], employer, lang, product })
   * Returns { xml, count, problems: [{ name, ...problem }] }. Throws (err.problems) when any ROE has an error.
   */
  function roeXml({ items, employer = {}, lang = 'E', product = {} } = {}) {
    const problems = [];
    if (!items || !items.length) throw Object.assign(new Error('Choose at least one record of employment.'), { code: 'EMPTY', problems: [] });
    for (const { roe, employee } of items) for (const p of roeProblems(roe, employee, employer)) problems.push({ name: employee && employee.name, ...p });
    if (problems.some(p => p.level === 'error')) throw Object.assign(new Error('The ROE file can’t be made yet.'), { code: 'PROBLEMS', problems });
    const L = lang === 'F' ? 'F' : 'E';
    const head = `<ROEHEADER FileVersion="W-2.0" SoftwareVendor="${esc(product.vendor || 'Sumlora')}" ProductName="${esc(product.name || 'Sumlora')}"${product.version ? ` ProductVersion="${esc(String(product.version).slice(0, 10))}"` : ''}>`;
    const xml = '<?xml version="1.0" encoding="UTF-8"?>\n' + head + '\n' + items.map(({ roe, employee }) => roeOne(roe, employee, employer, L)).join('\n') + '\n</ROEHEADER>\n';
    return { xml, count: items.length, problems };
  }

  /* ---------- a small XML reader, for the tests and the on-screen check ---------- */
  /** Parse well-formed XML into { name, attrs, children, text }. Throws on anything that isn't well-formed. */
  function parseXml(src) {
    let s = String(src), i = 0;
    const fail = m => { throw new Error(`Not well-formed XML at ${i}: ${m}`); };
    const unesc = t => t.replace(/&(amp|lt|gt|quot|apos|#\d+|#x[0-9a-f]+);|&/gi, (m, k) => {
      if (!k) fail('bare &');
      const map = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
      return map[k.toLowerCase()] ?? String.fromCodePoint(k[1].toLowerCase() === 'x' ? parseInt(k.slice(2), 16) : parseInt(k.slice(1), 10));
    });
    if (s.charCodeAt(0) === 0xfeff) s = s.slice(1);
    const decl = s.match(/^<\?xml\s[^?]*\?>/);
    if (decl) i = decl[0].length;
    const ws = () => { while (/\s/.test(s[i] || '')) i++; };
    function node() {
      if (s[i] !== '<') fail('expected <');
      i++;
      const nm = s.slice(i).match(/^[A-Za-z_][\w.\-:]*/); if (!nm) fail('bad tag name');
      const name = nm[0]; i += name.length;
      const attrs = {};
      for (;;) {
        ws();
        if (s.startsWith('/>', i)) { i += 2; return { name, attrs, children: [], text: '' }; }
        if (s[i] === '>') { i++; break; }
        const am = s.slice(i).match(/^([A-Za-z_][\w.\-:]*)\s*=\s*("([^"<]*)"|'([^'<]*)')/); if (!am) fail('bad attribute in ' + name);
        if (attrs[am[1]] !== undefined) fail('duplicate attribute');
        attrs[am[1]] = unesc(am[3] ?? am[4]); i += am[0].length;
      }
      const children = []; let text = '';
      for (;;) {
        if (i >= s.length) fail('unclosed ' + name);
        if (s.startsWith('</', i)) {
          const end = s.slice(i).match(/^<\/([A-Za-z_][\w.\-:]*)\s*>/);
          if (!end || end[1] !== name) fail(`expected </${name}>`);
          i += end[0].length; return { name, attrs, children, text: children.length ? text.trim() : text };
        }
        if (s[i] === '<') { children.push(node()); continue; }
        const j = s.indexOf('<', i); const raw = s.slice(i, j < 0 ? s.length : j);
        if (raw.includes('>')) fail('bare >');
        text += unesc(raw); i = j < 0 ? s.length : j;
      }
    }
    ws(); const rootNode = node(); ws();
    if (i !== s.length) fail('content after the root element');
    return rootNode;
  }
  /** Children named `name` (or the first, with one = true). */
  const kids = (n, name) => (n ? n.children.filter(c => c.name === name) : []);
  const kid = (n, name) => kids(n, name)[0] || null;

  return { esc, clean, amt, splitName, splitPhone, parseAddress, addressOf, addressProblems, provCode, postalCA, submissionRef,
    t4Problems, t4Xml, t4Totals, roeProblems, roeXml, roeReasonCode, roePayPeriods, parseXml, kids, kid,
    ROE_OTHER_MONIES, OTH_INFO, T4_TAMT_ORDER, PROVINCES, BN15 };
});
