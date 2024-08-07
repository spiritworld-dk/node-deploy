import { missing } from '@riddance/fetch'
import { createPublicKey, generateKeyPairSync, randomBytes } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

export type Resolver = {
    getEnvironment(prefix: string, service: string): Promise<{ [key: string]: string }>
    getBaseUrl(prefix: string, service: string): Promise<string | undefined>
    prefetch(): Promise<void>
}

type Implementations = {
    [interfacePackage: string]: {
        implementation: string
        version: string
    }
}

export async function getGlue(path: string, prefix: string, resolver: Resolver, gluePath?: string) {
    const [packageJson, glueJson] = await Promise.all([
        readFile(join(path, 'package.json'), 'utf-8'),
        readFile(gluePath ?? join(path, '..', 'glue', `glue.${prefix}.json`), 'utf-8'),
    ])
    const { name: service } = JSON.parse(packageJson) as { name: string }
    const glue = JSON.parse(glueJson) as {
        implementations: Implementations
        telemetry: unknown
        websites: {
            [key: string]: string[]
        }
        services: {
            [key: string]: {
                cors?: string
                telemetry?: unknown
                env: { [key: string]: string }
                secrets: { [key: string]: string }
                implementations?: Implementations
                [provider: string]: unknown
            }
        }
        apps: {
            [key: string]: {
                name: string
                provider: 'vercel' | 'fly'
                githubRepo: string
                env: { [key: string]: string }
                secrets: { [key: string]: string }
                cors?: string
                implementations?: Implementations
                [provider: string]: unknown
            }
        }
    }

    const { telemetry, cors, env, secrets, implementations, ...provider } =
        glue.services[service] ?? glue.apps[service] ?? {}
    return {
        service,
        implementations: {
            ...glue.implementations,
            ...implementations,
        },
        telemetry: glue.telemetry ?? telemetry ?? {},
        corsSites: cors ? glue.websites[cors] ?? [] : [],
        env: resolveEnv(env ?? {}, secrets ?? {}, prefix, service, resolver),
        ...provider,
    }
}

const own = Symbol()

type Variable = {
    pattern: RegExp
    source: (match: RegExpMatchArray) => {
        environment?: string | typeof own
        baseUrl?: string
    }
    value: (
        prefix: string,
        service: string,
        match: RegExpMatchArray,
        key: string,
        environments: { [service: string]: { [key: string]: string } },
        baseUrls: { [service: string]: string | undefined },
    ) => string
}

const variables: Variable[] = [
    {
        pattern: /\$ENV/gu,
        source: () => ({}),
        value: prefix => prefix,
    },
    {
        pattern: /\$SERVICE/gu,
        source: () => ({}),
        value: (_prefix, service) => service,
    },
    {
        pattern: /\$PRIVATE_KEY\(([^)]+)\)/gu,
        source: () => ({ environment: own }),
        value: (_prefix, service, [_, curve], key, env) =>
            env[service]?.[key] ??
            // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
            generateKeyPairSync('ec', { namedCurve: curve! })
                .privateKey.export({ type: 'sec1', format: 'pem' })
                .toString()
                .split('\n')
                .slice(1, -2)
                .join(''),
    },
    {
        pattern: /\$ASK\(([^)]*)\)/gu,
        source: () => ({ environment: own }),
        value: (_prefix, service, [_, hint], key, env, _url) =>
            env[service]?.[key] ?? missing(`ASK implementation: ${hint}`),
    },
    {
        pattern: /\$RANDOM\(([0-9]+)\)/gu,
        source: () => ({ environment: own }),
        value: (_prefix, service, [_, bits], key, env, _url) =>
            env[service]?.[key] ?? randomBytes(Math.ceil(Number(bits) / 8)).toString('hex'),
    },
    {
        pattern: /\$SAME_AS\(([^,]+),([^)]+)\)/gu,
        source: match => ({ environment: match[1] }),
        value: (_prefix, _service, [, service, key], _key, env, _url) =>
            // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
            env[service!]?.[key!] ??
            '' ??
            variableError(
                // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
                `Variable ${key!} for ${service!} not found. Has it been deployed?`,
            ),
    },
    {
        pattern: /\$PUBLIC_KEY\(([^,]+),([^)]+)\)/gu,
        source: match => ({ environment: match[1] }),
        value: (_prefix, _service, [, service, key], _key, env) =>
            createPublicKey(
                `-----BEGIN EC PRIVATE KEY-----\n${
                    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
                    env[service!]?.[key!] ??
                    variableError(
                        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
                        `Private key for ${service!} not found. Has it been deployed?`,
                    )
                }\n-----END EC PRIVATE KEY-----\n`,
            )
                .export({ type: 'spki', format: 'pem' })
                .toString()
                .split('\n')
                .slice(1, -2)
                .join(''),
    },
    {
        pattern: /\$BASE_URL\(([^)]+)\)/gu,
        source: match => ({ baseUrl: match[1] }),
        value: (_prefix, _service, [_, service], _key, _env, url) =>
            // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
            url[service!] ??
            // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
            variableError(`Base URL for ${service!} not found. Has it been deployed?`),
    },
]

