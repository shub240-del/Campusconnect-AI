// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0
//
// rateLimiter.mjs — DynamoDB token-bucket rate limiter with in-memory resilient fallback
// 
// Limits: MAX_MESSAGES_PER_WINDOW (default 10) per customer per RATE_LIMIT_WINDOW_SECONDS (default 600s).
// Uses a DynamoDB table with TTL-based automatic key expiry, with in-memory fallback.

import { DynamoDBClient, GetItemCommand, UpdateItemCommand } from "@aws-sdk/client-dynamodb";

const dynamo = new DynamoDBClient({ region: process.env.AWS_REGION || "us-east-1" });
const memoryStore = new Map();

/**
 * Hash a customer identifier (MSISDN or email) for storage as a DDB key.
 */
const hashId = (id) => {
    let hash = 0;
    const str = String(id || '');
    for (let i = 0; i < str.length; i++) {
        hash = ((hash << 5) - hash) + str.charCodeAt(i);
        hash |= 0;
    }
    return Math.abs(hash).toString(16).padStart(8, '0');
};

/**
 * Check if the customer is within the rate limit.
 * Returns true (allowed) if under limit, false (blocked) if limit exceeded.
 */
export const checkRateLimit = async (customerId) => {
    const table = process.env.RATE_LIMIT_DYNAMODB_TABLE || process.env.RATE_LIMIT_TABLE;
    const maxMessages = parseInt(process.env.MAX_MESSAGES_PER_WINDOW || '10', 10);
    const windowSeconds = parseInt(process.env.RATE_LIMIT_WINDOW_SECONDS || '600', 10);

    const hashedId = hashId(customerId);
    const nowSeconds = Math.floor(Date.now() / 1000);
    const windowStart = nowSeconds - (nowSeconds % windowSeconds);

    if (table) {
        try {
            const result = await dynamo.send(new GetItemCommand({
                TableName: table,
                Key: {
                    customerId: { S: hashedId },
                    windowStart: { N: windowStart.toString() }
                }
            }));

            if (!result.Item) return true;
            const count = parseInt(result.Item.messageCount?.N || '0', 10);
            return count < maxMessages;
        } catch (error) {
            console.warn('rateLimiter: DynamoDB read error, falling back to memoryStore:', error.message);
        }
    }

    // In-memory store (active in unit test mode and local dev)
    const key = `${hashedId}:${windowStart}`;
    const count = memoryStore.get(key) || 0;
    return count < maxMessages;
};

/**
 * Increment the message counter for this customer's current window.
 */
export const incrementRateLimit = async (customerId) => {
    const table = process.env.RATE_LIMIT_DYNAMODB_TABLE || process.env.RATE_LIMIT_TABLE;
    const windowSeconds = parseInt(process.env.RATE_LIMIT_WINDOW_SECONDS || '600', 10);

    const hashedId = hashId(customerId);
    const nowSeconds = Math.floor(Date.now() / 1000);
    const windowStart = nowSeconds - (nowSeconds % windowSeconds);
    const ttl = windowStart + windowSeconds + 60;

    // Track in-memory
    const key = `${hashedId}:${windowStart}`;
    const current = memoryStore.get(key) || 0;
    memoryStore.set(key, current + 1);

    if (table) {
        try {
            await dynamo.send(new UpdateItemCommand({
                TableName: table,
                Key: {
                    customerId: { S: hashedId },
                    windowStart: { N: windowStart.toString() }
                },
                UpdateExpression: 'ADD messageCount :inc SET #ttl = if_not_exists(#ttl, :ttl)',
                ExpressionAttributeNames: { '#ttl': 'ttl' },
                ExpressionAttributeValues: {
                    ':inc': { N: '1' },
                    ':ttl': { N: ttl.toString() }
                }
            }));
        } catch (error) {
            console.warn('rateLimiter: DynamoDB increment error:', error.message);
        }
    }
};

export default { checkRateLimit, incrementRateLimit };
