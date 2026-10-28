// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import * as LambdaService from '../services/LambdaService.mjs';

export const handler = async (event, _context, callback) => {
    try {
        console.info('App Version: ', process.env.APPLICATION_VERSION);
        console.trace('Event: ', JSON.stringify(event, null, 2));

        for (const record of event.Records) {
            console.trace('Record: ', JSON.stringify(record, null, 2));

            const snsMessage = JSON.parse(record.Sns.Message);

            const inboundMessage = {
                originationNumber: snsMessage.originationNumber,
                destinationNumber: snsMessage.destinationNumber,
                messageKeyword: snsMessage.messageKeyword,
                messageBody: snsMessage.messageBody,
                inboundMessageId: snsMessage.inboundMessageId,
                previousPublishedMessageId: snsMessage.previousPublishedMessageId,
                action: 'process',
                replyExpected: true,
                channel: 'rcs',
                destinationAddress: snsMessage.originationNumber,
                serviceAddress: snsMessage.destinationNumber
            };

            console.trace('Inbound Message: ', JSON.stringify(inboundMessage, null, 2));

            // Execute the Chat Orchestrator Lambda
            const response = await LambdaService.invoke(process.env.CHAT_ORCHESTRATOR_LAMBDA_NAME, { inboundMessage });
            console.trace('Response: ', JSON.stringify(response, null, 2));
        }

        callback(null, 'Success');
    } catch (error) {
        console.error('rcsTrigger error:', error);
        callback(error);
    }
};

export default { handler };
