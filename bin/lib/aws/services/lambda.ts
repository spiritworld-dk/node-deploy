import { jsonResponse, okResponse, thrownHasStatus } from '@riddance/fetch'
import { PackageJsonConfiguration, Reflection, resolveCpu } from '@riddance/host/reflect'
import JSZip from 'jszip'
import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { compare } from '../diff.js'
import { LocalEnv, awsRequest, retry, retryConflict } from '../lite.js'
import { setTimeout } from 'node:timers/promises'

export async function syncLambda(
    env: LocalEnv,
    prefix: string,
    currentFunctions: AwsFunctionLite[],
    reflection: Reflection,
    environment: { [key: string]: string },
    role: string,
    code: { [name: string]: string },
    safeList: string[] = [],
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
    await Promise.all(
        surplus
            .filter(el => !safeList.includes(el.name))
            .map(fn => deleteLambda(env, prefix, reflection.name, fn.name)),
    )
    await Promise.all(
        existing.map(awsFn =>
            updateLambda(
                env,
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

export async function zip(code: string) {
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
export type AwsFunctionLite = {
    id: string
    name: string
    runtime: string
    memory: number
    timeout: number
    env: { [key: string]: string }
    cpus: Architectures
    hash: string
}

type AwsFunction = {
    Description: string
    TracingConfig: {
        Mode: 'PassThrough'
    }
    RevisionId: string
    LastModified: string
    FunctionArn: string
    FunctionName: string
    Runtime: 'nodejs18.x' | 'nodejs20.x'
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

export async function getFunction(env: LocalEnv, prefix: string, service: string, name: string) {
    const fnPrefix = `${prefix}-${service}-`.toLowerCase()
    try {
        const { Configuration: fn } = await jsonResponse<{ Configuration: AwsFunction }>(
            awsRequest(env, 'GET', 'lambda', `/2015-03-31/functions/${prefix}-${service}-${name}`),
            `Error getting function: ${name}`,
        )
        return {
            id: fn.FunctionArn,
            name: fn.FunctionName.substring(fnPrefix.length),
            runtime: fn.Runtime,
            memory: fn.MemorySize,
            timeout: fn.Timeout,
            env: fn.Environment?.Variables ?? {},
            cpus: fn.Architectures,
            hash: fn.CodeSha256,
        }
    } catch (err) {
        if (thrownHasStatus(err, 404)) {
            return undefined
        }
        throw err
    }
}

const cachedFunctions: AwsFunction[] = []

export async function fetchFunctions(env: LocalEnv) {
    if (cachedFunctions.length === 0) {
        let marker = ''
        for (;;) {
            try {
                const page = await jsonResponse<{
                    Functions: AwsFunction[]
                    NextMarker: string | null
                }>(
                    awsRequest(env, 'GET', 'lambda', `/2015-03-31/functions/?${marker}`),
                    'Error listing functions',
                )
                cachedFunctions.push(
                    ...page.Functions.filter(
                        f => !cachedFunctions.some(c => c.FunctionArn === f.FunctionArn),
                    ),
                )
                if (page.NextMarker === null) {
                    break
                }
                marker = `Marker=${encodeURIComponent(page.NextMarker)}`
            } catch (err) {
                if (thrownHasStatus(err, 429)) {
                    await setTimeout(1000)
                    continue
                }
                throw err
            }
        }
    }
    return cachedFunctions
}

export async function getFunctions(
    env: LocalEnv,
    prefix: string,
    service: string,
): Promise<AwsFunctionLite[]> {
    const fnPrefix = `${prefix}-${service}-`.toLowerCase()
    return (await fetchFunctions(env))
        .filter(fn => fn.FunctionName.startsWith(fnPrefix))
        .map(fn => ({
            id: fn.FunctionArn,
            name: fn.FunctionName.substring(fnPrefix.length),
            runtime: fn.Runtime,
            memory: fn.MemorySize,
            timeout: fn.Timeout,
            env: fn.Environment?.Variables ?? [],
            cpus: fn.Architectures,
            hash: fn.CodeSha256,
        }))
}

type Config = {
    memory?: string
    compute?: string
    timeout?: number
} & PackageJsonConfiguration

export async function createLambda(
    env: LocalEnv,
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
    const response = await jsonResponse<{ FunctionArn: string }>(
        retry(
            () =>
                awsRequest(env, 'POST', 'lambda', '/2015-03-31/functions', {
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
        'Error creating lambda ' + name,
    )
    return { name, id: response.FunctionArn }
}

export async function updateLambda(
    env: LocalEnv,
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
        await okResponse(
            awsRequest(
                env,
                'PUT',
                'lambda',
                `/2015-03-31/functions/${prefix}-${service}-${name}/code`,
                {
                    ZipFile: code.zipped,
                    Architectures: cpus,
                },
            ),
            'Error updating code for lambda ' + name,
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
            okResponse(
                awsRequest(
                    env,
                    'PUT',
                    'lambda',
                    `/2015-03-31/functions/${prefix}-${service}-${name}/configuration`,
                    awsConfig,
                ),
                'Error updating config for lambda ' + name,
            ),
        )
    }
}

async function deleteLambda(env: LocalEnv, prefix: string, service: string, name: string) {
    console.log('deleting lambda ' + name)
    await okResponse(
        awsRequest(env, 'DELETE', 'lambda', `/2015-03-31/functions/${prefix}-${service}-${name}`),
        'Error deleting lambda ' + name,
    )
}

function lambdaConfig(config: Config, role: string, environment: { [key: string]: string }) {
    return {
        Role: role,
        Runtime: getRuntime(config),
        Handler: 'index.handler',
        Timeout: config.timeout ?? 30,
        MemorySize: config.compute === 'high' || config.memory === 'high' ? 3008 : 512,
        TracingConfig: {
            Mode: 'PassThrough',
        },
        Environment: {
            Variables: environment,
        },
    }
}

function getRuntime(config: Config) {
    switch (config.nodeVersion?.substring(0, 4)) {
        case '>=20':
            return 'nodejs20.x'
        case '>=18':
            return 'nodejs18.x'
        default:
            throw new Error(
                'Unsupported engine; please specify either "node": ">=18" or "node": ">=20" as an engine in your package.json.',
            )
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
