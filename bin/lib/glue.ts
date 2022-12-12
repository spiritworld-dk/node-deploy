import { createPublicKey, generateKeyPairSync, randomBytes } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

export interface Resolver {
    getEnvironment(prefix: string, service: string): Promise<{ [key: string]: string }>
    getBaseUrl(prefix: string, service: string): Promise<string | undefined>
}

export async function getGlue(path: string, prefix: string, resolver: Resolver, gluePath?: string) {
    const [packageJson, glueJson] = await Promise.all([
        readFile(join(path, 'package.json'), 'utf-8'),
        readFile(gluePath ?? join(path, '..', 'glue', 'glue.json'), 'utf-8'),
    ])
    const { name: service } = JSON.parse(packageJson) as { name: string }
    const glue = JSON.parse(glueJson) as {
        implementations: {
            [interfacePackage: string]: {
                implementation: string
                version: string
            }
        }
        env: { [key: string]: string }
        websites: {
            [key: string]: string[]
        }
        services: {
            [key: string]: {
                cors?: string
                env: { [key: string]: string }
                secrets: { [key: string]: string }
                [provider: string]: unknown
            }
        }
    }

    const { cors, env, secrets, ...provider } = glue.services[service] ?? {}
    return {
        service,
        implementations: {
            ...glue.implementations,
        },
        corsSites: cors ? glue.websites[cors] ?? [] : [],
        env: resolveEnv(
            {
                ...glue.env,
                ...env,
            },
            secrets ?? {},
            prefix,
            service,
            resolver,
        ),
        ...provider,
    }
}

interface Variable {
    pattern: RegExp
    source: (
        match: RegExpMatchArray,
        self: string,
    ) => {
        environment?: string
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
        source: (_match, self) => ({ environment: self }),
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
        pattern: /\$RANDOM\(([0-9]+)\)/gu,
        source: (_match, self) => ({ environment: self }),
        value: (_prefix, service, [_, bits], key, env, _url) =>
            env[service]?.[key] ?? randomBytes(Math.ceil(Number(bits) / 8)).toString('hex'),
    },
    {
        pattern: /\$SAME_AS\(([^,]+),([^)]+)\)/gu,
        source: match => ({ environment: match[1] }),
        value: (_prefix, _service, [, service, key], _key, env, _url) =>
            // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
            env[service!]?.[key!] ??
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
    for (const value of Object.values(env)) {
        for (const v of variables) {
            for (const match of value.matchAll(v.pattern)) {
                const s = v.source(match, service)
                if (s.environment && !referencedEnvironments.includes(s.environment)) {
                    referencedEnvironments.push(s.environment)
                }
                if (s.baseUrl && !referencedBaseUrls.includes(s.baseUrl)) {
                    referencedBaseUrls.push(s.baseUrl)
                }
            }
        }
    }
    const [environments, baseUrls] = await Promise.all([
        fetchEnvironments(prefix, referencedEnvironments, resolver),
        fetchBaseUrls(prefix, referencedBaseUrls, resolver),
    ])
    for (const v of variables) {
        for (const [key, value] of Object.entries(env)) {
            env[key] = value.replaceAll(v.pattern, (substring, ...matches: string[]) => {
                const s = v.value(
                    prefix,
                    service,
                    [substring, ...matches],
                    key,
                    environments,
                    baseUrls,
                )
                return s
            })
        }
    }
    return env
}

async function fetchEnvironments(prefix: string, services: string[], resolver: Resolver) {
    return Object.fromEntries(
        await Promise.all(
            services.map(async s => pair(s, await resolver.getEnvironment(prefix, s))),
        ),
    )
}

async function fetchBaseUrls(prefix: string, services: string[], resolver: Resolver) {
    return Object.fromEntries(
        await Promise.all(services.map(async s => pair(s, await resolver.getBaseUrl(prefix, s)))),
    )
}

function pair<T, S>(a: T, b: S) {
    return [a, b] as [T, S]
}
