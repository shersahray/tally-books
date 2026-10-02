'use strict';
/* Signs one Windows file with Azure Artifact Signing. electron-builder calls this for each file it signs
 * (set with -c.win.signtoolOptions.sign=scripts/azure-sign.js in the build workflow).
 *
 * Why not electron-builder's own azureSignOptions: it passes the path to Invoke-TrustedSigning with an
 * extra pair of double quotes, which the TrustedSigning module rejects ("The file path is not rooted").
 *
 * Needs, from the environment: AZURE_TENANT_ID, AZURE_CLIENT_ID, AZURE_CLIENT_SECRET (read by the
 * TrustedSigning module), SIGN_ENDPOINT, SIGN_ACCOUNT, SIGN_PROFILE. The TrustedSigning PowerShell module
 * must already be installed (the workflow does that).
 */
const { execFileSync } = require('node:child_process');

const q = s => `'${String(s).replace(/'/g, "''")}'`; // a PowerShell single-quoted string

exports.default = async function sign(configuration) {
  // electron-builder may ask for SHA-1 and SHA-256 signatures; Artifact Signing does SHA-256 only.
  if (configuration.hash && configuration.hash !== 'sha256') return;
  const file = String(configuration.path || '').replace(/^"+|"+$/g, '');
  if (!file) throw new Error('No file to sign.');
  for (const k of ['SIGN_ENDPOINT', 'SIGN_ACCOUNT', 'SIGN_PROFILE']) if (!process.env[k]) throw new Error(`${k} isn't set.`);
  const cmd = [
    '$ErrorActionPreference = "Stop";',
    'Invoke-TrustedSigning',
    '-Endpoint', q(process.env.SIGN_ENDPOINT),
    '-CodeSigningAccountName', q(process.env.SIGN_ACCOUNT),
    '-CertificateProfileName', q(process.env.SIGN_PROFILE),
    '-TimestampRfc3161', q('http://timestamp.acs.microsoft.com'),
    '-TimestampDigest', q('SHA256'),
    '-FileDigest', q('SHA256'),
    '-Files', q(file),
  ].join(' ');
  const encoded = Buffer.from(cmd, 'utf16le').toString('base64');
  for (let attempt = 1; ; attempt++) {
    try {
      execFileSync('pwsh.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], { stdio: 'inherit' });
      console.log(`Signed ${file}`);
      return;
    } catch (e) {
      if (attempt >= 3) throw new Error(`Signing ${file} failed: ${e.message}`);
      console.log(`Signing ${file} failed (try ${attempt}), retrying…`);
      await new Promise(r => setTimeout(r, 5000 * attempt));
    }
  }
};
