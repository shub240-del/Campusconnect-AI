// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0
//
// supportResponseGenerator.mjs — Core AI response generator for SmallBiz AI Support Hub
//
// Processing pipeline per customer message:
//   1. Retrieve answer from Bedrock Knowledge Base (product FAQs, return policy, shipping policy)
//   2. Confidence gate: if KB returns 0 citations → low confidence → escalate
//   3. Keyword check: escalation trigger words (refund, complaint, fraud, etc.) → escalate
//   4. Order lookup: if message contains order reference → query BusinessOrders via AgentCore
//   5. Merge KB answer + order status into final response
//   6. If escalation flagged: send holding message + invoke escalationNotifier
//
// Returns: { response, escalated, escalationReason, source }

import { BedrockAgentRuntimeClient, RetrieveAndGenerateCommand } from "@aws-sdk/client-bedrock-agent-runtime";
import { LambdaClient, InvokeCommand } from "@aws-sdk/client-lambda";
import { randomUUID } from 'crypto';
import xss from 'xss';

const bedrockClient = new BedrockAgentRuntimeClient({ region: process.env.AWS_REGION });
const lambdaClient = new LambdaClient({ region: process.env.AWS_REGION });

// Configurable escalation trigger keywords (can be extended via env var)
const DEFAULT_ESCALATION_KEYWORDS = ['refund', 'damaged', 'broken', 'legal', 'complaint', 'fraud', 'scam', 'urgent', 'lawsuit', 'stolen', 'missing order'];
const escalationKeywords = process.env.ESCALATION_KEYWORDS
    ? process.env.ESCALATION_KEYWORDS.split(',').map(k => k.trim().toLowerCase())
    : DEFAULT_ESCALATION_KEYWORDS;

// Holding message sent to customer while escalation is being processed
const HOLDING_MESSAGE = "Thank you for reaching out. I'm connecting you with a member of our support team who will be in touch shortly. We apologise for any inconvenience.";

/**
 * Check if a message body contains any escalation trigger keywords.
 */
const containsEscalationKeyword = (text) => {
    const lower = (text || '').toLowerCase();
    return escalationKeywords.find(kw => lower.includes(kw)) || null;
};

/**
 * Check if the message appears to reference an order (e.g. "ORD-1234", "order #5678").
 */
