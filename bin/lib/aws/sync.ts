import type { Reflection } from '@riddance/host/reflect'
import { localAwsEnv } from './lite.js'
import { getApi, syncGateway } from './services/apiGateway.js'
import { getFunctions, syncLambda } from './services/lambda.js'
import { assignPolicy, getRole, syncRole } from './services/roles.js'
import { syncTriggers } from './services/triggers.js'

export async function getCurrentState(prefix: string, service: string) {
    const env = await localAwsEnv(undefined, prefix)
    const [role, functions, apis] = await Promise.all([
        getRole(env, prefix, service),
        getFunctions(env, prefix, service),
        getApi(env, prefix, service),
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
    provider: {
        aws?: { policyStatements: { Effect: string; Resource: string; Action: string[] }[] }
    },
    lambdaSafeList?: string[],
) {
    const env = await localAwsEnv(undefined, prefix)
    const role = await syncRole(env, prefix, service, currentState.role)
    const fns = await syncLambda(
        env,
        prefix,
        currentState.functions,
        reflection,
        environment,
        role,
        code,
        lambdaSafeList,
    )
    const [_arn, _aws, _lambda, region, account, _function, _name] = fns[0]?.id.split(':') ?? []
    if (!region || !account) {
        throw new Error('Weird')
    }

    const gatewayId = await syncGateway(
        env,
        region,
        account,
        prefix,
        service,
        currentState.apis,
        reflection,
        corsSites,
    )

    await syncTriggers(env, prefix, service, fns, reflection, region, account, gatewayId)

    await assignPolicy(env, prefix, service, region, account, provider.aws?.policyStatements ?? [])

    return `https://${gatewayId}.execute-api.eu-central-1.amazonaws.com/`
}
