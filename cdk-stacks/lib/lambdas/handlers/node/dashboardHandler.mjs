// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0
//
// dashboardHandler.mjs — Operator Dashboard REST API handler
//
// Endpoints supported (via API Gateway HTTP API):
//   GET  /api/interactions         — List recent interactions (supports ?status= filter)
//   GET  /api/interaction/{id}     — Get full interaction thread + customer context
//   POST /api/interaction/{id}/reply — Operator sends manual reply to customer via channel
//   PUT  /api/interaction/{id}/resolve — Mark ticket resolved
//   GET  /api/stats               — Live count of total, open, escalated, resolved tickets
//   GET  /api/orders              — Search/view BusinessOrders data

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, ScanCommand, GetCommand, PutCommand, QueryCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { LambdaClient, InvokeCommand } from "@aws-sdk/client-lambda";
import { randomUUID } from "crypto";

const ddbClient = new DynamoDBClient({ region: process.env.AWS_REGION || "us-east-1" });
const docClient = DynamoDBDocumentClient.from(ddbClient, { marshallOptions: { removeUndefinedValues: true } });
const lambdaClient = new LambdaClient({ region: process.env.AWS_REGION || "us-east-1" });

const INTERACTION_LOG_TABLE = process.env.INTERACTION_LOG_TABLE || "InteractionLog";
const BUSINESS_ORDERS_TABLE = process.env.BUSINESS_ORDERS_TABLE || "BusinessOrders";
const WHATSAPP_PROCESSOR = process.env.WHATSAPP_PROCESSOR_LAMBDA;
const SMS_PROCESSOR = process.env.SMS_PROCESSOR_LAMBDA;
const EMAIL_PROCESSOR = process.env.EMAIL_PROCESSOR_LAMBDA;

const corsHeaders = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, PUT, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Api-Key"
};

const sendResponse = (statusCode, data) => ({
    statusCode,
    headers: corsHeaders,
    body: JSON.stringify(data)
});

export const handler = async (event) => {
    console.info("dashboardHandler invoked:", event.requestContext?.http?.method, event.rawPath || event.path);

    const method = event.requestContext?.http?.method || event.httpMethod;
    const rawPath = event.rawPath || event.path || "";

    if (method === "OPTIONS") {
        return sendResponse(200, { ok: true });
    }

    try {
        // GET /api/stats
        if (method === "GET" && (rawPath === "/api/stats" || rawPath === "/stats")) {
            return await getStats();
        }

        // GET /api/interactions
        if (method === "GET" && (rawPath === "/api/interactions" || rawPath === "/interactions")) {
            const statusFilter = event.queryStringParameters?.status;
            return await listInteractions(statusFilter);
        }

        // GET /api/interaction/{id}
        if (method === "GET" && rawPath.match(/^\/api\/interaction\/[^/]+$/)) {
            const id = rawPath.split("/").pop();
            return await getInteraction(id);
        }

        // POST /api/interaction/{id}/reply
        if (method === "POST" && rawPath.match(/^\/api\/interaction\/[^/]+\/reply$/)) {
            const parts = rawPath.split("/");
            const id = parts[parts.length - 2];
            const body = JSON.parse(event.body || "{}");
            return await replyToCustomer(id, body);
        }

        // PUT /api/interaction/{id}/resolve
        if (method === "PUT" && rawPath.match(/^\/api\/interaction\/[^/]+\/resolve$/)) {
            const parts = rawPath.split("/");
            const id = parts[parts.length - 2];
            const body = JSON.parse(event.body || "{}");
            return await resolveInteraction(id, body);
        }

        // GET /api/orders
        if (method === "GET" && (rawPath === "/api/orders" || rawPath === "/orders")) {
            return await listOrders();
        }

        return sendResponse(404, { error: "Route not found", path: rawPath, method });

    } catch (err) {
        console.error("dashboardHandler error:", err);
        return sendResponse(500, { error: err.message || "Internal server error" });
    }
};

async function getStats() {
    try {
        const scanRes = await docClient.send(new ScanCommand({
            TableName: INTERACTION_LOG_TABLE,
            Limit: 500
        }));

        const items = scanRes.Items || [];
        const stats = {
            total: items.length,
            open: items.filter(i => i.status === "ESCALATED" || i.status === "PENDING").length,
            escalated: items.filter(i => i.status === "ESCALATED").length,
            resolved: items.filter(i => i.status === "RESOLVED" || i.status === "REPLIED").length,
            rateLimited: items.filter(i => i.status === "RATE_LIMITED").length,
            optOuts: items.filter(i => i.status === "OPT_OUT").length
        };
        return sendResponse(200, stats);
    } catch (e) {
        console.warn("Could not query InteractionLog table for stats:", e.message);
        return sendResponse(200, { total: 0, open: 0, escalated: 0, resolved: 0, rateLimited: 0, optOuts: 0 });
    }
}

