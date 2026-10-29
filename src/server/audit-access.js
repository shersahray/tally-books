'use strict';
// This is a server-side authorization guard, not a UI visibility switch.
// Company setting is default-deny and may only be changed by platform admins.
function admin(user) { return !!(user && user.role === 'owner' && user.platformAdmin === true && !user.disabled); }
function canUseAuditAI({user, company, canSeeCompany, firmActive = false}) {
  return !!(user && !user.disabled && user.role !== 'client' && company && !company.archived &&
    company.auditAiEntitled === true && firmActive === true &&
    typeof canSeeCompany === 'function' && canSeeCompany(user,company.id) === true);
}
function requireAuditAI(ctx) {
  if (!canUseAuditAI(ctx)) { const error = new Error('Audit AI is unavailable for this company'); error.status = 403; throw error; }
}
function changeAuditAI({actor, company, enabled, saveCompany, audit}) {
  if (!admin(actor)) { const error = new Error('Platform administrator required'); error.status = 403; throw error; }
  if (!company || typeof company.id !== 'string' || typeof enabled !== 'boolean' ||
      typeof saveCompany !== 'function' || typeof audit !== 'function') throw new TypeError('Invalid entitlement change');
  const updated = {...company,auditAiEntitled: enabled};
  saveCompany(updated);
  audit({kind:'audit-ai-entitlement',companyId:company.id,actorId:actor.id,enabled,at:new Date().toISOString()});
  return updated;
}
module.exports = {admin,canUseAuditAI,requireAuditAI,changeAuditAI};
