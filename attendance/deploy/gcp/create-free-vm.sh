#!/usr/bin/env bash
# =============================================================================
# Creates a Google Cloud "Always Free" e2-micro VM and installs Restaurant Attendance on it.
# Run in Google Cloud Shell (https://shell.cloud.google.com), which is already signed in:
#
#   git clone -b claude/restaurant-attendance-system https://github.com/Faizurr/skynetmealplanner.git
#   bash skynetmealplanner/attendance/deploy/gcp/create-free-vm.sh
#
# Optional environment variables:
#   PROJECT=my-project  ZONE=us-west1-b  VM_NAME=attendance
#   DOMAIN=attendance.example.com  LE_EMAIL=you@example.com
#   REPO_URL=https://github.com/Faizurr/skynetmealplanner.git  BRANCH=claude/restaurant-attendance-system
#   STATIC_IP=true   (reserve a static external IP; see the cost note in docs/GCP_FREE_TIER.md)
#
# Free-tier rules this script follows: e2-micro, region us-west1 / us-central1 / us-east1,
# 30 GB *standard* persistent disk. Check your billing report after the first days.
# =============================================================================
set -euo pipefail

PROJECT=${PROJECT:-$(gcloud config get-value project 2>/dev/null)}
ZONE=${ZONE:-us-west1-b}
VM_NAME=${VM_NAME:-attendance}
REPO_URL=${REPO_URL:-https://github.com/Faizurr/skynetmealplanner.git}
BRANCH=${BRANCH:-claude/restaurant-attendance-system}
DOMAIN=${DOMAIN:-}
LE_EMAIL=${LE_EMAIL:-}
STATIC_IP=${STATIC_IP:-false}
REGION=${ZONE%-*}

die() { printf '\033[1;31mERROR: %s\033[0m\n' "$*" >&2; exit 1; }
log() { printf '\n\033[1;32m==> %s\033[0m\n' "$*"; }

[ -n "$PROJECT" ] || die "no project selected: run 'gcloud config set project <PROJECT_ID>' or pass PROJECT=..."
case "$REGION" in us-west1|us-central1|us-east1) ;; *) die "zone $ZONE is outside the free-tier regions (us-west1, us-central1, us-east1)";; esac

log "Project $PROJECT, zone $ZONE"
gcloud services enable compute.googleapis.com --project "$PROJECT"

log "Firewall rules for HTTP/HTTPS (tag: attendance-web)"
if ! gcloud compute firewall-rules describe attendance-allow-web --project "$PROJECT" >/dev/null 2>&1; then
  gcloud compute firewall-rules create attendance-allow-web --project "$PROJECT" \
    --direction=INGRESS --action=ALLOW --rules=tcp:80,tcp:443 --target-tags=attendance-web \
    --source-ranges=0.0.0.0/0 --description="Restaurant Attendance: HTTPS (and HTTP for certificate issuance)"
fi

ADDRESS_FLAG=()
if [ "$STATIC_IP" = "true" ]; then
  log "Reserving static IP attendance-ip"
  gcloud compute addresses describe attendance-ip --region "$REGION" --project "$PROJECT" >/dev/null 2>&1 \
    || gcloud compute addresses create attendance-ip --region "$REGION" --project "$PROJECT"
  ADDRESS_FLAG=(--address="$(gcloud compute addresses describe attendance-ip --region "$REGION" --project "$PROJECT" --format='value(address)')")
fi

# Startup script: runs as root at boot; installs once (marker file), logs to /var/log/attendance-install.log.
STARTUP=$(mktemp)
cat > "$STARTUP" <<EOF
#!/bin/bash
[ -f /var/lib/attendance-installed ] && exit 0
exec >> /var/log/attendance-install.log 2>&1
echo "=== install started \$(date -Is)"
apt-get update -qq && apt-get install -y -qq git
if [ ! -d /root/src ]; then git clone -b '$BRANCH' '$REPO_URL' /root/src; fi
cd /root/src/attendance
DOMAIN='$DOMAIN' LE_EMAIL='$LE_EMAIL' bash deploy/vps/install.sh && touch /var/lib/attendance-installed
echo "=== install finished \$(date -Is) exit=\$?"
EOF

if gcloud compute instances describe "$VM_NAME" --zone "$ZONE" --project "$PROJECT" >/dev/null 2>&1; then
  log "VM $VM_NAME already exists; leaving it as is"
else
  log "Creating e2-micro VM $VM_NAME (Ubuntu 24.04, 30 GB standard disk)"
  gcloud compute instances create "$VM_NAME" --project "$PROJECT" --zone "$ZONE" \
    --machine-type=e2-micro \
    --image-family=ubuntu-2404-lts-amd64 --image-project=ubuntu-os-cloud \
    --boot-disk-size=30GB --boot-disk-type=pd-standard \
    --tags=attendance-web \
    --metadata-from-file=startup-script="$STARTUP" \
    "${ADDRESS_FLAG[@]}"
fi
rm -f "$STARTUP"

IP=$(gcloud compute instances describe "$VM_NAME" --zone "$ZONE" --project "$PROJECT" --format='value(networkInterfaces[0].accessConfigs[0].natIP)')
URL="https://${DOMAIN:-${IP//./-}.sslip.io}"

cat <<DONE

==========================================================================================
 VM created. The installer is now running on it (10–20 minutes on an e2-micro).

 Watch progress:
   gcloud compute ssh $VM_NAME --zone $ZONE --project $PROJECT --command 'sudo tail -f /var/log/attendance-install.log'

 When it prints "Restaurant Attendance is running", open:
   $URL
 ${DOMAIN:+(First point an A record for $DOMAIN to $IP.)}

 Then:
   - Back up the server config (contains the face-template key and DB passwords):
     gcloud compute ssh $VM_NAME --zone $ZONE --command 'sudo cat /etc/attendance.env'
     -> save it in your password manager.
   - Email setup / single-restaurant lock-down: see docs/GCP_FREE_TIER.md.
   - Set a billing budget alert (Billing > Budgets & alerts) at e.g. US\$1 to catch any unexpected charge.
==========================================================================================
DONE