async function listInteractions(statusFilter) {
    try {
        const scanRes = await docClient.send(new ScanCommand({
            TableName: INTERACTION_LOG_TABLE,
            Limit: 100
        }));

        let items = scanRes.Items || [];

        if (statusFilter && statusFilter !== "ALL") {
            items = items.filter(i => i.status?.toUpperCase() === statusFilter.toUpperCase());
        }

        // Sort latest first
        items.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));

        return sendResponse(200, { count: items.length, interactions: items });
    } catch (e) {
        console.warn("Could not scan InteractionLog table:", e.message);
        return sendResponse(200, { count: 0, interactions: [] });
    }
}

async function getInteraction(id) {
    try {
        // Query by interactionId
        const queryRes = await docClient.send(new QueryCommand({
            TableName: INTERACTION_LOG_TABLE,
            KeyConditionExpression: "interactionId = :iid",
            ExpressionAttributeValues: { ":iid": id }
        }));

        if (!queryRes.Items || queryRes.Items.length === 0) {
            return sendResponse(404, { error: `Interaction ${id} not found` });
        }

        const events = queryRes.Items.sort((a, b) => a.timestamp - b.timestamp);
        const primary = events[0];

        return sendResponse(200, {
            interactionId: id,
            customerId: primary.customerId,
            channel: primary.channel,
            status: events[events.length - 1].status,
            escalationReason: primary.escalationReason,
            createdAt: primary.timestamp,
            events: events
        });
    } catch (e) {
        console.error("Error retrieving interaction:", e);
        return sendResponse(500, { error: e.message });
    }
}

async function replyToCustomer(interactionId, body) {
    const { message, channel, destinationAddress, operatorId = "operator-1" } = body;
    if (!message) {
        return sendResponse(400, { error: "Message is required" });
    }

    let outboundLambda = WHATSAPP_PROCESSOR;
    if (channel === "sms") outboundLambda = SMS_PROCESSOR;
    if (channel === "email") outboundLambda = EMAIL_PROCESSOR;

    let deliveryMessageId = null;

    if (outboundLambda) {
        try {
            const invokeRes = await lambdaClient.send(new InvokeCommand({
                FunctionName: outboundLambda,
                InvocationType: "RequestResponse",
                Payload: JSON.stringify({
                    recipient: {
                        destinationAddress,
                        channel,
                        action: "forward"
                    },
                    outboundMessage: message
                })
            }));
            const resPayload = JSON.parse(Buffer.from(invokeRes.Payload).toString());
            deliveryMessageId = resPayload.messageId || randomUUID();
        } catch (sendErr) {
            console.error("Error sending outbound message:", sendErr);
        }
    }

    // Write reply to InteractionLog
    const timestamp = Date.now();
    await docClient.send(new PutCommand({
        TableName: INTERACTION_LOG_TABLE,
        Item: {
            interactionId,
            timestamp,
            customerId: destinationAddress || "customer",
            channel: channel || "whatsapp",
            direction: "outbound",
            status: "REPLIED",
            source: "Operator",
            operatorId,
            messageBody: message,
            deliveryMessageId: deliveryMessageId || randomUUID()
        }
    }));

    return sendResponse(200, {
        success: true,
        interactionId,
        status: "REPLIED",
        deliveryMessageId
    });
}

async function resolveInteraction(interactionId, body) {
    const { operatorId = "operator-1", note = "Resolved by operator" } = body;
    const timestamp = Date.now();

    await docClient.send(new PutCommand({
        TableName: INTERACTION_LOG_TABLE,
        Item: {
            interactionId,
            timestamp,
            direction: "internal",
            status: "RESOLVED",
            source: "Operator",
            operatorId,
            messageBody: note
        }
    }));

    return sendResponse(200, {
        success: true,
        interactionId,
        status: "RESOLVED",
        resolvedAt: timestamp
    });
}

async function listOrders() {
    try {
        const scanRes = await docClient.send(new ScanCommand({
            TableName: BUSINESS_ORDERS_TABLE,
            Limit: 50
        }));
        return sendResponse(200, { count: scanRes.Items?.length || 0, orders: scanRes.Items || [] });
    } catch (e) {
        return sendResponse(200, { count: 0, orders: [] });
    }
}
