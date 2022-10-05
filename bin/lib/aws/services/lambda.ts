import { PackageJsonConfiguration, Reflection, resolveCpu } from '@riddance/host/reflect'
import JSZip from 'jszip'
import { createHash } from 'node:crypto'
import { Agent } from 'node:https'
import { isDeepStrictEqual } from 'node:util'
import { compare } from '../diff.js'
import { awsRequest, LocalEnv, retry, retryConflict, throwOnNotOK } from '../lite.js'

export async function syncLambda(
    env: LocalEnv,
    agent: Agent,
    prefix: string,
    currentFunctions: AwsFunctionLite[],
    reflection: Reflection,
    environment: { [key: string]: string },
    role: string,
    code: { [name: string]: string },
) {
    const zipped = Object.fromEntries(
        await Promise.all(
            Object.entries(code).map(
                async ([name, c]) =>
                    [name, await zip(c)] as [string, Awaited<ReturnType<typeof zip>>],
            ),
        ),
    )

    const { missing, surplus, existing } = compare(reflection.http, currentFunctions)
    const created = await Promise.all(
        missing.map(fn =>
            createLambda(
                env,
                agent,
                prefix,
                fn.name,
                reflection.name,
                role,
                fn.config,
                environment,
                zipped[fn.name],
            ),
        ),
    )
    await Promise.all(surplus.map(fn => deleteLambda(env, agent, prefix, reflection.name, fn.name)))
    await Promise.all(
        existing.map(awsFn =>
            updateLambda(
                env,
                agent,
                prefix,
                awsFn.name,
                reflection.name,
                role,
                reflection.http.find(fn => fn.name === awsFn.name)?.config,
                awsFn,
                environment,
                zipped[awsFn.name],
            ),
        ),
    )

    return currentFunctions.map(fn => ({ id: fn.id, name: fn.name })).concat(created)
}

async function zip(code: string) {
    const buffer = await new JSZip()
        .file('index.js', code, {
            compression: 'DEFLATE',
            compressionOptions: { level: 9 },
            date: new Date(2022, 8, 1),
        })
        .generateAsync({ type: 'nodebuffer' })
    return {
        zipped: buffer.toString('base64'),
        sha256: createHash('sha256').update(buffer).digest('base64'),
    }
}

type Architectures = ['arm64'] | ['x86_64']
export interface AwsFunctionLite {
    id: string
    name: string
    runtime: string
    memory: number
    timeout: number
    env: { [key: string]: string }
    cpus: Architectures
    hash: string
}

interface AwsFunction {
    Description: string
    TracingConfig: {
        Mode: 'PassThrough'
    }
    RevisionId: string
    LastModified: string
    FunctionArn: string
    FunctionName: string
    Runtime: 'nodejs16.x'
    Version: '$LATEST'
    PackageType: 'Zip'
    MemorySize: number
    Timeout: number
    Handler: 'index.handler'
    CodeSha256: string
    Role: string
    SigningProfileVersionArn: null
    MasterArn: null
    CodeSize: number
    State: null
    StateReason: null
    Environment: {
        Variables: { [key: string]: string }
        Error: null
    }
    EphemeralStorage: {
        Size: number
    }
    StateReasonCode: null
    LastUpdateStatusReasonCode: null
    Architectures: Architectures
}

export async function getFunctions(
    env: LocalEnv,
    agent: Agent,
    prefix: string,
    service: string,
): Promise<AwsFunctionLite[]> {
    const funcs = []
    let marker = ''
    for (;;) {
        const page = (await (
            await throwOnNotOK(
                'Error listing functions',
                awsRequest(agent, env, 'GET', 'lambda', `/2015-03-31/functions/?${marker}`),
            )
        ).json()) as {
            Functions: AwsFunction[]
            NextMarker: string | null
        }
        funcs.push(...page.Functions)
        if (page.NextMarker === null) {
            break
        }
        marker = `Marker=${encodeURIComponent(page.NextMarker)}`
    }
    const fnPrefix = `${prefix}-${service}-`.toLowerCase()
    return funcs
        .filter(fn => fn.FunctionName.startsWith(fnPrefix))
        .map(fn => ({
            id: fn.FunctionArn,
            name: fn.FunctionName.substring(fnPrefix.length),
            runtime: fn.Runtime,
            memory: fn.MemorySize,
            timeout: fn.Timeout,
            env: fn.Environment.Variables,
            cpus: fn.Architectures,
            hash: fn.CodeSha256,
        }))
}

