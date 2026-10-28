// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0
//
// InteractionLogService.mjs — Permanent interaction audit log
//
// Writes every inbound / outbound event to the InteractionLog DynamoDB table.
// This table is permanent (no TTL) and serves as the data source for the operator dashboard.
// Customer identifiers are SHA-256 hashed before storage (pseudonymization).

import { DynamoDBClient, PutItemCommand } from "@aws-sdk/client-dynamodb";
import crypto from 'crypto';
import { randomUUID } from 'crypto';

const dynamo = new DynamoDBClient({ region: process.env.AWS_REGION });
const TABLE = process.env.INTERACTION_LOG_DYNAMODB_TABLE;

/**
 * Pseudonymize customer identifier (MSISDN / email) via SHA-256.
 * Production: Replace with HMAC-SHA256 keyed from Secrets Manager.
 */
const hashCustomerId = (id) => {
    if (!id) return 'unknown';
    return crypto.createHash('sha256').update(id).digest('hex').slice(0, 16);
};

/**
 * Write a single interaction event to the InteractionLog table.
 *
 * @param {Object} params
 * @param {string} params.customerId        - Raw MSISDN or email (will be hashed)
 * @param {string} params.channel           - 'whatsapp' | 'sms' | 'email' | 'api'
 * @param {string} params.direction         - 'inbound' | 'outbound'
 * @param {string} params.status            - PENDING | RESOLVED | ESCALATED | REPLIED | OPT_OUT | RATE_LIMITED | ERROR
 * @param {string} [params.source]          - 'KB' | 'AgentCore' | 'KB+AgentCore' | 'Operator' | 'template' | 'forward'
 * @param {string} [params.messageBody]     - XSS-sanitized message text
 * @param {string} [params.deliveryMessageId] - EUM / SES confirmation message ID
 * @param {string} [params.errorCode]       - AWS API error code if delivery failed
 * @param {string} [params.operatorId]      - Set when operator acts on a ticket
 * @param {string} [params.sessionId]       - Bedrock KB / Agent session ID
 * @param {string} [params.escalationReason] - Keyword or low-confidence trigger
 * @param {string} [params.interactionId]   - Override auto-generated UUID (for linking inbound+outbound to same ticket)
 */
export const InteractionLogService = {
    write: async (params) => {
        if (!TABLE) {
            console.warn('INTERACTION_LOG_DYNAMODB_TABLE not set — interaction log write skipped');
            return;
        }

        const {
            customerId,
            channel,
            direction,
            status,
            source,
            messageBody,
            deliveryMessageId,
            errorCode,
            operatorId,
            sessionId,
            escalationReason,
            interactionId: overrideId
        } = params;

        const interactionId = overrideId || randomUUID();
        const hashedCustomerId = hashCustomerId(customerId);

        const item = {
            interactionId: { S: interactionId },
            timestamp: { N: Date.now().toString() },
            customerId: { S: hashedCustomerId },
            channel: { S: channel || 'unknown' },
            direction: { S: direction || 'inbound' },
            status: { S: status || 'PENDING' }
        };

        // Optional attributes — only write if provided (avoids storing null strings)
        if (source) item.source = { S: source };
        if (messageBody) item.messageBody = { S: String(messageBody).slice(0, 1000) }; // Truncate at 1KB
        if (deliveryMessageId) item.deliveryMessageId = { S: deliveryMessageId };
        if (errorCode) item.errorCode = { S: errorCode };
        if (operatorId) item.operatorId = { S: operatorId };
        if (sessionId) item.sessionId = { S: sessionId };
        if (escalationReason) item.escalationReason = { S: escalationReason };

        console.debug('InteractionLogService.write:', JSON.stringify(item, null, 2));

        try {
            await dynamo.send(new PutItemCommand({
                TableName: TABLE,
                Item: item
            }));
        } catch (error) {
            // Log but do not throw — audit log failure should not crash message processing
            console.error('InteractionLogService.write error:', error);
        }
    },

    /**
     * Convenience method for logging errors without crashing the caller.
     */
    writeError: async (customerId, channel, errorCode, errorMessage) => {
        await InteractionLogService.write({
            customerId,
            channel: channel || 'unknown',
            direction: 'inbound',
            status: 'ERROR',
            errorCode,
            messageBody: errorMessage
        });
    }
};
