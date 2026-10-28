// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { handler } from '../emailProcessor.mjs';

jest.mock('../../services/SESService.mjs', () => ({
    sendEmail: jest.fn().mockResolvedValue({ MessageId: 'msg-ses-12345' })
}));

describe('emailProcessor handler', () => {
    test('sends event.outboundMessage with correct parameters', (done) => {
        const event = {
            recipient: {
                destinationAddress: 'customer@example.com',
                subject: 'Your Support Ticket Response',
                fromAddress: 'support@smallbiz.local'
            },
            outboundMessage: 'Your order ORD-7781 has been dispatched.'
        };

        handler(event, {}, (err, result) => {
            expect(err).toBeNull();
            expect(result.messageId).toBe('msg-ses-12345');
            done();
        });
    });
});
