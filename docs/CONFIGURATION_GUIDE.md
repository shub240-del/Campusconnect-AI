# SmallBiz AI Support Hub — Configuration Guide

## Environment Overview

All configuration is managed through AWS Systems Manager (SSM) Parameter Store.
The CDK stack reads these parameters at deploy time and injects them as Lambda environment variables.
**Never put secrets in config.params.json or source code.**

---

## Required Configuration Parameters

Run the interactive configuration script first:
```bash
cd cdk-stacks
node configure.js
```

### Core Parameters (from base repository)

| SSM Parameter Path | Description | Example |
|:---|:---|:---|
| `/SmallBizSupport/smsSNSTopicARN` | SNS topic ARN for inbound SMS | `arn:aws:sns:...` |
| `/SmallBizSupport/whatsappSNSTopicARN` | SNS topic ARN for inbound WhatsApp | `arn:aws:sns:...` |
| `/SmallBizSupport/rcsSNSTopicARN` | SNS topic ARN for inbound RCS | `arn:aws:sns:...` |
| `/SmallBizSupport/originationNumberId` | SMS phone number resource ID (Pinpoint) | `phone-number-xxxxx` |
| `/SmallBizSupport/bedrockModelId` | Bedrock foundation model ID | `amazon.nova-lite-v1:0` |

### New Parameters (SmallBiz AI Support Hub)

| SSM Parameter Path | Description | Required |
|:---|:---|:---|
| `/SmallBizSupport/sesFromAddress` | Verified SES email for sending | **Required** |
| `/SmallBizSupport/operatorEmailAddress` | Operator alert email recipient | **Required** |
| `/SmallBizSupport/knowledgeBaseId` | Bedrock KB ID (created post-deploy) | **Required** |
| `/SmallBizSupport/escalationKeywords` | Comma-separated trigger words | Optional (has defaults) |
| `/SmallBizSupport/rateLimitPerWindow` | Max messages per 10-min window | Optional (default: 10) |
| `/SmallBizSupport/agentCoreRuntimeArn` | AgentCore Runtime ARN (post-deploy) | Optional (has Lambda fallback) |
| `/SmallBizSupport/dashboardUrl` | CloudFront URL of operator dashboard | Optional |

---

## AWS Account Pre-Configuration Checklist

### 1. Amazon SES Setup (Required for email alerts)
```
Console: Amazon SES → Verified Identities → Create Identity
Type: Email or Domain
Action: Verify your FROM address and operator@yourdomain.com
Note: Request sandbox removal for production sending
```

### 2. Bedrock Model Access (Required for AI responses)
```
Console: Amazon Bedrock → Model Access → Manage Model Access
Enable: Amazon Nova Lite (amazon.nova-lite-v1:0)
Enable: Amazon Titan Embeddings V2 (for Knowledge Base)
Approval: Usually instant for Nova Lite; Claude may require brief review
```

### 3. Knowledge Base Setup (Required — post CDK deploy)
```
Console: Amazon Bedrock → Knowledge Bases → Create Knowledge Base
Name: SmallBizSupportKB
Data Source: S3 — select the KnowledgeBucket created by CDK deploy
Embedding Model: amazon.titan-embed-text-v2:0
Vector Store: Amazon OpenSearch Serverless (auto-created)
After creation: Copy the Knowledge Base ID to SSM parameter /SmallBizSupport/knowledgeBaseId
Sync: Click "Sync" to index the FAQ/policy documents in data/knowledge/
```

### 4. WhatsApp Business Account (Required for WhatsApp channel)
```
Pre-requisite: Meta Business Manager account
Console: AWS End User Messaging → Social Messaging → Configure WhatsApp
Follow: AWS WAB onboarding wizard
Lead time: 1–5 business days for Meta approval
```

### 5. SMS / 10DLC Campaign (Required for US SMS)
```
Console: AWS End User Messaging → Phone Numbers → Request
Type: 10DLC Long Code or Toll-Free Number
Registration: Complete 10DLC brand and campaign registration
Lead time: 3–14 business days for carrier approval
Note: Use sandbox numbers for development/demo
```

