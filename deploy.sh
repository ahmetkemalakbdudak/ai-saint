#!/bin/bash

# Debug mode
set -x

# Print start message
echo "Starting AI-Saint deployment..."

# Navigate to backend directory
cd backend || { echo "Error: backend directory not found"; exit 1; }

# Deploy to Cloud Run with all necessary configurations
gcloud run deploy ai-saint-backend \
  --source . \
  --region us-central1 \
  --allow-unauthenticated \
  --set-secrets FIREBASE_SERVICE_ACCOUNT=firebase-service-account:latest,GEMINI_API_KEY=gemini-api-key:latest,FIREBASE_STORAGE_BUCKET=firebase-storage-bucket:latest \
  --set-env-vars NODE_ENV=production

# Check deployment status
if [ $? -eq 0 ]; then
    echo "✅ Deployment completed successfully"
else
    echo "❌ Deployment failed"
    exit 1
fi

# Return to root directory
cd ..

echo "Deployment process finished" 