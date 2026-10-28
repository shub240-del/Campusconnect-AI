// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import * as PinpointService from '../services/PinpointService.mjs';

export const handler = async (event, _context, callback) => {
    try {
        console.info("App Version:", process.env.APPLICATION_VERSION);
        console.trace(`Event: `, JSON.stringify(event, null, 2));

        const recipient = event.recipient;

        // Phase 1: plain text RCS only. Rich content (cards, carousels,
        // suggestions) will be added in Phase 2 via SendRcsMessage.
        const pinpointResponse = await PinpointService.sendRCS(recipient.destinationAddress, event.outboundMessage);
        callback(null, { messageId: pinpointResponse?.MessageId });
    } catch (error) {
        console.error('rcsProcessor error:', error);
        callback(error);
    }
};

export default { handler };
