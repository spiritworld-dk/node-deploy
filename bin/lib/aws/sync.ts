import type { Reflection } from '@riddance/host/reflect'
import { Agent } from 'node:https'
import { localAwsEnv } from './lite.js'
import { getApi, syncGateway } from './services/apiGateway.js'
import { getFunctions, syncLambda } from './services/lambda.js'
import { assignPolicy, getRole, syncRole } from './services/roles.js'
import { syncTriggers } from './services/triggers.js'

const agent = new Agent({
    keepAlive: true,
    maxSockets: 4,
})

const env = await localAwsEnv()

export async function getCurrentState(prefix: string, service: string) {
    const [role, functions, apis] = await Promise.all([
        getRole(env, agent, prefix, service),
        getFunctions(env, agent, prefix, service),
        getApi(env, agent, prefix, service),
    ])
    return { role, functions, apis }
}

export type CurrentState = Awaited<ReturnType<typeof getCurrentState>>

export async function sync(
    prefix: string,
    service: string,
    currentState: CurrentState,
    reflection: Reflection,
    corsSites: string[],
    environment: { [key: string]: string },
    code: { [name: string]: string },
) {
    const role = await syncRole(env, agent, prefix, service, currentState.role)
    const fns = await syncLambda(
        env,
        agent,
        prefix,
        currentState.functions,
        reflection,
        environment,
        role,
        code,
    )
    const [_arn, _aws, _lambda, region, account, _function, _name] = fns[0]?.id.split(':') ?? []
    if (!region || !account) {
        throw new Error('Weird')
    }

    const gatewayId = await syncGateway(
        env,
        agent,
        region,
        account,
        prefix,
        service,
        currentState.apis,
        reflection,
        corsSites,
    )

    await syncTriggers(env, agent, prefix, service, fns, reflection, region, account, gatewayId)

    await assignPolicy(env, agent, prefix, service, region, account)

    return `https://${gatewayId}.execute-api.eu-central-1.amazonaws.com/`
}
