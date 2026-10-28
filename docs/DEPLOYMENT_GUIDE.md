# SmallBiz AI Support Hub — Deployment Guide

## Overview

**SmallBiz AI Support Hub** transforms the AWS multi-channel reference architecture into a complete, enterprise-grade AI customer support and automated follow-up product tailored for small businesses.

It connects customers on **WhatsApp**, **SMS**, and **Email** to:
1. **Bedrock Knowledge Base** — Grounded AI answers from business FAQs, shipping, and return policies (zero hallucination).
2. **Order Status Service** — Instant lookups against real or mock order records via Bedrock AgentCore Runtime.
3. **Automated Escalation Guardrails** — Sensitives keywords and low-confidence queries escalate to human operators with SES email alerts.
4. **Safety & Compliance Modules** — Rate limiting (10 msg/10 min), STOP opt-out compliance, and permanent audit logging in DynamoDB.
5. **Operator Dashboard** — Real-time dark-glassmorphism web UI for monitoring tickets, viewing threads, replying, and resolving issues.

---

## Prerequisites

1. **AWS CLI v2** configured with Administrator credentials:
   ```bash
   aws sts get-caller-identity
   ```
2. **Node.js** (v20+ or v22 LTS) and **npm**:
   ```bash
   node --version
   npm --version
   ```
3. **AWS CDK v2** installed globally:
   ```bash
   npm install -g aws-cdk
   cdk --version
   ```
4. **Python 3.12** (required for Bedrock AgentCore Runtime packaging):
   ```bash
   python --version
   ```
5. **Amazon Bedrock Model Access**:
   - In AWS Console → **Amazon Bedrock** → **Model access**
   - Enable `Amazon Nova Micro` / `Amazon Nova Lite` / `Claude 3.5 Sonnet` in your target region.

---

## Architecture Components Deployed

| Construct | AWS Resource | Details |
|:---|:---|:---|
| **Chat Orchestrator** | AWS Lambda (Node.js 22) | Multi-channel session router with session continuity fix and idempotency |
| **Support Response Generator** | AWS Lambda (Node.js 22) | KB retrieval + confidence gating + order tool lookup + escalation trigger |
| **Escalation Notifier** | AWS Lambda (Node.js 22) | Human alert dispatcher via Amazon SES |
| **Dashboard Handler** | AWS Lambda (Node.js 22) | REST API for operator ticket management and manual replies |
| **AgentCore Runtime** | Bedrock AgentCore | Serverless Python container runtime running order tools |
| **DynamoDB Tables** | Amazon DynamoDB | `ChatContext`, `UseCaseConfig`, `InteractionLog`, `BusinessOrders`, `RateLimitTable` |
| **Dashboard Web UI** | Amazon S3 + HTTP API | Static SPA with real-time ticket triage and channel replies |
| **Guardrails** | Amazon Bedrock Guardrails | Prompt injection protection (HIGH) + PII entity masking |

---

## Step-by-Step Deployment

### Step 1: Install Dependencies

```bash
# From workspace root
cd cdk-stacks
npm run install:all
```

This installs both CDK infrastructure dependencies and Lambda runtime dependencies.

### Step 2: Configure Parameters via SSM

Run the interactive configuration wizard or configure via AWS Systems Manager:

```bash
# Interactive setup
npm run configure
```

Alternatively, push required parameters directly using AWS CLI:
```bash
# Enable SMS (optional)
aws ssm put-parameter --name "/MultiChannelGenAI2/smsEnabled" --value "true" --type "String" --overwrite
aws ssm put-parameter --name "/MultiChannelGenAI2/smsOriginationNumberId" --value "phone-number-id-xxx" --type "String" --overwrite

# Enable WhatsApp (recommended)
aws ssm put-parameter --name "/MultiChannelGenAI2/whatsappEnabled" --value "true" --type "String" --overwrite
aws ssm put-parameter --name "/MultiChannelGenAI2/whatsAppBusinessAccountId" --value "waba-xxx" --type "String" --overwrite
aws ssm put-parameter --name "/MultiChannelGenAI2/whatsappOriginationNumberId" --value "phone-number-id-xxx" --type "String" --overwrite

# Enable Bedrock Knowledge Base (recommended)
aws ssm put-parameter --name "/MultiChannelGenAI2/useBedrockKnowledgeBase" --value "true" --type "String" --overwrite
aws ssm put-parameter --name "/MultiChannelGenAI2/bedrockKnowledgeBaseId" --value "YOUR_KB_ID" --type "String" --overwrite

# Set Operator Email & SES From Address
aws ssm put-parameter --name "/MultiChannelGenAI2/operatorEmailAddress" --value "operator@yourbusiness.com" --type "String" --overwrite
aws ssm put-parameter --name "/MultiChannelGenAI2/sesFromAddress" --value "support@yourbusiness.com" --type "String" --overwrite
```

### Step 3: Seed Knowledge Base Documents (Optional but Recommended)

Seed documents are provided in `data/knowledge/`:
- `data/knowledge/faq.txt`
- `data/knowledge/shipping-policy.txt`
- `data/knowledge/return-policy.txt`

Upload these files to your Bedrock Knowledge Base S3 bucket and trigger a sync job:
```bash
aws s3 sync ../data/knowledge/ s3://YOUR-BEDROCK-KB-BUCKET/
aws bedrock-agent start-ingestion-job --knowledge-base-id YOUR_KB_ID --data-source-id YOUR_DS_ID
```

### Step 4: Deploy CDK Stacks

```bash
# Bootstrap your AWS environment (if first time using CDK in account/region)
cdk bootstrap

# Deploy all stacks
npm run cdk:deploy
```

Upon completion, CloudFormation outputs the endpoints:
- `DashboardWebsiteUrl` — URL of the Operator Dashboard
- `DashboardApiEndpoint` — REST API endpoint
- `chatOrchestratorLambdaARN` — Core router ARN
- `InteractionLogTable` — Permanent audit table

---

## Verifying Deployment

1. **Open Operator Dashboard**:
   Navigate to the `DashboardWebsiteUrl` printed in CDK outputs. The dashboard will display live system stats, active tickets, and recent customer interactions.
2. **Send Test WhatsApp Message**:
   Send `"Track order ORD-7781"` to your WhatsApp Business number.
   - Expected reply: `Order ORD-7781: Status: Shipped | Product: Wireless Noise-Cancelling Headphones | Estimated Delivery: Nov 3, 2026`
3. **Test Escalation Trigger**:
   Send `"I want an immediate refund because my item was damaged"`.
   - Expected reply: `Thank you for reaching out. I'm connecting you with a member of our support team who will be in touch shortly.`
   - Check operator email for escalation notification with full thread.
   - Check dashboard for ticket marked with red `ESCALATED` badge.
4. **Test STOP Opt-Out**:
   Send `"STOP"` via SMS or WhatsApp.
   - Confirmation received; subsequent messages are blocked.
   - Send `"START"` to resume.

---

## Clean-up / Destroy

To prevent ongoing charges when testing is finished:
```bash
cd cdk-stacks
cdk destroy --all
```
