import { jsonResponse, okResponse, throwOnNotOK } from '@riddance/fetch'
import { Reflection } from '@riddance/host/reflect'
import { Agent } from 'node:https'
import { isDeepStrictEqual } from 'node:util'
import { compare } from '../diff.js'
import { LocalEnv, awsRequest } from '../lite.js'

export async function syncGateway(
    env: LocalEnv,
    agent: Agent,
    region: string | undefined,
    account: string | undefined,
    prefix: string,
    service: string,
    currentGateway: AwsGateway,
    reflection: Reflection,
    corsSites: string[],
) {
    if (!currentGateway.api) {
        const gateway = await createGateway(env, agent, prefix, service, corsSites)
        const ids = await Promise.all(
            reflection.http.map(fn =>
                createIntegration(
                    env,
                    agent,
                    gateway.apiId,
                    fn.name,
                    asIntegration(region, account, prefix, service, fn),
                ),
            ),
        )
        const integrationIdByName = Object.fromEntries(ids)
        await Promise.all(
            reflection.http.map(fn =>
                createRoute(env, agent, gateway.apiId, asRoute(integrationIdByName[fn.name], fn)),
            ),
        )
        return gateway.apiId
    } else {
        await syncGatewayApi(currentGateway.api, env, agent, prefix, service, corsSites)
        await syncStage(env, agent, prefix, service, currentGateway.api.apiId, currentGateway.stage)
        const { ids, surplus: surplusIntegrations } = await syncIntegrations(
            env,
            agent,
            region,
            account,
            prefix,
            service,
            currentGateway.api.apiId,
            currentGateway.integrations,
            reflection,
        )
        const integrationIdByName = Object.fromEntries(ids)
        const nameByTarget = Object.fromEntries(
            ids.map(([name, integrationId]) => [`integrations/${integrationId}`, name]),
        )

        const { missing, surplus, existing } = compare(
            reflection.http,
            currentGateway.routes.map(r => ({
                // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
                name: nameByTarget[r.target]!,
                ...r,
            })),
        )
        await Promise.all([
            ...surplus.map(i => deleteRoute(env, agent, currentGateway.api.apiId, i.routeId)),
            ...missing.map(fn =>
                createRoute(
                    env,
                    agent,
                    currentGateway.api.apiId,
                    asRoute(integrationIdByName[fn.name], fn),
                ),
            ),
            ...existing.map(async ({ name, routeId, ...ex }) => {
                // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
                const fn = reflection.http.find(f => f.name === name)!
                const route = asRoute(integrationIdByName[fn.name], fn)
                if (isDeepStrictEqual(ex, route)) {
                    return
                }
                await updateRoute(env, agent, currentGateway.api.apiId, routeId, route)
            }),
        ])
        await Promise.all(
            surplusIntegrations.map(i =>
                deleteIntegration(
                    env,
                    agent,
                    region,
                    account,
                    currentGateway.api.apiId,
                    i.integrationId,
                ),
            ),
        )
        return currentGateway.api.apiId
    }
}

async function syncIntegrations(
    env: LocalEnv,
    agent: Agent,
    region: string | undefined,
    account: string | undefined,
    prefix: string,
    service: string,
    apiId: string,
    currentIntegrations: (AwsIntegration & { integrationId: string })[],
    reflection: Reflection,
) {
    const { missing, surplus, existing } = compare(
        reflection.http,
        currentIntegrations.map(i => ({
            // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
            name: i.integrationUri.split(':').at(-1)!.split('-').at(-1)!,
            ...i,
        })),
    )
    const ids = await Promise.all([
        ...missing.map(fn =>
            createIntegration(
                env,
                agent,
                apiId,
                fn.name,
                asIntegration(region, account, prefix, service, fn),
            ),
        ),
        ...existing.map(async ({ name, integrationId, ...ex }) => {
            // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
            const fn = reflection.http.find(f => f.name === name)!
            const integration = asIntegration(region, account, prefix, service, fn)
            if (isDeepStrictEqual(ex, integration)) {
                return [name, integrationId] as [string, string]
            }
            await updateIntegration(env, agent, apiId, integrationId, integration)
            return [name, integrationId] as [string, string]
        }),
    ])
    return { ids, surplus }
}

type AwsGateway = Awaited<ReturnType<typeof getApi>>

export type AwsGatewayApi = {
    apiId: string
    name: string
    protocolType: 'HTTP' | 'REST'
    apiEndpoint: string
    corsConfiguration: {
        allowOrigins: string[]
        allowCredentials: false
        maxAge: number
        allowMethods: string[]
        allowHeaders: string[]
        exposeHeaders: string[]
    }
}

