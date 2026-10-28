// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0
//
// optOutManager.mjs — Customer opt-out / opt-in management
//
// Stores opt-out flags in the InteractionLog DynamoDB table under partition key:
// "OPTOUT#<hashedCustomerId>", with in-memory resilient fallback for local tests/cache.

import { DynamoDBClient, GetItemCommand, PutItemCommand } from "@aws-sdk/client-dynamodb";
import crypto from 'crypto';

const dynamo = new DynamoDBClient({ region: process.env.AWS_REGION || "us-east-1" });
const optOutMemorySet = new Set();

/**
 * Hash customer identifier (MSISDN or email) using SHA-256 for pseudonymization.
 */
const hashCustomerId = (id) => {
    return crypto.createHash('sha256').update(String(id || '')).digest('hex').slice(0, 16);
};

/**
 * Check if a customer has opted out.
 * Returns true if opted out, false if opted in (default).
 */
export const checkOptOut = async (customerId) => {
    const table = process.env.INTERACTION_LOG_DYNAMODB_TABLE || process.env.INTERACTION_LOG_TABLE;
    const hashedId = hashCustomerId(customerId);

    if (table) {
        try {
            const result = await dynamo.send(new GetItemCommand({
                TableName: table,
                Key: {
                    interactionId: { S: `OPTOUT#${hashedId}` },
                    timestamp: { N: '0' }
                }
            }));
            if (result.Item?.optedOut) {
                return result.Item.optedOut.BOOL === true;
            }
        } catch (error) {
            console.warn('optOutManager: DynamoDB read error, using in-memory set:', error.message);
        }
    }

    return optOutMemorySet.has(hashedId);
};

/**
 * Record or clear an opt-out for a customer.
 * @param {string} customerId - Raw MSISDN or email address
 * @param {boolean} optOut - true to opt out, false to opt back in
 */
export const recordOptOut = async (customerId, optOut) => {
    const table = process.env.INTERACTION_LOG_DYNAMODB_TABLE || process.env.INTERACTION_LOG_TABLE;
    const hashedId = hashCustomerId(customerId);
    const action = optOut ? 'OPT_OUT' : 'OPT_IN';

    if (optOut) {
        optOutMemorySet.add(hashedId);
    } else {
        optOutMemorySet.delete(hashedId);
    }

    if (table) {
        try {
            await dynamo.send(new PutItemCommand({
                TableName: table,
                Item: {
                    interactionId: { S: `OPTOUT#${hashedId}` },
                    timestamp: { N: '0' },
                    customerId: { S: hashedId },
                    optedOut: { BOOL: optOut },
                    updatedAt: { N: Date.now().toString() },
                    action: { S: action }
                }
            }));
        } catch (error) {
            console.warn('optOutManager: DynamoDB write error:', error.message);
        }
    }
};

export default { checkOptOut, recordOptOut };
