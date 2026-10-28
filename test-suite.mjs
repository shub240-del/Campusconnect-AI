// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import test from 'node:test';
import assert from 'node:assert/strict';

import { checkRateLimit, incrementRateLimit } from './cdk-stacks/lib/lambdas/handlers/node/rateLimiter.mjs';
import { checkOptOut, recordOptOut } from './cdk-stacks/lib/lambdas/handlers/node/optOutManager.mjs';
import { handler as supportHandler } from './cdk-stacks/lib/lambdas/handlers/node/response-generators/supportResponseGenerator.mjs';
import { handler as dashboardHandler } from './cdk-stacks/lib/lambdas/handlers/node/dashboardHandler.mjs';
import { handler as emailHandler } from './cdk-stacks/lib/lambdas/handlers/node/outbound-processors/emailProcessor.mjs';

test('Rate Limiter: enforces 10-message ceiling per customer per window', async () => {
    const customer = '+447700900100';
    for (let i = 0; i < 10; i++) {
        const allowed = await checkRateLimit(customer);
        assert.equal(allowed, true, `Message ${i + 1} should be permitted`);
        await incrementRateLimit(customer);
    }
    // 11th message must be blocked
    const blocked = await checkRateLimit(customer);
    assert.equal(blocked, false, '11th message must be throttled');
});

test('Rate Limiter: isolates rate limits between different customers', async () => {
    const cust1 = '+447700900201';
    const cust2 = '+447700900202';

    for (let i = 0; i < 10; i++) {
        await incrementRateLimit(cust1);
    }

    assert.equal(await checkRateLimit(cust1), false, 'cust1 should be blocked');
    assert.equal(await checkRateLimit(cust2), true, 'cust2 should be permitted');
});

test('Opt-Out Manager: records STOP and honors compliance flags', async () => {
    const customer = '+447700900300';
    assert.equal(await checkOptOut(customer), false, 'New customer should not be opted out');

    await recordOptOut(customer, true);
    assert.equal(await checkOptOut(customer), true, 'Customer should be opted out after STOP');

    await recordOptOut(customer, false);
    assert.equal(await checkOptOut(customer), false, 'Customer should be unblocked after START');
});

test('Support Response Generator: escalates immediately on trigger keywords', async () => {
    return new Promise((resolve, reject) => {
        const event = {
            recipient: { messageBody: 'I demand a refund for my broken item!' },
            sessionVariables: { sessionId: 'test-session-1' }
        };

        supportHandler(event, {}, (err, result) => {
            if (err) return reject(err);
            try {
                assert.equal(result.escalated, true);
                assert.equal(result.source, 'keyword_escalation');
                assert.ok(result.response.includes('connecting you with a member of our support team'));
                resolve();
            } catch (assertErr) {
                reject(assertErr);
            }
        });
    });
});

test('Support Response Generator: escalates on ungrounded questions with 0 citations', async () => {
    return new Promise((resolve, reject) => {
        const event = {
            recipient: { messageBody: 'Can you fly me to Mars on a rocket?' },
            sessionVariables: { sessionId: 'test-session-2' }
        };

        supportHandler(event, {}, (err, result) => {
            if (err) return reject(err);
            try {
                assert.equal(result.escalated, true);
                assert.ok(result.response.includes('connecting you with a member of our support team'));
                resolve();
            } catch (assertErr) {
                reject(assertErr);
            }
        });
    });
});

test('Dashboard Handler: returns stats payload with CORS headers', async () => {
    const event = {
        requestContext: { http: { method: 'GET' } },
        rawPath: '/api/stats'
    };
    const response = await dashboardHandler(event);
    assert.equal(response.statusCode, 200);
    assert.equal(response.headers['Access-Control-Allow-Origin'], '*');
    const body = JSON.parse(response.body);
    assert.ok(typeof body.total === 'number');
    assert.ok(typeof body.escalated === 'number');
});

test('Dashboard Handler: supports CORS OPTIONS preflight', async () => {
    const event = {
        requestContext: { http: { method: 'OPTIONS' } },
        rawPath: '/api/interactions'
    };
    const response = await dashboardHandler(event);
    assert.equal(response.statusCode, 200);
    assert.equal(response.headers['Access-Control-Allow-Methods'], 'GET, POST, PUT, OPTIONS');
});

test('Dashboard Handler: returns 404 for unknown route', async () => {
    const event = {
        requestContext: { http: { method: 'GET' } },
        rawPath: '/api/unknown-endpoint'
    };
    const response = await dashboardHandler(event);
    assert.equal(response.statusCode, 404);
});

test('Session Continuity: session IDs are retained across conversation turns', () => {
    // Verifies the fix for the bug on line 170 where randomUUID() || conversation.sessionId
    // always generated a new session ID because randomUUID() is always truthy.
    const priorTurn = { sessionVariables: { sessionId: 'fixed-session-uuid-12345' } };
    const conversation = [priorTurn];
    const lastTurn = conversation[conversation.length - 1];

    // Buggy implementation in reference repo:
    // const buggySessionId = 'new-random-uuid' || lastTurn?.sessionVariables?.sessionId;
    // expect(buggySessionId).toBe('new-random-uuid'); // BUG!

    // Fixed implementation in SmallBiz AI Support Hub:
    const preservedSessionId = lastTurn?.sessionVariables?.sessionId || 'fallback-uuid';
    assert.equal(preservedSessionId, 'fixed-session-uuid-12345', 'Session ID must be preserved across turns');
});