function variableError(message: string): never {
    throw new Error(message)
}

async function resolveEnv(
    clear: { [key: string]: string },
    secrets: { [key: string]: string },
    prefix: string,
    service: string,
    resolver: Resolver,
) {
    const env = {
        ...clear,
        ...secrets,
    }
    const referencedEnvironments: string[] = []
    const referencedBaseUrls: string[] = []
    const selfReferencing: { key: string; v: Variable; match: RegExpMatchArray }[] = []
    for (const [key, value] of Object.entries(env)) {
        for (const v of variables) {
            for (const match of value.matchAll(v.pattern)) {
                const source = v.source(match)
                const sourceEnvName = source.environment === own ? service : source.environment
                if (sourceEnvName && !referencedEnvironments.includes(sourceEnvName)) {
                    if (source.environment === service) {
                        selfReferencing.push({ key, v, match })
                    } else {
                        referencedEnvironments.push(sourceEnvName)
                    }
                }
                if (source.baseUrl && !referencedBaseUrls.includes(source.baseUrl)) {
                    referencedBaseUrls.push(source.baseUrl)
                }
            }
        }
    }
    await resolver.prefetch()
    const [environments, baseUrls] = await Promise.all([
        fetchEnvironments(prefix, referencedEnvironments, resolver),
        fetchBaseUrls(prefix, referencedBaseUrls, resolver),
    ])
    for (const v of variables) {
        for (const [key, value] of Object.entries(env)) {
            env[key] = value.replaceAll(v.pattern, (substring, ...matches: string[]) => {
                if (
                    selfReferencing.find(
                        r => r.key === key && r.v === v && r.match[0] === substring,
                    )
                ) {
                    return substring
                }
                return v.value(
                    prefix,
                    service,
                    [substring, ...matches],
                    key,
                    environments,
                    baseUrls,
                )
            })
        }
    }

    for (const ref of selfReferencing) {
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        env[ref.key] = env[ref.key]!.replaceAll(
            ref.v.pattern,
            (substring, ...matches: string[]) => {
                return ref.v.value(
                    prefix,
                    service,
                    [substring, ...matches],
                    ref.key,
                    { [service]: env },
                    baseUrls,
                )
            },
        )
    }

    return env
}

async function fetchEnvironments(prefix: string, services: string[], resolver: Resolver) {
    return Object.fromEntries(
        await Promise.all(
            services.map(async s => [s, await resolver.getEnvironment(prefix, s)] as const),
        ),
    )
}

async function fetchBaseUrls(prefix: string, services: string[], resolver: Resolver) {
    return Object.fromEntries(
        await Promise.all(
            services.map(async s => [s, await resolver.getBaseUrl(prefix, s)] as const),
        ),
    )
}
