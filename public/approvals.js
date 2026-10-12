/*
 * Bill approvals (like QuickBooks Online Advanced): bills over an amount, or from chosen vendors, are recorded
 * in Accounts payable as usual but wait for an owner or an approver before they can be paid.
 * Works in the browser (window.TallyApprovals) and in Node (require), so the server enforces the same rules.
 *
 * Company setting `approvals`: { on, over, vendors, approvers }
 *   over       bills with a total above this need approval; 0 = every bill
 *   vendors    contact ids; empty = bills from any vendor
 *   approvers  user ids of people (besides owners) who can approve. Staff whose custom role has
 *              "Approve bills" (roles.js approveBills) can approve too.
 * A bill's `approval`: { status: 'waiting' | 'approved' | 'rejected' | '', enteredBy, enteredName, history: [...] }
 *   Only the server changes it: a plain save keeps what was there, and approving or rejecting has its own route.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.TallyApprovals = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  const STATUSES = ['waiting', 'approved', 'rejected', ''];
  const ACTIONS = ['submitted', 'approved', 'rejected', 'resubmitted', 'changed'];
  const MAX_HISTORY = 50;
  const isObj = x => x && typeof x === 'object' && !Array.isArray(x);
  const ids = (a, n) => [...new Set((Array.isArray(a) ? a : []).map(x => String(x || '').slice(0, 80)).filter(Boolean))].slice(0, n);

  /** The company setting, cleaned (also what validateCompany stores). */
  function clean(s) {
    s = isObj(s) ? s : {};
    const over = Math.round(Math.max(0, Math.min(1e9, Number(s.over) || 0)) * 100) / 100;
    return { on: !!s.on, over, vendors: ids(s.vendors, 500), approvers: ids(s.approvers, 100) };
  }
  /** Do approvals apply at all: the feature is on for the company and the setting is on. */
  const active = (settings, featureOn) => !!featureOn && clean(settings).on;
  /** Does this bill need approval under these rules? Bills brought over from other software never do. */
  function required(settings, doc) {
    const s = clean(settings);
    if (!s.on || !doc || doc.kind !== 'bill' || doc.carried) return false;
    if (s.vendors.length && !s.vendors.includes(String(doc.contactId || ''))) return false;
    return (Number(doc.total) || 0) > s.over + 0.004;
  }
  /** Is this bill held back from being paid (waiting, or rejected and not yet changed)? */
  const held = (doc, isActive) => !!isActive && !!doc && doc.kind === 'bill' && isObj(doc.approval) && (doc.approval.status === 'waiting' || doc.approval.status === 'rejected');

  // What counts as changing a bill: the vendor, the amounts, the currency or the lines (not the memo or the due date).
  const lineKey = l => (Array.isArray(l) ? l : []).map(x => [x && x.item || '', x && x.account || '', Number(x && x.qty) || 0, Number(x && x.rate) || 0, x && x.taxCode || ''].join('|')).join('~');
  const changed = (a, b) => String(a.contactId || '') !== String(b.contactId || '') || Math.abs((Number(a.total) || 0) - (Number(b.total) || 0)) > 0.004 ||
    String(a.currency || '') !== String(b.currency || '') || lineKey(a.lines) !== lineKey(b.lines);

  /**
   * The approval a bill gets when it's saved. prev = the bill as it was (or null), data = as sent, user = who saves it.
   * Returns the approval object to store, or undefined for none. Whatever the browser sent in data.approval is ignored.
   */
  function onSave(prev, data, settings, isActive, user, now = Date.now()) {
    const was = prev && isObj(prev.approval) ? prev.approval : undefined;
    if (!data || data.kind !== 'bill') return undefined;
    if (!isActive) return was; // approvals off: nothing changes, and what was recorded is kept
    const need = required(settings, data);
    const who = { by: user ? user.username : 'system', name: user ? (user.name || user.username) : 'System', at: now };
    const hist = was && Array.isArray(was.history) ? was.history.slice(-(MAX_HISTORY - 1)) : [];
    const entered = { enteredBy: who.by, enteredName: who.name };
    if (!prev) return need ? { status: 'waiting', ...entered, history: [{ action: 'submitted', ...who }] } : undefined;
    if (!changed(prev, data)) return was;
    // Changed: approved or rejected bills go back to waiting (and so do bills that didn't need approval before).
    if (need) {
      const action = was && was.status === 'approved' ? 'changed' : was && was.status === 'rejected' ? 'resubmitted' : 'submitted';
      if (was && was.status === 'waiting') return { ...was, history: hist }; // still waiting; nothing to record
      return { status: 'waiting', ...entered, history: [...hist, { action, ...who }] };
    }
    // No longer needs approval (under the limit now): a bill that was waiting or rejected can be paid.
    return was ? { ...was, status: was.status === 'approved' ? 'approved' : '', history: hist } : undefined;
  }

  /**
   * Can this person approve or reject this bill? user: { id, username, role, approveBills }; owners: how many active owners
   * the firm has. Returns '' when they can, or the reason they can't.
   */
  function whyNot(user, settings, doc, owners) {
    const s = clean(settings);
    if (!user || user.role === 'client') return 'Only an owner or an approver can approve bills.';
    const approver = user.role === 'owner' || s.approvers.includes(user.id) || !!user.approveBills;
    if (!approver) return 'Only an owner or an approver can approve bills.';
    if (!doc || doc.kind !== 'bill' || !isObj(doc.approval) || doc.approval.status !== 'waiting') return 'This bill isn’t waiting for approval.';
    if (doc.approval.enteredBy && doc.approval.enteredBy === user.username && !(user.role === 'owner' && owners <= 1)) return 'You entered this bill, so someone else has to approve it.';
    return '';
  }
  /** The bill after an approval or rejection, or (action 'resubmit') a rejected bill sent back for approval as it is. */
  function decide(doc, action, user, comment, now = Date.now()) {
    const a = doc.approval || {};
    if (action === 'resubmit') return { ...doc, approval: { ...a, status: 'waiting', enteredBy: user.username, enteredName: user.name || user.username, history: [...(a.history || []).slice(-(MAX_HISTORY - 1)), { action: 'resubmitted', by: user.username, name: user.name || user.username, at: now, ...(comment ? { comment } : {}) }] } };
    const own = a.enteredBy && a.enteredBy === user.username;
    const ev = { action: action === 'approve' ? 'approved' : 'rejected', by: user.username, name: user.name || user.username, at: now, ...(comment ? { comment } : {}), ...(own ? { self: true } : {}) };
    return { ...doc, approval: { ...a, status: ev.action, history: [...(a.history || []).slice(-(MAX_HISTORY - 1)), ev] } };
  }

  /** A bill's approval as stored (checked on every save and restore). */
  function cleanApproval(a) {
    if (a === undefined || a === null) return undefined;
    if (!isObj(a)) throw new Error('A bill’s approval must be an object.');
    if (!STATUSES.includes(a.status || '')) throw new Error('A bill’s approval status must be waiting, approved or rejected.');
    const s = (x, n) => String(x || '').slice(0, n);
    const history = (Array.isArray(a.history) ? a.history : []).filter(isObj).slice(-MAX_HISTORY).map(h => ({
      action: ACTIONS.includes(h.action) ? h.action : 'changed', by: s(h.by, 120), name: s(h.name, 120), at: Number(h.at) || 0, ...(h.comment ? { comment: s(h.comment, 500) } : {}), ...(h.self ? { self: true } : {}) }));
    return { status: a.status || '', enteredBy: s(a.enteredBy, 120), enteredName: s(a.enteredName, 120), history };
  }

  return { clean, active, required, held, onSave, whyNot, decide, cleanApproval, changed, STATUSES };
});
