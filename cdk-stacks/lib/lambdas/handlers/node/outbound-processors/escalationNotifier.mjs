// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0
//
// escalationNotifier.mjs — Human escalation notifier Lambda handler
//
// Called by supportResponseGenerator when escalation flag is set.
// Responsibilities:
//   1. Sends SES email alert to operator with full conversation thread
//   2. Writes ESCALATED record to InteractionLog DynamoDB table
//   3. Returns confirmation so chatOrchestrator can log delivery outcome
//
// This Lambda is invoked synchronously by supportResponseGenerator via LambdaService.

import { SESv2Client, SendEmailCommand } from "@aws-sdk/client-sesv2";
import { InteractionLogService } from '../services/InteractionLogService.mjs';

const ses = new SESv2Client({ region: process.env.AWS_REGION });

/**
 * Format a conversation thread for inclusion in the operator email.
 */
const formatThread = (conversation) => {
    if (!conversation || conversation.length === 0) return '(No previous messages in session)';
    return conversation
        .sort((a, b) => a.timestamp - b.timestamp)
        .map(msg => {
            const ts = new Date(msg.timestamp).toISOString();
            const dir = msg.direction === 'inbound' ? '👤 Customer' : '🤖 AI';
            return `[${ts}] ${dir}: ${msg.message || '(no text)'}`;
        })
        .join('\n');
};

export const handler = async (event, _context, callback) => {
    try {
        console.info("escalationNotifier invoked");
        console.trace('Event:', JSON.stringify(event, null, 2));

        const {
            customerId,
            channel,
            inboundMessage,
            escalationReason,
            conversation,
            sessionId,
            interactionId
        } = event;

        const operatorEmail = process.env.OPERATOR_EMAIL_ADDRESS;
        const fromAddress = process.env.SES_FROM_ADDRESS;

        if (!operatorEmail || !fromAddress) {
            console.warn('escalationNotifier: OPERATOR_EMAIL_ADDRESS or SES_FROM_ADDRESS not set — skipping email alert');
        } else {
            const subject = `[SmallBiz Support] Escalation Required — ${channel?.toUpperCase()} — ${new Date().toUTCString()}`;
            const thread = formatThread(conversation);
            const bodyText = [
                '=== SmallBiz AI Support Hub — ESCALATION ALERT ===',
                '',
                `Customer Channel: ${channel}`,
                `Escalation Reason: ${escalationReason || 'Low-confidence AI answer or sensitive keyword detected'}`,
                `Session ID: ${sessionId || 'N/A'}`,
                `Interaction ID: ${interactionId || 'N/A'}`,
                `Time: ${new Date().toISOString()}`,
                '',
                '--- Customer Message ---',
                inboundMessage || '(no message)',
                '',
                '--- Conversation Thread ---',
                thread,
                '',
                '=== Action Required ===',
                'Please open the operator dashboard to reply or resolve this ticket.',
                process.env.DASHBOARD_URL ? `Dashboard: ${process.env.DASHBOARD_URL}` : '(DASHBOARD_URL not configured)',
                '',
                'This is an automated alert from SmallBiz AI Support Hub.'
            ].join('\n');

            const emailCommand = new SendEmailCommand({
                FromEmailAddress: fromAddress,
                Destination: { ToAddresses: [operatorEmail] },
                Content: {
                    Simple: {
                        Subject: { Data: subject, Charset: 'UTF-8' },
                        Body: { Text: { Data: bodyText, Charset: 'UTF-8' } }
                    }
                }
            });

            const emailResult = await ses.send(emailCommand);
            console.info('escalationNotifier: operator email sent. MessageId:', emailResult.MessageId);
        }

        // Write escalation record to InteractionLog
        await InteractionLogService.write({
            interactionId: interactionId,
            customerId: customerId,
            channel: channel,
            direction: 'inbound',
            status: 'ESCALATED',
            source: 'escalationNotifier',
            messageBody: inboundMessage,
            sessionId: sessionId,
            escalationReason: escalationReason
        });

        callback(null, { escalated: true, notified: !!operatorEmail });

    } catch (error) {
        console.error('escalationNotifier error:', error);
        // Do not block the customer flow if escalation notification fails
        // InteractionLog write failure is already silenced inside InteractionLogService
        callback(null, { escalated: true, notified: false, error: error.message });
    }
};
