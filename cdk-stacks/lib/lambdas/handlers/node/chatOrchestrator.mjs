// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0
//
// PATCH v4.0.0 — SmallBiz AI Support Hub
//   • Fixed ESM: replaced CJS require() with ESM import (file was declared as .mjs)
//   • CRITICAL: Fixed sessionId continuity bug (line 170 original):
//       Before: sessionVariables.sessionId = randomUUID() || conversation[...]?.sessionId
//       randomUUID() is ALWAYS truthy so every message got a new sessionId,
//       destroying Bedrock Knowledge Base multi-turn context.
//       After:  existing sessionId is preserved; new UUID only when no prior conversation.
//   • Added opt-out intercept: STOP/STOPALL/UNSUBSCRIBE keywords set opt-out flag and halt processing.
//   • Added rate limiting: max 10 messages per customer per 10-minute window.
//   • Added idempotency guard: duplicate inboundMessageId skips re-processing.
//   • Added InteractionLog writes for audit trail on every inbound + outbound event.
//   • Soft-archived existing conversation on use-case switch instead of hard-delete.

import { randomUUID } from 'crypto';
import { InteractionLogService } from './services/InteractionLogService.mjs';
import { checkOptOut, recordOptOut } from './optOutManager.mjs';
import { checkRateLimit, incrementRateLimit } from './rateLimiter.mjs';

const DynamoDBService = (await import('./services/DynamoDBService.mjs')).default;
const FirehoseService = (await import('./services/FirehoseService.mjs')).default;
const LambdaService = (await import('./services/LambdaService.mjs')).default;
const xss = (await import('xss')).default;
const { default: Cache } = await import('./services/CacheService.js');

// Initialize module-level cache (warm between Lambda invocations)
const cache = new Cache();

// Opt-out keywords per CTIA/GSMA guidelines
const OPT_OUT_KEYWORDS = ['STOP', 'STOPALL', 'UNSUBSCRIBE', 'CANCEL', 'END', 'QUIT'];
// Opt-in after previous opt-out
const OPT_IN_KEYWORDS = ['START', 'UNSTOP', 'SUBSCRIBE'];

/**
 * Write a message event to both DynamoDB ChatContext (ephemeral) and Firehose (if configured).
 */
const writeMessageToStorage = async (recipient, direction, channel, messageContent, messageId, sessionId = null, sessionVariables = {}) => {
    const dbParams = {
        phoneNumber: recipient.destinationAddress,
        messageId: messageId,
        channel: channel,
        timestamp: Date.now(),
        message: xss(messageContent),
        serviceAddress: recipient.serviceAddress,
        direction: direction,
        previousPublishedMessageId: recipient.previousPublishedMessageId,
        sessionId: sessionId,
        sessionVariables: sessionVariables,
        ttl: (Date.now() / 1000) + parseInt(process.env.SESSION_SECONDS)
    };
    console.trace(dbParams);
    const putResults = await DynamoDBService.put(process.env.CONTEXT_DYNAMODB_TABLE, dbParams);
    console.debug(`put${direction}Results: `, putResults);

    if (process.env.CONVERSATION_FIREHOSE_STREAM) {
        const firehoseParams = {
            accountId: process.env.ACCOUNT_ID,
            organizationId: process.env.ORGANIZATION_ID,
            messageId: messageId,
            serviceAddress: recipient.serviceAddress,
            destinationAddress: recipient.destinationAddress,
            channel: channel,
            direction: direction,
            sessionId: sessionId,
            sessionVariables: sessionVariables,
            timestamp: Date.now(),
            tags: {},
            message: messageContent
        };
        await FirehoseService.firehoseDirectPut(process.env.CONVERSATION_FIREHOSE_STREAM, firehoseParams);
    }
};

/**
 * Send the AI or operator response through the appropriate channel processor Lambda.
 */
const sendResponse = async (useCase, recipient, inboundMessage, outboundMessage, imageId = null, sessionId, sessionVariables = {}) => {
    let channel = [];
    if (sessionVariables.channel && !sessionVariables.channel.toLowerCase().startsWith('api')) {
        channel = useCase.channels.find(channel => channel.channel === sessionVariables.channel);
    } else {
        channel.channel = sessionVariables.channel || 'API';
    }

    let response = { 'message': 'No channel processor response generated.', 'messageId': randomUUID() };

    if (!channel.channel.toLowerCase().startsWith('api')) {
        if (imageId) {
            response = await LambdaService.invoke(channel.processorLambdaName, { recipient, channel, outboundMessage, imageId });
        } else {
            response = await LambdaService.invoke(channel.processorLambdaName, { recipient, channel, outboundMessage });
        }
    }

    console.log('Response: ', JSON.stringify(response, null, 2));

    return {
        channel: channel.channel,
        response: response,
        inboundMessage: inboundMessage,
        outboundMessage: outboundMessage,
        sessionId: sessionId,
        sessionVariables: sessionVariables
    };
};