export async function getApi(env: LocalEnv, agent: Agent, prefix: string, service: string) {
    const apis = await jsonResponse<{ items: AwsGatewayApi[] }>(
        awsRequest(agent, env, 'GET', 'apigateway', `/v2/apis/`),
        'Error getting APIs.',
    )
    const [api] = apis.items.filter(a => a.name === `${prefix}-${service}`)
    if (!api) {
        return { integrations: [], routes: [] }
    }
    const [integrations, routes, stage] = await Promise.all([
        getIntegrations(env, agent, api.apiId),
        getRoutes(env, agent, api.apiId),
        getStage(env, agent, api.apiId),
    ])
    return { api, integrations: integrations.items, routes: routes.items, stage }
}

export type AwsIntegration = {
    payloadFormatVersion: '2.0'
    integrationType: 'AWS_PROXY'
    integrationMethod: string
    integrationUri: string
    connectionType: 'INTERNET'
    timeoutInMillis: number | undefined
}

async function getIntegrations(env: LocalEnv, agent: Agent, apiId: string) {
    return await jsonResponse<{
        items: (AwsIntegration & { integrationId: string })[]
    }>(
        awsRequest(agent, env, 'GET', 'apigateway', `/v2/apis/${apiId}/integrations`),
        'Error getting API integrations.',
    )
}

function asIntegration(
    region: string | undefined,
    account: string | undefined,
    prefix: string,
    service: string,
    fn: { name: string; method: string; pathPattern: string; config: { timeout?: number } },
): AwsIntegration {
    if (!region || !account) {
        throw new Error('Weird')
    }
    return {
        payloadFormatVersion: '2.0',
        integrationType: 'AWS_PROXY',
        integrationMethod: fn.method,
        integrationUri: `arn:aws:lambda:${region}:${account}:function:${prefix}-${service}-${fn.name}`,
        connectionType: 'INTERNET',
        timeoutInMillis: Math.min(((fn.config.timeout ?? 15) + 5) * 1000, 30000),
    }
}

async function createIntegration(
    env: LocalEnv,
    agent: Agent,
    apiId: string,
    name: string,
    integration: AwsIntegration,
) {
    console.log('creating API integration')
    const created = await jsonResponse<{ integrationId: string }>(
        awsRequest(agent, env, 'POST', 'apigateway', `/v2/apis/${apiId}/integrations`, integration),
        'Error creating API integration.',
    )
    return [name, created.integrationId] as [string, string]
}

async function updateIntegration(
    env: LocalEnv,
    agent: Agent,
    apiId: string,
    id: string,
    integration: AwsIntegration,
) {
    console.log('updating API integration')
    await okResponse(
        awsRequest(
            agent,
            env,
            'PATCH',
            'apigateway',
            `/v2/apis/${apiId}/integrations/${id}`,
            integration,
        ),
        'Error updating API integration',
    )
}

async function deleteIntegration(
    env: LocalEnv,
    agent: Agent,
    region: string | undefined,
    account: string | undefined,
    apiId: string,
    id: string,
) {
    if (!region || !account) {
        throw new Error('Weird')
    }
    console.log('deleting API integration')
    await okResponse(
        awsRequest(agent, env, 'DELETE', 'apigateway', `/v2/apis/${apiId}/integrations/${id}`),
        'Error deleting API integration.',
    )
}

export type AwsRoute = {
    routeKey: string
    authorizationType: 'NONE'
    apiKeyRequired: false
    target: string
}

function asRoute(
    integrationId: string | undefined,
    fn: { method: string; pathPattern: string },
): AwsRoute {
    if (!integrationId) {
        throw new Error(`Weird: no integration ID for ${fn.method} ${fn.pathPattern}`)
    }
    let p = 0
    return {
        routeKey: `${fn.method} /${trimTrailingSlash(
            fn.pathPattern.replaceAll('*', () => `{p${++p}}`),
        )}`,
        authorizationType: 'NONE',
        apiKeyRequired: false,
        target: `integrations/${integrationId}`,
    }
}

function trimTrailingSlash(pathPattern: string) {
    if (pathPattern.endsWith('/')) {
        return pathPattern.substring(0, pathPattern.length - 1)
    }
    return pathPattern
}

async function getRoutes(env: LocalEnv, agent: Agent, apiId: string) {
    return await jsonResponse<{
        items: (AwsRoute & { routeId: string })[]
    }>(
        awsRequest(agent, env, 'GET', 'apigateway', `/v2/apis/${apiId}/routes`),
        'Error getting API routes.',
    )
}