const extractOrderId = (text) => {
    // Match: ORD-1234, ORDER-1234, #1234, order 1234 (case insensitive)
    const patterns = [
        /\b(ORD-\d{3,})\b/i,
        /\b(ORDER[- #]+\d{3,})\b/i,
        /order\s+#?(\d{4,})/i
    ];
    for (const pattern of patterns) {
        const match = (text || '').match(pattern);
        if (match) return match[1].toUpperCase().replace(/\s+/g, '').replace('ORDER', 'ORD-');
    }
    return null;
};

/**
 * Look up an order using the AgentCore Runtime or inline Lambda fallback.
 * Returns a plain-text status string or null if order not found.
 */
const lookupOrder = async (orderId, sessionVariables) => {
    const agentCoreRuntimeArn = process.env.AGENTCORE_RUNTIME_ARN;
    const orderLookupLambdaName = process.env.ORDER_LOOKUP_LAMBDA_NAME;

    if (agentCoreRuntimeArn) {
        // Preferred path: AgentCore Runtime
        try {
            const { BedrockAgentCoreRuntimeClient, InvokeAgentRuntimeCommand } = await import("@aws-sdk/client-bedrock-agentcore");
            const agentCoreClient = new BedrockAgentCoreRuntimeClient({ region: process.env.AWS_REGION });
            const response = await agentCoreClient.send(new InvokeAgentRuntimeCommand({
                agentRuntimeArn: agentCoreRuntimeArn,
                sessionId: sessionVariables?.sessionId || randomUUID(),
                inputText: `lookup_order_status orderId=${orderId}`
            }));
            const completion = response.completion?.text || '';
            return completion || null;
        } catch (error) {
            console.warn('AgentCore order lookup failed, attempting Lambda fallback:', error.message);
        }
    }

    if (orderLookupLambdaName) {
        // Fallback path: direct Lambda invocation
        try {
            const res = await lambdaClient.send(new InvokeCommand({
                FunctionName: orderLookupLambdaName,
                InvocationType: 'RequestResponse',
                Payload: JSON.stringify({ orderId })
            }));
            const payload = JSON.parse(Buffer.from(res.Payload).toString());
            return payload?.statusText || null;
        } catch (error) {
            console.error('Order lookup Lambda fallback error:', error.message);
        }
    }

    return null;
};

/**
 * Retrieve and generate a KB-grounded answer using Bedrock Knowledge Base.
 * Returns { answer, citations } where citations is an array of source references.
 */
const retrieveFromKnowledgeBase = async (query, sessionId) => {
    const knowledgeBaseId = process.env.KNOWLEDGE_BASE_ID;
    const modelArn = process.env.BEDROCK_MODEL_ARN || `arn:aws:bedrock:${process.env.AWS_REGION}::foundation-model/amazon.nova-lite-v1:0`;

    if (!knowledgeBaseId) {
        console.warn('KNOWLEDGE_BASE_ID not set — KB retrieval skipped');
        return { answer: null, citations: [] };
    }

    const input = {
        input: { text: query },
        retrieveAndGenerateConfiguration: {
            type: 'KNOWLEDGE_BASE',
            knowledgeBaseConfiguration: {
                knowledgeBaseId,
                modelArn,
                generationConfiguration: {
                    promptTemplate: {
                        textPromptTemplate: [
                            'You are a helpful customer support assistant for SmallBiz, an online shop.',
                            'Answer ONLY based on the retrieved context provided below.',
                            'If the context does not contain enough information to answer, say "I need to connect you with our support team."',
                            'Never fabricate order details, prices, or policies not present in the context.',
                            'Keep responses concise (under 3 sentences) and friendly.',
                            '',
                            '$search_results$',
                            '',
                            'Customer Question: $query$'
                        ].join('\n')
                    }
                }
            }
        }
    };

    if (sessionId) input.sessionId = sessionId;

    try {
        const result = await bedrockClient.send(new RetrieveAndGenerateCommand(input));
        const answer = result.output?.text || null;
        const citations = result.citations || [];
        return { answer, citations, newSessionId: result.sessionId };
    } catch (error) {
        if (error.name === 'ThrottlingException') {
            console.warn('KB ThrottlingException — returning throttle message');
            return { answer: 'Our support service is currently experiencing high demand. Please try again in a moment.', citations: [], throttled: true };
        }
        console.error('retrieveFromKnowledgeBase error:', error);
        return { answer: null, citations: [] };
    }
};

/**
 * Main Lambda handler — supportResponseGenerator
 */
export const handler = async (event, _context, callback) => {
    try {
        console.info("supportResponseGenerator invoked");
        console.trace('Event:', JSON.stringify(event, null, 2));

        const { useCase, recipient, conversation, sessionVariables } = event;
        const query = xss(recipient?.messageBody || '');
        const sessionId = sessionVariables?.sessionId;

        // ── Step 1: Escalation keyword check (fast path) ──────────────────────
        const triggerKeyword = containsEscalationKeyword(query);
        if (triggerKeyword) {
            console.info(`supportResponseGenerator: escalation keyword detected: "${triggerKeyword}"`);
            return callback(null, {
                response: HOLDING_MESSAGE,
                escalated: true,
                escalationReason: `Escalation keyword: "${triggerKeyword}"`,
                source: 'keyword_escalation'
            });
        }

        // ── Step 2: Knowledge Base retrieval ──────────────────────────────────
        const { answer: kbAnswer, citations, newSessionId, throttled } = await retrieveFromKnowledgeBase(query, sessionId);

        // Persist new KB session ID for multi-turn continuity
        if (newSessionId && sessionVariables) {
            sessionVariables.llmSessionId = newSessionId;
        }

        // ── Step 3: Confidence gate ────────────────────────────────────────────
        // KB returned no citations → answer is not grounded → escalate
        if (!throttled && (!kbAnswer || citations.length === 0)) {
            console.info('supportResponseGenerator: KB returned 0 citations — escalating');
            return callback(null, {
                response: HOLDING_MESSAGE,
                escalated: true,
                escalationReason: 'Knowledge base returned no grounded citations',
                source: 'low_confidence_escalation'
            });
        }

        // ── Step 4: Order lookup (if order ID present in query) ────────────────
        const orderId = extractOrderId(query);
        let orderStatusText = null;
        let source = 'KB';

        if (orderId) {
            console.info(`supportResponseGenerator: order ID detected: ${orderId}`);
            orderStatusText = await lookupOrder(orderId, sessionVariables);
            if (orderStatusText === null) {
                // Order not found in DB — do not fabricate; escalate instead
                console.info(`supportResponseGenerator: order ${orderId} not found — escalating`);
                return callback(null, {
                    response: HOLDING_MESSAGE,
                    escalated: true,
                    escalationReason: `Order ID ${orderId} not found in order database`,
                    source: 'order_not_found_escalation'
                });
            }
            source = 'KB+AgentCore';
        }

        // ── Step 5: Build final response ───────────────────────────────────────
        let finalResponse = kbAnswer || '';
        if (orderStatusText) {
            // Append order status below KB answer (KB may have answered a general question + order detail)
            finalResponse = `${finalResponse}\n\n📦 Order ${orderId}: ${orderStatusText}`.trim();
        }

        // Safety check: never return an empty response
        if (!finalResponse || finalResponse.trim().length === 0) {
            return callback(null, {
                response: HOLDING_MESSAGE,
                escalated: true,
                escalationReason: 'Empty response from knowledge base',
                source: 'empty_response_escalation'
            });
        }

        console.info(`supportResponseGenerator: resolved. source=${source}, citations=${citations.length}`);
        return callback(null, {
            response: finalResponse,
            escalated: false,
            source,
            sessionVariables // Return updated sessionVariables with new KB sessionId
        });

    } catch (error) {
        console.error('supportResponseGenerator error:', error);
        // On unhandled error, escalate gracefully — do not return a fabricated answer
        callback(null, {
            response: HOLDING_MESSAGE,
            escalated: true,
            escalationReason: `Internal error: ${error.message}`,
            source: 'error_escalation'
        });
    }
};