---

## Deployment Steps

### Full Deploy
```bash
# 1. Install CDK dependencies
cd cdk-stacks && npm install

# 2. Install Lambda dependencies
cd lib/lambdas/handlers/node && npm install && cd ../../../..

# 3. Configure SSM parameters
node configure.js

# 4. Deploy CDK stacks
npm run cdk:bootstrap  # First time only
npm run cdk:deploy

# 5. Upload knowledge documents to S3
aws s3 sync ../data/knowledge/ s3://<KnowledgeBucketName>/knowledge/

# 6. Seed BusinessOrders table
aws dynamodb batch-write-item --request-items file://../data/dynamodb-seed.json

# 7. Sync Bedrock Knowledge Base
# Console: Bedrock → Knowledge Bases → SmallBizSupportKB → Sync
```

### Dashboard Deployment
```bash
# Build and upload dashboard to S3
aws s3 sync ../dashboard/ s3://<DashboardBucketName>/

# Create CloudFront invalidation after update
aws cloudfront create-invalidation --distribution-id <DIST_ID> --paths "/*"
```

---

## Environment Variables Injected by CDK

These are automatically set on Lambda functions — do not set manually:

| Variable | Lambda | Value Source |
|:---|:---|:---|
| `CONTEXT_DYNAMODB_TABLE` | All | CDK resource name |
| `USECASE_DYNAMODB_TABLE` | Orchestrator | CDK resource name |
| `INTERACTION_LOG_DYNAMODB_TABLE` | Orchestrator, Escalation | CDK resource name |
| `RATE_LIMIT_DYNAMODB_TABLE` | Orchestrator | CDK resource name |
| `ORDERS_DYNAMODB_TABLE` | AgentCore agent | CDK resource name |
| `KNOWLEDGE_BASE_ID` | SupportResponseGenerator | SSM parameter |
| `BEDROCK_MODEL_ARN` | SupportResponseGenerator | Constructed from model ID |
| `SES_FROM_ADDRESS` | emailProcessor, escalationNotifier | SSM parameter |
| `OPERATOR_EMAIL_ADDRESS` | escalationNotifier | SSM parameter |
| `AGENTCORE_RUNTIME_ARN` | SupportResponseGenerator | SSM parameter (optional) |
| `ESCALATION_KEYWORDS` | SupportResponseGenerator | SSM parameter (optional) |
| `MAX_MESSAGES_PER_WINDOW` | Orchestrator | SSM parameter (optional) |
| `RATE_LIMIT_WINDOW_SECONDS` | Orchestrator | Hardcoded: 600 |
| `SESSION_SECONDS` | Orchestrator | SSM parameter |
| `APPLICATION_VERSION` | All | CDK app version |
| `AWS_REGION` | All | Lambda runtime |
| `DEFAULT_CONFIGURATION_SET` | smsProcessor | SSM parameter (optional) |

---

## Verification After Deploy

Run these smoke checks after a successful CDK deploy:

```bash
# 1. Check DynamoDB tables exist
aws dynamodb list-tables | grep SmallBiz

# 2. Verify UseCaseConfig has "support" entry
aws dynamodb get-item \
  --table-name <UseCaseConfigTableName> \
  --key '{"useCase": {"S": "support"}}'

# 3. Check S3 knowledge documents are present
aws s3 ls s3://<KnowledgeBucketName>/knowledge/

# 4. Test chatOrchestrator directly (process action)
aws lambda invoke \
  --function-name SmallBizChatOrchestrator \
  --payload '{"inboundMessage": {"action": "process", "channel": "whatsapp", "destinationAddress": "+447700000001", "messageBody": "What is your return policy?", "useCaseId": "support"}}' \
  response.json && cat response.json

# 5. Check CloudWatch logs for errors
aws logs tail /aws/lambda/SmallBizChatOrchestrator --follow
```
