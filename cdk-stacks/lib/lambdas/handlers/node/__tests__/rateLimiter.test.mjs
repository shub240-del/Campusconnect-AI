// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { checkRateLimit, incrementRateLimit } from '../rateLimiter.mjs';

describe('rateLimiter module', () => {
    const originalEnv = process.env;

    beforeEach(() => {
        process.env = { ...originalEnv };
        delete process.env.RATE_LIMIT_TABLE;
    });

    afterAll(() => {
        process.env = originalEnv;
    });

    test('allows requests when under limit in memory', async () => {
        const customer = '+447700900001';
        for (let i = 0; i < 9; i++) {
            const allowed = await checkRateLimit(customer);
            expect(allowed).toBe(true);
            await incrementRateLimit(customer);
        }
        // 10th request is allowed
        expect(await checkRateLimit(customer)).toBe(true);
        await incrementRateLimit(customer);

        // 11th request is blocked
        const blocked = await checkRateLimit(customer);
        expect(blocked).toBe(false);
    });

    test('separate customers have independent rate counters', async () => {
        const customerA = '+447700900002';
        const customerB = '+447700900003';

        for (let i = 0; i < 10; i++) {
            await incrementRateLimit(customerA);
        }

        expect(await checkRateLimit(customerA)).toBe(false);
        expect(await checkRateLimit(customerB)).toBe(true);
    });
});
