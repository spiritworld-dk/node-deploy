import sha256 from '@aws-crypto/sha256-js'
import { SignatureV4 } from '@aws-sdk/signature-v4'
import { fetch } from '@riddance/fetch'
import { readFile } from 'node:fs/promises'
import { Agent } from 'node:https'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { setTimeout } from 'node:timers/promises'

export interface LocalEnv {
    AWS_REGION: string
    AWS_ACCESS_KEY_ID: string
    AWS_SECRET_ACCESS_KEY: string
    AWS_SESSION_TOKEN?: string
}

let cachedConfigLines: string[] | undefined

export async function localAwsEnv(region: string | undefined, profile: string): Promise<LocalEnv> {
    let { AWS_REGION, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY } = {
        AWS_REGION: region ?? process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION,
        AWS_ACCESS_KEY_ID: process.env.AWS_ACCESS_KEY_ID,
        AWS_SECRET_ACCESS_KEY: process.env.AWS_SECRET_ACCESS_KEY,
    }
    if (AWS_REGION && AWS_ACCESS_KEY_ID && AWS_SECRET_ACCESS_KEY) {
        return { AWS_REGION, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY }
    }
    const configLines =
        cachedConfigLines ??
        (
            await readFile(
                process.env.AWS_SHARED_CREDENTIALS_FILE ?? join(homedir(), '.aws', 'credentials'),
                'ascii',
            )
        )
            .split('\n')
            .map(line => line.trim())
            .filter(line => !!line && !line.startsWith('#'))
    // eslint-disable-next-line require-atomic-updates
    cachedConfigLines = configLines

    let sectionBeginIx = -1
    const section = `[${profile}]`
    sectionBeginIx = configLines.findIndex(line => line === section)
    if (sectionBeginIx === -1) {
        sectionBeginIx = configLines.findIndex(line => line === '[default]')
    }
    if (sectionBeginIx === -1) {
        throw new Error('Section not found.')
    }
    const sectionEndIx = configLines.findIndex(
        (line, ix) => ix > sectionBeginIx && line.startsWith('['),
    )
    const sectionLines = configLines
        .slice(sectionBeginIx + 1, sectionEndIx !== -1 ? sectionEndIx : undefined)
        .map(line => line.split('='))
        .map(([k, v]) => [k?.trim(), v?.trim()])
    AWS_REGION ??= sectionLines.find(([k]) => k === 'region')?.[1]
    AWS_ACCESS_KEY_ID = sectionLines.find(([k]) => k === 'aws_access_key_id')?.[1]
    AWS_SECRET_ACCESS_KEY = sectionLines.find(([k]) => k === 'aws_secret_access_key')?.[1]
    if (!AWS_REGION || !AWS_ACCESS_KEY_ID || !AWS_SECRET_ACCESS_KEY) {
        throw new Error('Incomplete AWS credentials file.')
    }
    return { AWS_REGION, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY }
}

export function awsRequest(
    agent: Agent,
    env: LocalEnv,
    method: string,
    service: string,
    path: string,
    body?: unknown,
) {
    return awsStringRequest(
        agent,
        env,
        method,
        service,
        path,
        body ? JSON.stringify(body) : '',
        'application/json',
    )
}

export function awsFormRequest(
    agent: Agent,
    env: LocalEnv,
    method: string,
    service: string,
    path: string,
    body: URLSearchParams,
) {
    return awsStringRequest(
        agent,
        env,
        method,
        service,
        path,
        body.toString(),
        'application/x-www-form-urlencoded',
    )
}

async function awsStringRequest(
    agent: Agent,
    env: LocalEnv,
    method: string,
    service: string,
    path: string,
    body: string,
    contentType: string,
) {
    const signer = new SignatureV4({
        service,
        region: service !== 'iam' ? env.AWS_REGION : 'us-east-1',
        sha256: sha256.Sha256,
        credentials: {
            accessKeyId: env.AWS_ACCESS_KEY_ID,
            secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
            sessionToken: env.AWS_SESSION_TOKEN,
        },
    })
    const uri = new URL(`https://${subdomain(service, env.AWS_REGION)}.amazonaws.com${path}`)
    const query: { [key: string]: string } = {}
    uri.searchParams.forEach((value, key) => {
        query[key] = value
    })
    const { headers } = await signer.sign({
        method,
        protocol: 'https:',
        hostname: uri.hostname,
        path: uri.pathname,
        query,
        headers: {
            host: uri.hostname,
            'content-type': contentType,
            accept: 'application/json',
        },
        body,
    })
    return await fetch(uri.toString(), {
        agent,
        method,
        headers,
        body: body || undefined,
    })
}

function subdomain(service: string, region: string) {
    switch (service) {
        case 'iam':
            return 'iam'
        default:
            return `${service}.${region}`
    }
}

export async function retry<T extends { url: string; text: () => Promise<string> }>(
    request: () => Promise<T>,
    when: (response: T) => number | undefined,
) {
    for (let attempts = 0; ; ++attempts) {
        const response = await request()
        const maxRetries = when(response)
        if (maxRetries === undefined || maxRetries <= attempts) {
            return response
        }
        console.log(`retrying #${attempts + 1}... (${response.url} -> ${await response.text()})`)
        await setTimeout(500)
    }
}

function statusCode<T>(e: T) {
    return (e as unknown as { statusCode?: number }).statusCode
}

export function isNotFound<T>(e: T) {
    return statusCode(e) === 404
}

export function isConflict<T>(e: T) {
    return statusCode(e) === 409
}

export async function retryConflict<T>(fn: () => Promise<T>): Promise<T> {
    const deadline = new Date()
    deadline.setUTCSeconds(deadline.getUTCSeconds() + 30)
    for (;;) {
        try {
            return await fn()
        } catch (e) {
            if (!isConflict(e) || new Date() > deadline) {
                throw e
            }
            await setTimeout(((Math.random() + 0.5) * 500) / 2)
        }
    }
}
