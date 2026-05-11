#!/usr/bin/env bash
# bootstrap.sh — One-time GCP project setup for Cloud Coco
# Run from your MacBook with gcloud authenticated.
# Fill in every line marked "# FILL IN:"
set -euo pipefail

# ── Variables ──────────────────────────────────────────────────────────────
# FILL IN: your GCP billing account ID (gcloud billing accounts list)
BILLING_ACCOUNT_ID=""

# A unique project ID (3-30 chars, lowercase letters/numbers/hyphens)
PROJECT_SUFFIX=$(openssl rand -hex 3)
PROJECT_ID="cloud-coco-${PROJECT_SUFFIX}"

REGION="us-central1"
BUCKET_NAME="cloud-coco-memory-${PROJECT_SUFFIX}"
SA_NAME="cloud-coco-sa"

# FILL IN: your Telegram bot token from @BotFather
TELEGRAM_BOT_TOKEN=""

# FILL IN: your Telegram chat ID (send a message to @userinfobot to find it)
ALLOWED_CHAT_IDS=""

# FILL IN: your Anthropic API key
CLAUDE_API_KEY=""

# Auto-generate a 32-byte (64 hex char) encryption key
CONTEXT_PACK_KEY=$(openssl rand -hex 32)

echo "=== Cloud Coco Bootstrap ==="
echo "Project:  ${PROJECT_ID}"
echo "Bucket:   ${BUCKET_NAME}"
echo "Region:   ${REGION}"
echo ""

# ── 1. Create project ──────────────────────────────────────────────────────
echo "[1/9] Creating GCP project..."
gcloud projects create "${PROJECT_ID}" --name="Cloud Coco"
gcloud config set project "${PROJECT_ID}"
export CLOUDSDK_CORE_PROJECT="${PROJECT_ID}"
gcloud billing projects link "${PROJECT_ID}" --billing-account="${BILLING_ACCOUNT_ID}"

# ── 2. Enable APIs ─────────────────────────────────────────────────────────
echo "[2/9] Enabling APIs..."
gcloud services enable \
  run.googleapis.com \
  secretmanager.googleapis.com \
  storage.googleapis.com \
  artifactregistry.googleapis.com

# ── 3. Create GCS bucket ───────────────────────────────────────────────────
echo "[3/9] Creating GCS bucket..."
gcloud storage buckets create "gs://${BUCKET_NAME}" \
  --project="${PROJECT_ID}" \
  --location="${REGION}" \
  --uniform-bucket-level-access

# ── 4. Create service account ──────────────────────────────────────────────
echo "[4/9] Creating service account..."
gcloud iam service-accounts create "${SA_NAME}" \
  --display-name="Cloud Coco Service Account"
SA_EMAIL="${SA_NAME}@${PROJECT_ID}.iam.gserviceaccount.com"

# ── 5. Grant bucket access (object admin on this bucket only) ──────────────
echo "[5/9] Granting bucket IAM..."
gcloud storage buckets add-iam-policy-binding "gs://${BUCKET_NAME}" \
  --member="serviceAccount:${SA_EMAIL}" \
  --role="roles/storage.objectAdmin" \
  --project="${PROJECT_ID}"

# ── 6. Create secrets ──────────────────────────────────────────────────────
echo "[6/9] Creating secrets..."
printf '%s' "${CLAUDE_API_KEY}"      | gcloud secrets create CLAUDE_API_KEY      --data-file=-
printf '%s' "${TELEGRAM_BOT_TOKEN}"  | gcloud secrets create TELEGRAM_BOT_TOKEN  --data-file=-
printf '%s' "${CONTEXT_PACK_KEY}"    | gcloud secrets create CONTEXT_PACK_KEY    --data-file=-
printf '%s' "${ALLOWED_CHAT_IDS}"    | gcloud secrets create ALLOWED_CHAT_IDS    --data-file=-

# ── 7. Grant Secret Manager accessor on each secret ───────────────────────
echo "[7/9] Granting Secret Manager IAM..."
for SECRET in CLAUDE_API_KEY TELEGRAM_BOT_TOKEN CONTEXT_PACK_KEY ALLOWED_CHAT_IDS; do
  gcloud secrets add-iam-policy-binding "${SECRET}" \
    --member="serviceAccount:${SA_EMAIL}" \
    --role="roles/secretmanager.secretAccessor"
done

# ── 8. Create Artifact Registry repo ──────────────────────────────────────
echo "[8/9] Creating Artifact Registry repo..."
gcloud artifacts repositories create cloud-coco \
  --repository-format=docker \
  --location="${REGION}" \
  --description="Cloud Coco container images"

# ── 9. Save local env file for sync script ────────────────────────────────
echo "[9/9] Writing ~/.env.cloud-coco..."
cat > "${HOME}/.env.cloud-coco" <<EOF
CLAUDE_API_KEY=${CLAUDE_API_KEY}
CONTEXT_PACK_KEY=${CONTEXT_PACK_KEY}
GCS_BUCKET=${BUCKET_NAME}
EOF
chmod 600 "${HOME}/.env.cloud-coco"

# ── Done ───────────────────────────────────────────────────────────────────
IMAGE="${REGION}-docker.pkg.dev/${PROJECT_ID}/cloud-coco/cloud-coco"

echo ""
echo "=== Bootstrap complete ==="
echo ""
echo "CONTEXT_PACK_KEY (save this): ${CONTEXT_PACK_KEY}"
echo ""
echo "Next steps:"
echo ""
echo "  1. Push first context pack:"
echo "     GCS_BUCKET=${BUCKET_NAME} bun sync"
echo ""
echo "  2. Build and push image:"
echo "     gcloud auth configure-docker ${REGION}-docker.pkg.dev"
echo "     docker build -t ${IMAGE}:latest ."
echo "     docker push ${IMAGE}:latest"
echo ""
echo "  3. Deploy to Cloud Run:"
echo "     gcloud run deploy cloud-coco \\"
echo "       --image=${IMAGE}:latest \\"
echo "       --region=${REGION} \\"
echo "       --service-account=${SA_EMAIL} \\"
echo "       --execution-environment=gen2 \\"
echo "       --add-volume=name=memory,type=cloud-storage,bucket=${BUCKET_NAME} \\"
echo "       --add-volume-mount=volume=memory,mount-path=/memory \\"
echo "       --min-instances=0 \\"
echo "       --max-instances=1 \\"
echo "       --memory=512Mi \\"
echo "       --cpu=1 \\"
echo "       --timeout=30s \\"
echo "       --no-allow-unauthenticated"
echo ""
echo "  4. Register Telegram webhook:"
echo "     SERVICE_URL=\$(gcloud run services describe cloud-coco --region=${REGION} --format='value(status.url)')"
echo "     curl -X POST \"https://api.telegram.org/bot\${TELEGRAM_BOT_TOKEN}/setWebhook\" \\"
echo "          -d \"url=\${SERVICE_URL}/webhook\""
echo ""
echo "  5. Allow Cloud Run to serve (Telegram needs to reach it):"
echo "     gcloud run services add-iam-policy-binding cloud-coco \\"
echo "       --region=${REGION} \\"
echo "       --member=allUsers \\"
echo "       --role=roles/run.invoker"