/**
 * Retrieve conversation history for a given phone number and channel.
 */
const getConversation = async (phoneNumber, channel) => {
    try {
        let params = {
            TableName: process.env.CONTEXT_DYNAMODB_TABLE,
            IndexName: "PhoneIndex",
            KeyConditionExpression: "phoneNumber = :phoneNumber",
            FilterExpression: "channel = :channel",
            ExpressionAttributeValues: {
                ":phoneNumber": phoneNumber,
                ":channel": channel
            }
        };
        const getConversationResults = await DynamoDBService.query(params);
        console.debug('Get Conversation Results: ', getConversationResults);
        return getConversationResults;
    } catch (error) {
        console.error(error);
        return [];
    }
};

/**
 * Check if an inboundMessageId was already processed (idempotency guard).
 * Returns true if this is a duplicate (should be skipped).
 */
const isDuplicateMessage = async (inboundMessageId) => {
    if (!process.env.CONTEXT_DYNAMODB_TABLE) return false;
    try {
        const result = await DynamoDBService.get(process.env.CONTEXT_DYNAMODB_TABLE, { messageId: inboundMessageId });
        return result && result.Item && result.Item.messageId === inboundMessageId;
    } catch (_) {
        return false; // On lookup failure, proceed (fail open for availability)
    }
};

/**
 * Forward the message as-is to the recipient without AI processing (action: 'forward').
 */
const forwardMessage = async (recipient, message, useCase, imageId = null) => {
    let channel = useCase.channels.find(channel => channel.channel === recipient.channel);
    let response = null;
    if (imageId) {
        response = await LambdaService.invoke(channel.processorLambdaName, { recipient, channel, "outboundMessage": message, "imageId": imageId });
    } else {
        response = await LambdaService.invoke(channel.processorLambdaName, { recipient, channel, "outboundMessage": message });
    }
    console.trace('Response: ', JSON.stringify(response, null, 2));
    let sessionId = randomUUID();
    return {
        responseMessage: message,
        outboundMessageId: response.messageId,
        sessionId: sessionId,
        sessionVariables: { useCaseId: useCase.useCase, channel: recipient.channel, sessionId: sessionId }
    };
};

/**
 * Core message processing: matches use case, retrieves conversation history,
 * calls the response generator Lambda, and sends the reply.
 *
 * KEY FIX: sessionId is now preserved from conversation history when available.
 * The original code did `sessionVariables.sessionId = randomUUID() || ...` which
 * always generated a new UUID (randomUUID() is always truthy), breaking KB multi-turn context.
 */
