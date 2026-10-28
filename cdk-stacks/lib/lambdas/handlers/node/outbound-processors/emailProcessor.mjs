// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0
//
// PATCH v4.0.0 — SmallBiz AI Support Hub
//   • Critical fix: was sending recipient.messageBody (user's original prompt) instead
//     of event.outboundMessage (the AI-generated answer). All AI responses were discarded.
//   • Added fallback fromAddress from SES_FROM_ADDRESS env var
//   • Added fallback subject so SES never receives undefined Subject
//   • Standardized to ESM export syntax

import { sendEmail } from '../services/SESService.mjs';

export const handler = async (event, _context, callback) => {
    try {
        console.info("App Version:", process.env.APPLICATION_VERSION);
        console.trace(`Event: `, JSON.stringify(event, null, 2));

        const recipient = event.recipient;

        // PATCH: send the AI-generated answer (outboundMessage), not the raw user query
        const bodyToSend = event.outboundMessage || recipient.messageBody;

        // PATCH: provide fallback fromAddress and subject so SES API never sees undefined
        const fromAddress = recipient.fromAddress || process.env.SES_FROM_ADDRESS || 'support@smallbiz.local';
        const subject = recipient.subject || '[SmallBiz Support] Your Enquiry Response';

        const emailResponse = await sendEmail(
            recipient.destinationAddress,
            subject,
            bodyToSend,
            fromAddress,
            recipient.configurationSet || null
        );
        callback(null, { messageId: emailResponse?.MessageId });
        
    } catch (error) {
        console.error('emailProcessor error:', error);
        callback(error);
    }
};

export default { handler };