async function createRoute(env: LocalEnv, agent: Agent, apiId: string, route: AwsRoute) {
    console.log('creating route')
    return await okResponse(
        awsRequest(agent, env, 'POST', 'apigateway', `/v2/apis/${apiId}/routes`, route),
        'Error creating API route.',
    )
}

async function updateRoute(
    env: LocalEnv,
    agent: Agent,
    apiId: string,
    id: string,
    route: AwsRoute,
) {
    console.log(`updating API route ${id}`)
    return await okResponse(
        awsRequest(agent, env, 'PATCH', 'apigateway', `/v2/apis/${apiId}/routes/${id}`, route),
        'Error updating API route.',
    )
}

async function deleteRoute(env: LocalEnv, agent: Agent, apiId: string, id: string) {
    console.log(`deleting API route ${id}`)
    return await okResponse(
        awsRequest(agent, env, 'DELETE', 'apigateway', `/v2/apis/${apiId}/routes/${id}`),
        'Error deleting API route.',
    )
}

async function createGateway(
    env: LocalEnv,
    agent: Agent,
    prefix: string,
    service: string,
    corsSites: string[],
) {
    console.log('creating gateway')
    const gateway = await jsonResponse<{ apiId: string }>(
        awsRequest(agent, env, 'POST', 'apigateway', `/v2/apis/`, {
            name: `${prefix}-${service}`,
            protocolType: 'HTTP',
            corsConfiguration: corsSettings(corsSites),
            tags: {
                framework: 'riddance',
                environment: prefix,
                service,
            },
        }),
        'Error creating gateway.',
    )
    await syncStage(env, agent, prefix, service, gateway.apiId, undefined)
    return gateway
}

async function syncGatewayApi(
    gateway: AwsGatewayApi,
    env: LocalEnv,
    agent: Agent,
    prefix: string,
    service: string,
    corsSites: string[],
) {
    const corsConfiguration = corsSettings(corsSites)
    if (isDeepStrictEqual(corsConfiguration, gateway.corsConfiguration)) {
        return
    }
    console.log('updating gateway')
    await okResponse(
        awsRequest(agent, env, 'PATCH', 'apigateway', `/v2/apis/${gateway.apiId}`, {
            name: `${prefix}-${service}`,
            protocolType: 'HTTP',
            corsConfiguration,
            tags: {
                framework: 'riddance',
                environment: prefix,
                service,
            },
        }),
        'Error updating gateway.',
    )
}

function corsSettings(corsSites: string[]) {
    return {
        allowOrigins: corsSites,
        allowCredentials: !isDeepStrictEqual(corsSites, ['*']),
        maxAge: 600,
        allowMethods: ['*'],
        allowHeaders: ['*'],
        exposeHeaders: ['*'],
    }
}

export type ApiStage = {
    stageName: string
    description: string
    deploymentId: string
    clientCertificateId: string
    defaultRouteSettings: {
        detailedMetricsEnabled: boolean
        loggingLevel: 'INFO' | 'ERROR' | 'OFF'
        dataTraceEnabled: boolean
        throttlingBurstLimit: number
        throttlingRateLimit: number
    }
    routeSettings: { [key: string]: string }
    stageVariables: { [key: string]: string }
    accessLogSettings: {
        format: string
        destinationArn: string
    }
    autoDeploy: boolean
    lastDeploymentStatusMessage: string
    createdDate: string
    lastUpdatedDate: string
    tags: { [key: string]: string }
    apiGatewayManaged: boolean
}

async function getStage(env: LocalEnv, agent: Agent, apiId: string) {
    const response = await awsRequest(
        agent,
        env,
        'GET',
        'apigateway',
        `/v2/apis/${apiId}/stages/$default`,
    )
    if (response.status === 404) {
        return undefined
    }
    await throwOnNotOK(response, 'Error getting API stage.')
    return (await response.json()) as ApiStage
}

async function syncStage(
    env: LocalEnv,
    agent: Agent,
    prefix: string,
    service: string,
    apiId: string,
    stage: ApiStage | undefined,
) {
    if (!stage) {
        await okResponse(
            awsRequest(agent, env, 'POST', 'apigateway', `/v2/apis/${apiId}/stages`, {
                stageName: '$default',
                autoDeploy: true,
                tags: {
                    framework: 'riddance',
                    environment: prefix,
                    service,
                },
            }),
            'Error creating stage.',
        )
    }
}