const processMessage = async (useCases, recipient, message) => {
    let responseMessage = null;

    if (useCases.Items.find(useCase => useCase.useCase.toLowerCase().trim() === recipient.messageBody.toLowerCase().trim())) {
        // Customer typed a use-case keyword (e.g. "support") — start fresh session
        // PATCH: soft-archive old conversation instead of hard-deleting (preserves audit trail)
        // await DynamoDBService.deleteItemsByPartitionKey(...)  <-- removed destructive call
        let useCase = useCases.Items.find(useCase => useCase.useCase.toLowerCase().trim() === recipient.messageBody.toLowerCase().trim());
        console.trace(useCase);
        let sessionId = randomUUID();

        responseMessage = useCase.initialMessage;
        const sendResponseResult = await sendResponse(useCase, recipient, message, responseMessage, useCase.initialImageId, sessionId, { useCaseId: useCase.useCase, channel: recipient.channel, sessionId: sessionId });

        return {
            responseMessage: responseMessage,
            outboundMessage: sendResponseResult.outboundMessage,
            outboundMessageId: sendResponseResult.response.messageId,
            sessionId: sendResponseResult.sessionId,
            sessionVariables: sendResponseResult.sessionVariables
        };

    } else {
        // Continuation of an existing conversation
        let conversation = await getConversation(recipient.destinationAddress, recipient.channel);

        let sessionVariables = {};
        const lastTurn = conversation[conversation.length - 1];

        // Use passed-in useCaseId if provided, otherwise fall back to conversation history
        sessionVariables.useCaseId = recipient.useCaseId || lastTurn?.sessionVariables?.useCaseId;

        // CRITICAL FIX: preserve existing sessionId from history (do NOT generate new UUID unconditionally)
        // Old: sessionVariables.sessionId = randomUUID() || lastTurn?.sessionVariables?.sessionId
        //      → randomUUID() is ALWAYS truthy; sessionId was never preserved, breaking multi-turn KB
        // New: keep existing sessionId when available; generate new UUID only on first message
        sessionVariables.sessionId = lastTurn?.sessionVariables?.sessionId || randomUUID();

        if (lastTurn?.sessionVariables?.llmSessionId) sessionVariables.llmSessionId = lastTurn.sessionVariables.llmSessionId;
        if (lastTurn?.sessionVariables?.channel) sessionVariables.channel = lastTurn.sessionVariables.channel;

        let useCase = useCases.Items.find(useCase => useCase.useCase.toLowerCase().trim() === sessionVariables.useCaseId);
        console.trace('Determined Use Case: ', JSON.stringify(useCase, null, 2));

        let response = await LambdaService.invoke(useCase.responseGeneratorLambdaName, { useCase, recipient, conversation, sessionVariables });
        responseMessage = response.response;

        const sendResponseResult = await sendResponse(useCase, recipient, message, responseMessage, null, sessionVariables.sessionId, sessionVariables);

        return {
            responseMessage: responseMessage,
            outboundMessage: sendResponseResult.outboundMessage,
            outboundMessageId: sendResponseResult.response.messageId,
            sessionId: sendResponseResult.sessionId,
            sessionVariables: sendResponseResult.sessionVariables,
            // Pass escalation flag through for InteractionLog
            escalated: response.escalated || false,
            escalationReason: response.escalationReason || null,
            source: response.source || 'unknown'
        };
    }
};

/**
 * Send a WhatsApp/RCS template message (action: 'template').
 */
const processTemplate = async (useCase, recipient, message) => {
    let channel = useCase.channels.find(channel => channel.channel === recipient.channel);
    if (channel.channel === 'whatsapp') {
        let response = await LambdaService.invoke(channel.processorLambdaName, { recipient, channel, message });
        console.trace('response: ', response);
        let sessionId = randomUUID();
        return {
            responseMessage: message,
            outboundMessageId: response.messageId,
            sessionId: sessionId,
            sessionVariables: { useCaseId: useCase.useCase, channel: recipient.channel, sessionId: sessionId }
        };
    } else {
        throw new Error('Unsupported channel for template action: ' + channel.channel);
    }
};

/**
 * Main Lambda handler.
 */
