'use strict';
/*
 * The version of the Terms of service and Privacy policy that people agree to (public/legal/).
 * Change it whenever either document changes in a way people should agree to again: everyone is then asked
 * once more, the next time they sign in, and each person's agreement (version, time, network address) is kept
 * with their account.
 */
const TERMS_VERSION = '2026-10-draft';
const TERMS_DRAFT = true; // shown as a draft until the lawyer-reviewed text replaces it

module.exports = { TERMS_VERSION, TERMS_DRAFT };
