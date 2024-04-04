/*!
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

import globals from '../../shared/extensionGlobals'
import { SSOOIDCServiceException } from '@aws-sdk/client-sso-oidc'
import {
    SsoToken,
    ClientRegistration,
    isExpired,
    SsoProfile,
    builderIdStartUrl,
    openSsoPortalLink,
    isDeprecatedAuth,
} from './model'
import { getCache } from './cache'
import { hasProps, RequiredProps, selectFrom } from '../../shared/utilities/tsUtils'
import { OidcClient } from './clients'
import { loadOr } from '../../shared/utilities/cacheUtils'
import {
    getRequestId,
    getTelemetryReason,
    getTelemetryResult,
    isClientFault,
    isNetworkError,
} from '../../shared/errors'
import { getLogger } from '../../shared/logger'
import { AwsRefreshCredentials, telemetry } from '../../shared/telemetry/telemetry'
import { indent } from '../../shared/utilities/textUtilities'
import { UriHandler } from '../../shared/vscode/uriHandler'
import { AuthSSOServer } from './server'
import { CancellationError } from '../../shared/utilities/timeoutUtils'
import OidcClientPKCE from './oidcclientpkce'
import { getIdeProperties, isCloud9 } from '../../shared/extensionUtilities'
import { randomUUID, randomBytes, createHash } from 'crypto'

const clientRegistrationType = 'public'
const authorizationGrantType = 'authorization_code'
const refreshGrantType = 'refresh_token'

/**
 *  SSO flow (RFC: https://tools.ietf.org/html/rfc8628)
 *    1. Get a client id (SSO-OIDC identifier, formatted per RFC6749).
 *       - Toolkit code: {@link SsoAccessTokenProvider.registerClient}
 *          - Calls {@link OidcClient.registerClient}
 *       - RETURNS:
 *         - ClientSecret
 *         - ClientId
 *         - ClientSecretExpiresAt
 *       - Client registration is valid for potentially months and creates state
 *         server-side, so the client SHOULD cache them to disk.
 *    2. Start device authorization.
 *       - Toolkit code: {@link SsoAccessTokenProvider.authorize}
 *          - Calls {@link OidcClient.startDeviceAuthorization}
 *       - RETURNS (RFC: https://tools.ietf.org/html/rfc8628#section-3.2):
 *         - DeviceCode             : Device verification code
 *         - UserCode               : User verification code
 *         - VerificationUri        : User verification URI on the authorization server
 *         - VerificationUriComplete: User verification URI including the `user_code`
 *         - ExpiresIn              : Lifetime (seconds) of `device_code` and `user_code`
 *         - Interval               : Minimum time (seconds) the client SHOULD wait between polling intervals.
 *    3. Poll for the access token.
 *       - Toolkit code: {@link SsoAccessTokenProvider.authorize}
 *          - Calls {@link pollForTokenWithProgress}
 *       - RETURNS:
 *         - AccessToken
 *         - ExpiresIn
 *         - RefreshToken (optional)
 *    4. (Repeat) Tokens SHOULD be refreshed if expired and a refresh token is available.
 *        - Toolkit code: {@link SsoAccessTokenProvider.refreshToken}
 *          - Calls {@link OidcClient.createToken}
 *        - RETURNS:
 *         - AccessToken
 *         - ExpiresIn
 *         - RefreshToken (optional)
 */
export class SsoAccessTokenProvider {
    public constructor(
        private readonly profile: Pick<SsoProfile, 'startUrl' | 'region' | 'scopes' | 'identifier'>,
        private readonly cache = getCache(),
        private readonly oidc = OidcClient.create(profile.region)
    ) {}

    public async invalidate(): Promise<void> {
        // Use allSettled() instead of all() to ensure all clear() calls are resolved.
        getLogger().info(`SsoAccessTokenProvider invalidate token and registration`)
        await Promise.allSettled([
            this.cache.token.clear(this.tokenCacheKey, 'SsoAccessTokenProvider.invalidate()'),
            this.cache.registration.clear(this.registrationCacheKey, 'SsoAccessTokenProvider.invalidate()'),
        ])
    }

    public async getToken(): Promise<SsoToken | undefined> {
        const data = await this.cache.token.load(this.tokenCacheKey)
        getLogger().info(
            indent(
                `current client registration id=${data?.registration?.clientId}, 
                            expires at ${data?.registration?.expiresAt}, 
                            key = ${this.tokenCacheKey}`,
                4,
                true
            )
        )
        if (!data || !isExpired(data.token)) {
            return data?.token
        }

        if (data.registration && !isExpired(data.registration) && hasProps(data.token, 'refreshToken')) {
            const refreshed = await this.refreshToken(data.token, data.registration)

            return refreshed.token
        } else {
            await this.invalidate()
        }
    }

    public async createToken(): Promise<SsoToken> {
        const access = await this.runFlow()
        const identity = this.tokenCacheKey
        await this.cache.token.save(identity, access)
        await setSessionCreationDate(this.tokenCacheKey, new Date())

        return { ...access.token, identity }
    }

    private async runFlow() {
        const registration = await this.getValidatedClientRegistration()
        try {
            return await this.authorize(registration)
        } catch (err) {
            if (err instanceof SSOOIDCServiceException && isClientFault(err)) {
                await this.cache.registration.clear(
                    this.registrationCacheKey,
                    `client fault: SSOOIDCServiceException: ${err.message}`
                )
            }

            throw err
        }
    }