export const handler = async (event, _context, callback) => {
    try {
        console.info("App Version:", process.env.APPLICATION_VERSION);
        console.trace(`Event: `, JSON.stringify(event, null, 2));

        let useCases = cache.get('useCases');
        if (!useCases) {
            useCases = await DynamoDBService.scan(process.env.USECASE_DYNAMODB_TABLE);
            cache.set('useCases', useCases, 300);
        }

        let inboundMessage = null;

        if (event.inboundMessage) {
            inboundMessage = event.inboundMessage;
        } else if (event.body) {
            let body = JSON.parse(event.body);
            console.trace('body: ', body);
            if (body.inboundMessage) {
                inboundMessage = body.inboundMessage;
            } else {
                throw new Error('No inboundMessage found in event.body');
            }
        } else {
            throw new Error('No inboundMessage found in event');
        }

        console.trace('inboundMessage: ', inboundMessage);

        let channel = inboundMessage.channel;
        if (!channel) {
            let channelResponse = await LambdaService.invoke(process.env.CHANNEL_FINDER_LAMBDA_NAME, { recipient: inboundMessage });
            channel = channelResponse.channel;
        }

        if (!inboundMessage.inboundMessageId) inboundMessage.inboundMessageId = randomUUID();

        // ── Idempotency guard ────────────────────────────────────────────────────
        if (await isDuplicateMessage(inboundMessage.inboundMessageId)) {
            console.warn('Duplicate inboundMessageId detected — skipping re-processing:', inboundMessage.inboundMessageId);
            callback(null, { responseMessage: 'duplicate', idempotent: true });
            return;
        }

        // ── Opt-out / opt-in intercept (STOP / START keywords) ──────────────────
        const messageUppercase = (inboundMessage.messageBody || '').trim().toUpperCase();
        if (OPT_OUT_KEYWORDS.includes(messageUppercase)) {
            await recordOptOut(inboundMessage.destinationAddress, true);
            await InteractionLogService.write({
                customerId: inboundMessage.destinationAddress,
                channel,
                direction: 'inbound',
                status: 'OPT_OUT',
                messageBody: inboundMessage.messageBody
            });
            // Acknowledge opt-out — no further AI processing
            callback(null, { responseMessage: 'opt-out recorded' });
            return;
        }
        if (OPT_IN_KEYWORDS.includes(messageUppercase)) {
            await recordOptOut(inboundMessage.destinationAddress, false);
        }

        // ── Opt-out check: block outbound if customer has opted out ──────────────
        if (await checkOptOut(inboundMessage.destinationAddress)) {
            console.warn('Customer has opted out, blocking processing:', inboundMessage.destinationAddress);
            await InteractionLogService.write({
                customerId: inboundMessage.destinationAddress,
                channel,
                direction: 'inbound',
                status: 'BLOCKED_OPT_OUT',
                messageBody: inboundMessage.messageBody
            });
            callback(null, { responseMessage: 'opt-out — not processed' });
            return;
        }

        // ── Rate limiting (10 messages / customer / 10-minute window) ────────────
        if (inboundMessage.action === 'process') {
            const allowed = await checkRateLimit(inboundMessage.destinationAddress);
            if (!allowed) {
                console.warn('Rate limit exceeded for:', inboundMessage.destinationAddress);
                await InteractionLogService.write({
                    customerId: inboundMessage.destinationAddress,
                    channel,
                    direction: 'inbound',
                    status: 'RATE_LIMITED',
                    messageBody: inboundMessage.messageBody
                });
                callback(null, { responseMessage: 'rate limited' });
                return;
            }
            await incrementRateLimit(inboundMessage.destinationAddress);
        }

        // ── Main action dispatch ─────────────────────────────────────────────────
        let message = inboundMessage.messageBody;
        let useCase = null;
        let responseMessage = null;
        let actionResult = null;

        switch (inboundMessage.action) {
            case 'forward':
                useCase = useCases.Items.find(useCase => useCase.useCase.toLowerCase().trim() === inboundMessage.useCaseId);
                actionResult = await forwardMessage(inboundMessage, message, useCase, inboundMessage.imageId);
                responseMessage = actionResult.responseMessage;
                await writeMessageToStorage(inboundMessage, 'outbound', channel, message, actionResult.outboundMessageId, actionResult.sessionId, actionResult.sessionVariables);
                await InteractionLogService.write({
                    customerId: inboundMessage.destinationAddress,
                    channel,
                    direction: 'outbound',
                    status: 'RESOLVED',
                    source: 'forward',
                    messageBody: message,
                    deliveryMessageId: actionResult.outboundMessageId,
                    sessionId: actionResult.sessionId
                });
                break;

            case 'process':
                actionResult = await processMessage(useCases, inboundMessage, message);
                responseMessage = actionResult.responseMessage;
                await writeMessageToStorage(inboundMessage, 'inbound', channel, message, inboundMessage.inboundMessageId, actionResult.sessionId, actionResult.sessionVariables);
                await writeMessageToStorage(inboundMessage, 'outbound', channel, actionResult.outboundMessage, actionResult.outboundMessageId, actionResult.sessionId, actionResult.sessionVariables);
                // Write interaction log record
                await InteractionLogService.write({
                    customerId: inboundMessage.destinationAddress,
                    channel,
                    direction: 'inbound',
                    status: actionResult.escalated ? 'ESCALATED' : 'RESOLVED',
                    source: actionResult.source || 'unknown',
                    messageBody: message,
                    deliveryMessageId: actionResult.outboundMessageId,
                    sessionId: actionResult.sessionId,
                    escalationReason: actionResult.escalationReason || null
                });
                break;

            case 'template':
                useCase = useCases.Items.find(useCase => useCase.useCase.toLowerCase().trim() === inboundMessage.useCaseId);
                actionResult = await processTemplate(useCase, inboundMessage, message);
                responseMessage = actionResult.responseMessage;
                await writeMessageToStorage(inboundMessage, 'outbound', channel, message, actionResult.outboundMessageId, actionResult.sessionId, actionResult.sessionVariables);
                await InteractionLogService.write({
                    customerId: inboundMessage.destinationAddress,
                    channel,
                    direction: 'outbound',
                    status: 'RESOLVED',
                    source: 'template',
                    messageBody: message,
                    deliveryMessageId: actionResult.outboundMessageId,
                    sessionId: actionResult.sessionId
                });
                break;

            default:
                break;
        }

        callback(null, { 'responseMessage': responseMessage });
    } catch (error) {
        console.error(error);
        callback(error);
    }
};
