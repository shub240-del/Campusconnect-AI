// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0
//
// PATCH v4.0.0 — SmallBiz AI Support Hub
//   • Fixed shadow variable declaration bug: inner `let pinpointResponse` on lines 12 & 15
//     created new block-scoped variables never read by callback, causing undefined messageId.
//     Fixed by assigning to the outer-scope `pinpointResponse` variable.
//   • Standardized to ESM imports/exports.

import * as PinpointService from '../services/PinpointService.mjs';

export const handler = async (event, _context, callback) => {
    try {
        console.info("App Version:", process.env.APPLICATION_VERSION);
        console.trace(`Event: `, JSON.stringify(event, null, 2));

        const recipient = event.recipient;
        let pinpointResponse = null;

        if (event.imageId) {
            pinpointResponse = await PinpointService.sendMMS(recipient.destinationAddress, event.imageId, event.outboundMessage);
            callback(null, { messageId: pinpointResponse?.MessageId });
        } else {
            pinpointResponse = await PinpointService.sendSMS(recipient.destinationAddress, event.outboundMessage);
            callback(null, { messageId: pinpointResponse?.MessageId });
        }
    } catch (error) {
        console.error('smsProcessor error:', error);
        callback(error);
    }
};

export default { handler };