    private async refreshToken(token: RequiredProps<SsoToken, 'refreshToken'>, registration: ClientRegistration) {
        try {
            const clientInfo = selectFrom(registration, 'clientId', 'clientSecret')
            const response = await this.oidc.createToken({ ...clientInfo, ...token, grantType: refreshGrantType })
            const refreshed = this.formatToken(response, registration)
            await this.cache.token.save(this.tokenCacheKey, refreshed)

            return refreshed
        } catch (err) {
            if (!isNetworkError(err)) {
                telemetry.aws_refreshCredentials.emit({
                    result: getTelemetryResult(err),
                    reason: getTelemetryReason(err),
                    requestId: getRequestId(err),
                    sessionDuration: getSessionDuration(this.tokenCacheKey),
                    credentialType: 'bearerToken',
                    credentialSourceId: this.profile.startUrl === builderIdStartUrl ? 'awsId' : 'iamIdentityCenter',
                } as AwsRefreshCredentials)

                if (err instanceof SSOOIDCServiceException && isClientFault(err)) {
                    await this.cache.token.clear(
                        this.tokenCacheKey,
                        `client fault: SSOOIDCServiceException: ${err.message}`
                    )
                }
            }

            throw err
        }
    }

    private formatToken(token: SsoToken, registration: ClientRegistration) {
        return { token, registration, region: this.profile.region, startUrl: this.profile.startUrl }
    }

    protected get tokenCacheKey() {
        return this.profile.identifier ?? this.profile.startUrl
    }

    private get registrationCacheKey() {
        return { region: this.profile.region, scopes: this.profile.scopes }
    }

    private async authorize(registration: ClientRegistration) {
        const state = randomUUID()
        const authServer = new AuthSSOServer(state)

        try {
            await authServer.start()
            const redirectUri = authServer.redirectUri

            const codeVerifier = randomBytes(32).toString('base64url')
            const codeChallenge = createHash('sha256').update(codeVerifier).digest().toString('base64url')

            const location = await this.oidc.authorize({
                responseType: 'code',
                clientId: registration.clientId,
                redirectUri: redirectUri,
                scopes: this.profile.scopes ?? [],
                state,
                codeChallenge,
                codeChallengeMethod: 'S256',
            })

            if (!(await openSsoPortalLink(location))) {
                throw new CancellationError('user')
            }

            const authorizationResult = await authServer.waitForAuthorization()

            const tokenRequest: OidcClientPKCE.CreateTokenRequest = {
                clientId: registration.clientId,
                clientSecret: registration.clientSecret,
                grantType: authorizationGrantType,
                redirectUri: redirectUri,
                codeVerifier,
                code: authorizationResult,
            }

            const token = await this.oidc.createToken(tokenRequest)
            return this.formatToken(token, registration)
        } catch (err) {
            console.log(err)
            throw err
        } finally {
            await authServer.close()
        }
    }

    /**
     * If the registration already exists locally, it
     * will be validated before being returned. Otherwise, a client registration is
     * created and returned.
     */
    private async getValidatedClientRegistration(): Promise<ClientRegistration> {
        const cacheKey = this.registrationCacheKey
        const cachedRegistration = await this.cache.registration.load(cacheKey)

        // Clear cached if registration is expired or it uses a deprecate auth version (device code)
        if (cachedRegistration && (isExpired(cachedRegistration) || isDeprecatedAuth(cachedRegistration))) {
            await this.invalidate()
        }

        return loadOr(this.cache.registration, cacheKey, () => this.registerClient())
    }

    private async registerClient(): Promise<ClientRegistration> {
        const companyName = getIdeProperties().company
        return this.oidc.registerClient({
            clientName: isCloud9() ? `${companyName} Cloud9` : `${companyName} Toolkit for VSCode`,
            clientType: clientRegistrationType,
            scopes: this.profile.scopes,
            grantTypes: [authorizationGrantType, refreshGrantType],
            redirectUris: ['http://127.0.0.1:60821'],
            issuerUrl: this.profile.startUrl,
        })
    }

    public static create(profile: Pick<SsoProfile, 'startUrl' | 'region' | 'scopes' | 'identifier'>) {
        return new this(profile)
    }

    /**
     * The URL we pass to the authorization request, so that once the user is done setup in the browser
     * it will redirect to this URL and open back up VS Code. {@link SsoAccessTokenProvider.waitUntilAuthenticated}
     * must be used for the browser to automatically open VS Code.
     */
    static get onAuthenticatedUrl() {
        return UriHandler.buildUri('sso/authenticated')
    }
}

const sessionCreationDateKey = '#sessionCreationDates'
async function setSessionCreationDate(id: string, date: Date, memento = globals.context.globalState) {
    try {
        await memento.update(sessionCreationDateKey, {
            ...memento.get(sessionCreationDateKey),
            [id]: date.getTime(),
        })
    } catch (err) {
        getLogger().verbose('auth: failed to set session creation date: %s', err)
    }
}

function getSessionCreationDate(id: string, memento = globals.context.globalState): number | undefined {
    return memento.get(sessionCreationDateKey, {} as Record<string, number>)[id]
}

function getSessionDuration(id: string, memento = globals.context.globalState) {
    const creationDate = getSessionCreationDate(id, memento)

    return creationDate !== undefined ? Date.now() - creationDate : undefined
}
