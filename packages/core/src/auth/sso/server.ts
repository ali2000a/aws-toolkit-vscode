/*!
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

import http from 'http'
import { getLogger } from '../../shared/logger'
import { ToolkitError } from '../../shared/errors'
import { Socket } from 'net'

export class MissingPortError extends ToolkitError {
    constructor() {
        super('AuthSSOServer: missing auth server port', { code: 'MissingPort' })
    }
}

export class MissingCodeError extends ToolkitError {
    constructor() {
        super('AuthSSOServer: missing code', { code: 'MissingCode' })
    }
}

export class MissingStateError extends ToolkitError {
    constructor() {
        super('AuthSSOServer: missing state', { code: 'MissingState' })
    }
}

export class InvalidStateError extends ToolkitError {
    constructor() {
        super('AuthSSOServer: invalid state', { code: 'InvalidState' })
    }
}

export class AuthError extends ToolkitError {
    constructor(error: string, errorDescription: string) {
        super(`${error}: ${errorDescription}`, { code: 'AuthRedirectError' })
    }
}

/**
 * Server responsible for taking redirect requests from auth and redirecting them
 * back to VSCode
 */
export class AuthSSOServer {
    public baseUrl = `http://127.0.0.1`
    private oauthCallback = '/'

    private readonly authenticationPromise: Promise<string>
    private deferred: { resolve: (result: string) => void; reject: (reason: any) => void } | undefined
    private server: http.Server
    private connections: Socket[]

    constructor(private readonly state: string) {
        this.authenticationPromise = new Promise<string>((resolve, reject) => {
            this.deferred = { resolve, reject }
        })

        this.connections = []

        this.server = http.createServer((req, res) => {
            // TODO figured out what origin this would be coming from. Doesn't apply to web
            const origin = req.headers.origin ?? ''
            console.log(origin)
            const reg = /test/
            if (reg.test(origin)) {
                res.setHeader('Access-Control-Allow-Origin', '*')
            }

            res.setHeader('Access-Control-Allow-Methods', 'GET')

            if (!req.url) {
                return
            }

            const url = new URL(req.url, this.baseUrl)
            switch (url.pathname) {
                // This is the only registrable callback for now
                case this.oauthCallback: {
                    this.handleAuthentication(url.searchParams)
                    res.writeHead(200)
                    res.end('Success!')
                    break
                }
                default: {
                    getLogger().info('AuthSSOServer: missing redirection path name')
                }
            }
        })

        this.server.on('connection', connection => {
            this.connections.push(connection)
        })
    }

    start() {
        if (this.server.listening) {
            throw new ToolkitError('AuthSSOServer: Server already started')
        }

        return new Promise<void>((resolve, reject) => {
            this.server.on('close', () => {
                reject(new ToolkitError('AuthSSOServer: Server has closed'))
            })

            this.server.on('error', error => {
                reject(new ToolkitError(`AuthSSOServer: Server failed: ${error}`))
            })

            this.server.on('listening', () => {
                if (!this.server.address()) {
                    reject(new MissingPortError())
                }

                resolve()
            })

            this.server.listen(60821)
        })
    }

    close() {
        return new Promise<void>((resolve, reject) => {
            if (!this.server.listening) {
                reject(new ToolkitError('AuthSSOServer: Server not started'))
            }

            this.connections.forEach(connection => {
                connection.destroy()
            })

            this.server.close(err => {
                if (err) {
                    reject(err)
                }
                resolve()
            })
        })
    }

    public get redirectUri(): string {
        return `${this.baseUrl}:${this.getPort()}`
    }

    private getPort(): number {
        const addr = this.server.address()
        if (addr instanceof Object) {
            return addr.port
        } else if (typeof addr === 'string') {
            return parseInt(addr)
        } else {
            throw new MissingPortError()
        }
    }

    private handleAuthentication(params: URLSearchParams) {
        if (params.has('error') && params.has('error_description')) {
            const error = params.get('error')!
            const errorDescription = params.get('error_description')!
            this.deferred?.reject(new AuthError(error, errorDescription))
            return
        }

        this.handleToken(params)
    }

    private handleToken(params: URLSearchParams) {
        const code = params.get('code')
        if (!code) {
            this.deferred?.reject(new MissingCodeError())
            return
        }

        const state = params.get('state')
        if (!state) {
            this.deferred?.reject(new MissingStateError())
            return
        }

        if (state !== this.state) {
            this.deferred?.reject(new InvalidStateError())
            return
        }

        this.deferred?.resolve(code)
    }

    public waitForAuthorization() {
        return this.authenticationPromise
    }
}
