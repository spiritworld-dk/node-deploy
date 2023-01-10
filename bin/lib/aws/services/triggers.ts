import { jsonResponse, okResponse } from '@riddance/fetch'
import { Reflection } from '@riddance/host/reflect'
import { randomUUID } from 'node:crypto'
import { Agent } from 'node:https'
import { isDeepStrictEqual } from 'node:util'
import { awsRequest, isNotFound, LocalEnv } from '../lite.js'

export async function syncTriggers(
    env: LocalEnv,
    agent: Agent,
    prefix: string,
    service: string,
    functions: { id: string; name: string }[],
    reflection: Reflection,
    region: string | undefined,
    account: string | undefined,
    apiGatewayId: string,
) {
    const currentTriggers = await getTriggers(env, agent, prefix, service, functions)
    await Promise.all(
        reflection.http.map(async fn => {
            const trigger = currentTriggers.find(t => t.name === fn.name)
            if (!trigger) {
                const statement = makeStatementData(
                    region,
                    account,
                    apiGatewayId,
                    functions.find(f => f.name === fn.name)?.id ?? '',
                    fn,
                )
                await addTrigger(env, agent, prefix, service, fn.name, randomUUID(), statement)
                return
            }
            const statement = makeStatementData(region, account, apiGatewayId, trigger.id, fn)
            let exists = false
            if (trigger.statements) {
                for (const { Sid, ...data } of trigger.statements) {
                    if (isDeepStrictEqual(data, statement)) {
                        if (exists) {
                            await deleteTrigger(env, agent, prefix, service, fn.name, Sid)
                        } else {
                            exists = true
                        }
                    } else {
                        await deleteTrigger(env, agent, prefix, service, fn.name, Sid)
                    }
                }
            }
            if (!exists) {
                await addTrigger(env, agent, prefix, service, fn.name, randomUUID(), statement)
            }
        }),
    )
}

export interface AwsTrigger {
    id: string
    name: string
    config?: {
        method: string
        pathPattern: string
    }
    statements?: AwsStatement[]
}

interface AwsStatement {
    Sid: string
    Effect: string
    Principal: { Service: string }
    Action: string
    Resource: string
    Condition: unknown
}

export async function getTriggers(
    env: LocalEnv,
    agent: Agent,
    prefix: string,
    service: string,
    functions: { id: string; name: string }[],
): Promise<AwsTrigger[]> {
    const policies = await Promise.all(
        functions.map(async fn => {
            try {
                return {
                    id: fn.id,
                    name: fn.name,
                    statements: (
                        JSON.parse(
                            (
                                await jsonResponse<{ Policy: string }>(
                                    awsRequest(
                                        agent,
                                        env,
                                        'GET',
                                        'lambda',
                                        `/2015-03-31/functions/${prefix}-${service}-${fn.name}/policy/`,
                                    ),
                                    'Error getting triggers.',
                                )
                            ).Policy,
                        ) as { Statement: AwsStatement[] }
                    ).Statement,
                }
            } catch (e) {
                if (isNotFound(e)) {
                    return {
                        id: fn.id,
                        name: fn.name,
                    }
                }
                throw e
            }
        }),
    )
    return policies
}

async function addTrigger(
    env: LocalEnv,
    agent: Agent,
    prefix: string,
    service: string,
    name: string,
    id: string,
    statement: ReturnType<typeof makeStatementData>,
) {
    console.log('Adding trigger ' + id)
    await okResponse(
        awsRequest(
            agent,
            env,
            'POST',
            'lambda',
            `/2015-03-31/functions/${prefix}-${service}-${name}/policy/`,
            {
                StatementId: id,
                Action: statement.Action,
                Principal: statement.Principal.Service,
                SourceArn: statement.Condition.ArnLike['AWS:SourceArn'],
            },
        ),
        'Error adding triggers.',
    )
}

async function deleteTrigger(
    env: LocalEnv,
    agent: Agent,
    prefix: string,
    service: string,
    name: string,
    id: string,
) {
    console.log('Deleting trigger ' + id)
    await okResponse(
        awsRequest(
            agent,
            env,
            'DELETE',
            'lambda',
            `/2015-03-31/functions/${prefix}-${service}-${name}/policy/${id}`,
        ),
        'Error deleting triggers.',
    )
}

function makeStatementData(
    region: string | undefined,
    account: string | undefined,
    apiGatewayId: string,
    functionId: string,
    fn: {
        name: string
        method: string
        pathPattern: string
    },
) {
    if (!region || !account) {
        throw new Error('Weird')
    }
    let p = 0
    return {
        Action: 'lambda:InvokeFunction',
        Effect: 'Allow',
        Principal: {
            Service: 'apigateway.amazonaws.com',
        },
        Resource: functionId,
        Condition: {
            ArnLike: {
                'AWS:SourceArn': `arn:aws:execute-api:${region}:${account}:${apiGatewayId}/*/*/${trimTrailingSlash(
                    fn.pathPattern.replaceAll('*', () => `{p${++p}}`),
                )}`,
            },
        },
    }
}

function trimTrailingSlash(pathPattern: string) {
    if (pathPattern.endsWith('/')) {
        return pathPattern.substring(0, pathPattern.length - 1)
    }
    return pathPattern
}
