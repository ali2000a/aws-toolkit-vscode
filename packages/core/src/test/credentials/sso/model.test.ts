/*!
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'assert'
import { openSsoPortalLink } from '../../../auth/sso/model'
import { assertTelemetry } from '../../testUtil'
import { getOpenExternalStub } from '../../globalSetup.test'

describe('openSsoPortalLink', function () {
    const verificationUri = 'https://example.com/'

    it('opens a link', async function () {
        getOpenExternalStub().resolves(true)
        await openSsoPortalLink(verificationUri)
        assert.ok(getOpenExternalStub().calledOnce)
        assert.strictEqual(getOpenExternalStub().args[0].toString(), `${verificationUri}`)
        assertTelemetry('aws_loginWithBrowser', { result: 'Succeeded' })
    })

    it('canceled opening a link', async function () {
        getOpenExternalStub().resolves(false)
        await assert.rejects(async () => {
            await openSsoPortalLink(verificationUri)
        })
        assert.ok(getOpenExternalStub().calledOnce)
        assert.strictEqual(getOpenExternalStub().args[0].toString(), `${verificationUri}`)
        assertTelemetry('aws_loginWithBrowser', { result: 'Failed' })
    })
})
