/*!
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'assert'
import {
    AuthError,
    AuthSSOServer,
    InvalidStateError,
    MissingCodeError,
    MissingStateError,
} from '../../../auth/sso/server'
import request from '../../../common/request'
import { URLSearchParams } from 'url'
import { ToolkitError } from '../../../shared/errors'

describe('AuthSSOServer', function () {
    const code = 'zfhgaiufgsbdfigsdfg'
    const state = 'state'
    const error = 'foo'
    const errorDescription = 'foo'

    let server: AuthSSOServer

    beforeEach(async function () {
        server = new AuthSSOServer(state)
        await server.start()
    })

    afterEach(async function () {
        await server.close()
    })

    function createURL(baseUrl: string, params: Record<string, string>) {
        const url = new URL(baseUrl)
        url.search = new URLSearchParams(params).toString()
        return url.toString()
    }

    async function createRequest(params: Record<string, string>) {
        const url = createURL(server.redirectUri, params)
        const response = await request.fetch('GET', url).response
        assert.strictEqual(response.status, 200)
    }

    function assertAuthorizationError(expectedError: ToolkitError) {
        return new Promise<void>(resolve => {
            server
                .waitForAuthorization()
                .then(result => {
                    assert.fail(`Expected catch but found ${result}`)
                })
                .catch(reason => {
                    assert.deepStrictEqual(reason, expectedError)
                    resolve()
                })
        })
    }

    it('rejects origin', async function () {
        // TODO
    })

    it('handles authentication error', async function () {
        await createRequest({
            error,
            error_description: errorDescription,
        })
        await assertAuthorizationError(new AuthError(error, errorDescription))
    })

    it('handles missing code param', async function () {
        await createRequest({
            state,
        })
        await assertAuthorizationError(new MissingCodeError())
    })

    it('handles missing state param', async function () {
        await createRequest({
            code,
        })

        await assertAuthorizationError(new MissingStateError())
    })

    it('handles invalid state param', async function () {
        await createRequest({
            code,
            state: 'someInvalidState',
        })

        await assertAuthorizationError(new InvalidStateError())
    })

    it('handles valid redirect', async function () {
        await createRequest({
            code,
            state,
        })

        const token = await server.waitForAuthorization()
        assert.deepStrictEqual(code, token)
    })
})
