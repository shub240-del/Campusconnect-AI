// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import * as LambdaService from '../services/LambdaService.mjs';

export const handler = async (event, _context, callback) => {
    try {
        console.info("App Version:", process.env.APPLICATION_VERSION);
        console.trace(`Event: `, JSON.stringify(event, null, 2));

        for (const record of event.Records) {
            console.trace(`Record: `, record);
            const snsMessage = JSON.parse(record.Sns.Message);
            console.trace(`Message: `, snsMessage);

            const inboundMessage = {};
            const whatsappMessage = JSON.parse(snsMessage.whatsAppWebhookEntry);
            const msgEntry = whatsappMessage.changes?.[0]?.value?.messages?.[0];

            try {
                if (msgEntry?.text?.body || msgEntry?.image) {
                    inboundMessage.destinationAddress = '+' + msgEntry.from;
                    inboundMessage.serviceAddress = '+' + whatsappMessage.changes[0].value.metadata.display_phone_number;
                    inboundMessage.inboundMessageId = msgEntry.id;
                    inboundMessage.previousPublishedMessageId = msgEntry.id;
                    inboundMessage.senderName = whatsappMessage.changes[0]?.value?.contacts?.[0]?.profile?.name || 'Customer';
                    inboundMessage.action = 'process';
                    inboundMessage.replyExpected = true;
                    inboundMessage.channel = 'whatsapp';

                    if (msgEntry.text?.body) {
                        inboundMessage.messageBody = msgEntry.text.body;
                    } else if (msgEntry.image) {
                        // Pass through image ID for multimodal/escalation handling
                        inboundMessage.mediaId = msgEntry.image.id;
                        inboundMessage.messageBody = msgEntry.image.caption || '[Customer sent an image]';
                    }

                    console.trace('Inbound Message: ', JSON.stringify(inboundMessage, null, 2));

                    // Execute the Chat Orchestrator Lambda
                    const response = await LambdaService.invoke(process.env.CHAT_ORCHESTRATOR_LAMBDA_NAME, { inboundMessage });
                    console.trace('Response: ', JSON.stringify(response, null, 2));

                } else {
                    console.warn('No supported message found in WhatsApp webhook payload.');
                }
            } catch (error) {
                console.error('Error processing WhatsApp message record:', error);
            }
        }

        callback(null, 'Success');
    } catch (error) {
        console.error('whatsappTrigger error:', error);
        callback(error);
    }
};

export default { handler };