type Config = {
    memory?: string
    compute?: string
    timeout?: number
} & PackageJsonConfiguration

async function createLambda(
    env: LocalEnv,
    agent: Agent,
    prefix: string,
    name: string,
    service: string,
    role: string,
    config: Config,
    environment: { [key: string]: string },
    code?: { zipped: string; sha256: string },
) {
    if (!code) {
        throw new Error('No code')
    }
    console.log('creating lambda ' + name)
    const response = (await (
        await throwOnNotOK(
            'Error creating lambda ' + name,
            retry(
                () =>
                    awsRequest(agent, env, 'POST', 'lambda', '/2015-03-31/functions', {
                        FunctionName: `${prefix}-${service}-${name}`,
                        Code: { ZipFile: code.zipped },
                        PackageType: 'Zip',
                        Architectures: lambdaArchitecture(config),
                        ...lambdaConfig(config, role, environment),
                        Tags: {
                            framework: 'riddance',
                            environment: prefix,
                            service,
                        },
                    }),
                r => (r.status === 400 ? 25 : undefined),
            ),
        )
    ).json()) as { FunctionArn: string }
    return { name, id: response.FunctionArn }
}

async function updateLambda(
    env: LocalEnv,
    agent: Agent,
    prefix: string,
    name: string,
    service: string,
    role: string,
    config: Config | undefined,
    awsFn: AwsFunctionLite,
    environment: { [key: string]: string },
    code?: { zipped: string; sha256: string },
) {
    if (!code) {
        throw new Error('No code')
    }
    if (!config) {
        throw new Error('No config')
    }
    const cpus = lambdaArchitecture(config)
    if (!isDeepStrictEqual({ cpus, hash: code.sha256 }, { cpus: awsFn.cpus, hash: awsFn.hash })) {
        console.log('updating code for lambda ' + name)
        await throwOnNotOK(
            'Error updating code for lambda ' + name,
            awsRequest(
                agent,
                env,
                'PUT',
                'lambda',
                `/2015-03-31/functions/${prefix}-${service}-${name}/code`,
                {
                    ZipFile: code.zipped,
                    Architectures: cpus,
                },
            ),
        )
    }
    const awsConfig = lambdaConfig(config, role, environment)
    if (
        !isDeepStrictEqual(
            {
                env: awsConfig.Environment.Variables,
                memory: awsConfig.MemorySize,
                timeout: awsConfig.Timeout,
                runtime: awsConfig.Runtime,
            },
            {
                env: awsFn.env,
                memory: awsFn.memory,
                timeout: awsFn.timeout,
                runtime: awsFn.runtime,
            },
        )
    ) {
        console.log('updating config for lambda ' + name)
        await retryConflict(() =>
            throwOnNotOK(
                'Error updating config for lambda ' + name,
                awsRequest(
                    agent,
                    env,
                    'PUT',
                    'lambda',
                    `/2015-03-31/functions/${prefix}-${service}-${name}/configuration`,
                    awsConfig,
                ),
            ),
        )
    }
}

async function deleteLambda(
    env: LocalEnv,
    agent: Agent,
    prefix: string,
    service: string,
    name: string,
) {
    console.log('deleting lambda ' + name)
    await throwOnNotOK(
        'Error deleting lambda ' + name,
        awsRequest(
            agent,
            env,
            'DELETE',
            'lambda',
            `/2015-03-31/functions/${prefix}-${service}-${name}`,
        ),
    )
}

function lambdaConfig(config: Config, role: string, environment: { [key: string]: string }) {
    return {
        Role: role,
        Runtime: 'nodejs16.x',
        Handler: 'index.handler',
        Timeout: config.timeout ?? 15,
        MemorySize: config.compute === 'high' || config.memory === 'high' ? 3008 : 128,
        TracingConfig: {
            Mode: 'PassThrough',
        },
        Environment: {
            Variables: environment,
        },
    }
}

function lambdaArchitecture(config: Config) {
    switch (
        resolveCpu(
            config,
            config.compute === 'high'
                ? ['x64', 'x32', 'arm64', 'arm']
                : ['arm64', 'arm', 'x64', 'x32'],
        )
    ) {
        case 'arm64':
        case 'arm':
            return ['arm64']
        case 'x64':
        case 'x32':
            return ['x86_64']
        default:
            throw new Error('Unsupported CPUs: ' + (config.cpus?.join(', ') ?? ''))
    }
}
