#!/usr/bin/env bash
# Sets up Azure Artifact Signing for the Sumlora Windows installer, as far as it can be done
# without you: run it in Azure Cloud Shell (the >_ button at the top of the Azure portal, Bash).
#
#   bash <(curl -fsSL https://raw.githubusercontent.com/shersahray/tally-books/main/deploy/azure/signing-setup.sh)
#
# It does: turn on the code signing service, give you the role to request identity validation,
# create the signing account, create the app GitHub signs with, and give that app permission to sign.
# It does NOT do the identity validation (Microsoft checks your ID; you do that in the portal) or the
# certificate profile (it needs the approved validation). It prints the 7 values for GitHub at the end.
# Running it again is safe: it reuses what's already there.
set -uo pipefail

RG="${RG:-tally-books}"
RG_LOCATION="${RG_LOCATION:-canadacentral}"
REGION="${REGION:-eastus}"                 # Artifact Signing has no Canadian region; East US is fine
APP_NAME="${APP_NAME:-tally-books-signing}"

say()  { printf '\n\033[1m%s\033[0m\n' "$*"; }
fail() { printf '\n\033[31mStopped: %s\033[0m\n' "$*"; exit 1; }

az account show >/dev/null 2>&1 || fail "Not signed in to Azure. Open Cloud Shell from the Azure portal and run this again."
SUB=$(az account show --query id -o tsv)
TENANT=$(az account show --query tenantId -o tsv)
ME=$(az ad signed-in-user show --query id -o tsv 2>/dev/null) || fail "Couldn't read your user. Make sure Cloud Shell is signed in as you."
say "Subscription: $(az account show --query name -o tsv)"

say "1/6  Turning on the code signing service (Microsoft.CodeSigning)…"
az provider register --namespace Microsoft.CodeSigning --wait >/dev/null || fail "Couldn't register Microsoft.CodeSigning. If your subscription is still a free trial, upgrade it first."
echo "     Registered."

say "2/6  Resource group '$RG'…"
if az group show -n "$RG" >/dev/null 2>&1; then echo "     Already there."
else az group create -n "$RG" -l "$RG_LOCATION" >/dev/null || fail "Couldn't create the resource group."; echo "     Created."; fi

say "3/6  Signing account…"
az extension add --name trustedsigning --upgrade --only-show-errors >/dev/null 2>&1 || fail "Couldn't add the Azure CLI extension for Artifact Signing."
ACCOUNT=$(az trustedsigning list -g "$RG" --query "[0].name" -o tsv 2>/dev/null)
if [ -n "$ACCOUNT" ]; then
  echo "     Using the existing account: $ACCOUNT"
else
  ACCOUNT="${ACCOUNT_NAME:-tallybooks$(( RANDOM % 9000 + 1000 ))}"
  az trustedsigning create -n "$ACCOUNT" -g "$RG" -l "$REGION" --sku Basic >/dev/null \
    || fail "Couldn't create the signing account '$ACCOUNT'. If the name is taken, run again with ACCOUNT_NAME=anothername in front."
  echo "     Created: $ACCOUNT (Basic plan, about US\$10 a month)"
fi
ACCOUNT_ID=$(az trustedsigning show -n "$ACCOUNT" -g "$RG" --query id -o tsv)
ENDPOINT=$(az trustedsigning show -n "$ACCOUNT" -g "$RG" --query "accountUri || properties.accountUri" -o tsv 2>/dev/null)
if [ -z "$ENDPOINT" ]; then   # work it out from the region instead
  LOC=$(az trustedsigning show -n "$ACCOUNT" -g "$RG" --query location -o tsv | tr -d ' ' | tr 'A-Z' 'a-z')
  case "$LOC" in
    eastus) S=eus;; westus) S=wus;; westus2) S=wus2;; westus3) S=wus3;; centralus) S=cus;; northcentralus) S=ncus;;
    southcentralus) S=scus;; westcentralus) S=wcus;; northeurope) S=neu;; westeurope) S=weu;; brazilsouth) S=brs;;
    japaneast) S=jpe;; koreacentral) S=krc;; polandcentral) S=plc;; switzerlandnorth) S=swn;; *) S='';;
  esac
  [ -n "$S" ] && ENDPOINT="https://$S.codesigning.azure.net"
