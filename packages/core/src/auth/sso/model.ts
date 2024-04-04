/*!
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

import globals from '../../shared/extensionGlobals'

import * as nls from 'vscode-nls'
const localize = nls.loadMessageBundle()

import * as vscode from 'vscode'
import { telemetry } from '../../shared/telemetry/telemetry'
import { ToolkitError } from '../../shared/errors'

export interface SsoToken {
    /**
     * An optional identity associated with this token.
     */
    readonly identity?: string

    /**
     * A base64 encoded string returned by the SSO-OIDC service. This token must be treated as an
     * opaque UTF-8 string and must not be decoded.
     */
    readonly accessToken: string

    /**
     * The expiration time of the accessToken.
     */
    readonly expiresAt: Date

    /**
     * Should always be `Bearer` if present.
     */
    readonly tokenType?: string

    /**
     * Opaque token that may be used to 'refresh' the authentication session after expiration.
     */
    readonly refreshToken?: string
}

export interface ClientRegistration {
    /**
     * Unique registration id.
     */
    readonly clientId: string

    /**
     * Secret key associated with the registration.
     */
    readonly clientSecret: string

    /**
     * The expiration time of the registration.
     */
    readonly expiresAt: Date

    /**
     * Scope of the client registration. Applies to all tokens created using this registration.
     */
    readonly scopes?: string[]

    /**
     * The sso instance used to create this registration.
     */
    readonly issuerUrl?: string
}

export interface SsoProfile {
    readonly region: string
    readonly startUrl: string
    readonly accountId?: string
    readonly roleName?: string
    readonly scopes?: string[]
    readonly identifier?: string
}

export const builderIdStartUrl = 'https://view.awsapps.com/start'
export const trustedDomainCancellation = 'TrustedDomainCancellation'

export function truncateStartUrl(startUrl: string) {
    return startUrl.match(/https?:\/\/(.*)\.awsapps\.com\/start/)?.[1] ?? startUrl
}

export const proceedToBrowser = localize('AWS.auth.loginWithBrowser.proceedToBrowser', 'Proceed To Browser')

export async function openSsoPortalLink(location: string): Promise<boolean> {
    async function openSsoUrl() {
        const didOpenUrl = await vscode.env.openExternal(vscode.Uri.parse(location))

        if (!didOpenUrl) {
            throw new ToolkitError(`User clicked 'Copy' or 'Cancel' during the Trusted Domain popup`, {
                code: trustedDomainCancellation,
                name: trustedDomainCancellation,
                cancelled: true,
            })
        }
        return didOpenUrl
    }

    return telemetry.aws_loginWithBrowser.run(() => openSsoUrl())
}

// Most SSO 'expirables' are fairly long lived, so a one minute buffer is plenty.
const expirationBufferMs = 60000
export function isExpired(expirable: { expiresAt: Date }): boolean {
    return globals.clock.Date.now() + expirationBufferMs >= expirable.expiresAt.getTime()
}

export function isDeprecatedAuth(registration: ClientRegistration): boolean {
    return registration.issuerUrl === undefined
}
