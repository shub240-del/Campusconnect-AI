// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { checkOptOut, recordOptOut } from '../optOutManager.mjs';

describe('optOutManager module', () => {
    test('records opt-out and blocks future communications', async () => {
        const phone = '+447700900050';
        expect(await checkOptOut(phone)).toBe(false);

        await recordOptOut(phone, true);
        expect(await checkOptOut(phone)).toBe(true);

        // Can opt back in with START
        await recordOptOut(phone, false);
        expect(await checkOptOut(phone)).toBe(false);
    });
});
