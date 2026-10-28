// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { handler } from '../supportResponseGenerator.mjs';

describe('supportResponseGenerator handler', () => {
    test('escalates immediately when escalation keyword is present', (done) => {
        const event = {
            recipient: {
                messageBody: 'I received a damaged item and I want a refund now!'
            },
            sessionVariables: { sessionId: 'test-session-1' }
        };

        handler(event, {}, (err, result) => {
            expect(err).toBeNull();
            expect(result.escalated).toBe(true);
            expect(result.source).toBe('keyword_escalation');
            expect(result.response).toContain('connecting you with a member of our support team');
            done();
        });
    });

    test('escalates gracefully when KB is unavailable or returns 0 citations', (done) => {
        const event = {
            recipient: {
                messageBody: 'Do you sell spaceships?'
            },
            sessionVariables: { sessionId: 'test-session-2' }
        };

        handler(event, {}, (err, result) => {
            expect(err).toBeNull();
            expect(result.escalated).toBe(true);
            expect(result.response).toContain('connecting you with a member of our support team');
            done();
        });
    });
});