fi
ENDPOINT="${ENDPOINT%/}"

# Role names changed when Trusted Signing was renamed Artifact Signing, so look them up.
role() { az role definition list --query "[?contains(roleName, '$1')].roleName | [0]" -o tsv; }
VERIFIER=$(role 'Signing Identity Verifier')
SIGNER=$(role 'Certificate Profile Signer')
[ -n "$VERIFIER" ] && [ -n "$SIGNER" ] || fail "Couldn't find the Artifact Signing roles. Try again in a few minutes."

say "4/6  Giving you the '$VERIFIER' role (to request identity validation)…"
az role assignment create --assignee-object-id "$ME" --assignee-principal-type User --role "$VERIFIER" --scope "$ACCOUNT_ID" >/dev/null 2>&1 \
  && echo "     Done." || echo "     Already had it (or it's still being set up — that's fine)."

say "5/6  App registration '$APP_NAME' (what GitHub signs as)…"
APP_ID=$(az ad app list --display-name "$APP_NAME" --query "[0].appId" -o tsv)
if [ -z "$APP_ID" ]; then
  APP_ID=$(az ad app create --display-name "$APP_NAME" --query appId -o tsv) || fail "Couldn't create the app registration."
  echo "     Created."
else echo "     Already there."; fi
SP_ID=$(az ad sp show --id "$APP_ID" --query id -o tsv 2>/dev/null || az ad sp create --id "$APP_ID" --query id -o tsv)
# A new client secret each run (the old one keeps working until it expires). Valid 2 years.
SECRET=$(az ad app credential reset --id "$APP_ID" --display-name "github-actions" --years 2 --append --query password -o tsv) \
  || fail "Couldn't create a client secret."

say "6/6  Letting the app sign with this account ('$SIGNER')…"
for i in 1 2 3 4 5 6; do   # a brand-new app can take a minute to be visible to role assignments
  az role assignment create --assignee-object-id "$SP_ID" --assignee-principal-type ServicePrincipal --role "$SIGNER" --scope "$ACCOUNT_ID" >/dev/null 2>&1 && break
  az role assignment list --assignee "$SP_ID" --scope "$ACCOUNT_ID" --query "[?roleDefinitionName=='$SIGNER']" -o tsv | grep -q . && break
  sleep 15
done
echo "     Done."

cat <<EOF

────────────────────────────────────────────────────────────────────────────
 Done with the automatic part. Now, in GitHub: your repo → Settings →
 Secrets and variables → Actions.

 SECRETS tab (New repository secret) — private, don't share these:
   AZURE_TENANT_ID       $TENANT
   AZURE_CLIENT_ID       $APP_ID
   AZURE_CLIENT_SECRET   $SECRET

 VARIABLES tab (New repository variable):
   AZURE_SIGNING_ACCOUNT   $ACCOUNT
   AZURE_SIGNING_ENDPOINT  $ENDPOINT
   AZURE_CERT_PROFILE      (after step B below, the profile's name, e.g. tallybooks)
   AZURE_PUBLISHER_NAME    (after step B below, the name after CN= on the profile)

 Still to do in the Azure portal (open the signing account '$ACCOUNT'):
   A. Identity validation → + New identity → Public → Organization or
      Individual. Microsoft checks it; it takes 1–20 business days.
   B. When it's approved: Certificate profiles → + Create → Public Trust,
      name it (e.g. tallybooks) and pick your validation.

 Clear this screen when you've copied the secret:  clear
────────────────────────────────────────────────────────────────────────────
EOF
