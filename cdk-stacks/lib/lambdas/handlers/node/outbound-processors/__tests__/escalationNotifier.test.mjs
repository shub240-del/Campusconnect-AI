// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { handler } from '../escalationNotifier.mjs';

describe('escalationNotifier handler', () => {
    test('executes escalation handling gracefully without throwing', (done) => {
        const event = {
            customerId: '+447700900010',
            channel: 'whatsapp',
            inboundMessage: 'Where is my refund for order ORD-5519?',
            escalationReason: 'Keyword match: refund',
            conversation: [
                { timestamp: 1761900000000, direction: 'inbound', message: 'Hello' },
                { timestamp: 1761900010000, direction: 'outbound', message: 'Hi there' },
            ],
            sessionId: 'test-session-esc-1',
            interactionId: 'interaction-esc-1'
        };

        handler(event, {}, (err, result) => {
            expect(err).toBeNull();
            expect(result.escalated).toBe(true);
            done();
        });
    });
});
