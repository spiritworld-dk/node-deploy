import { thrownHasStatus } from '@riddance/fetch'
import { SignatureV4 } from '@smithy/signature-v4'
import { Hash, Hmac, createHash, createHmac } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { setTimeout } from 'node:timers/promises'

export type LocalEnv = {
    AWS_REGION: string
    AWS_ACCESS_KEY_ID: string
    AWS_SECRET_ACCESS_KEY: string
    AWS_SESSION_TOKEN?: string
}

let cachedConfigLines: string[] | undefined

export async function localAwsEnv(region: string | undefined, profile: string): Promise<LocalEnv> {
    let { AWS_REGION, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_SESSION_TOKEN } = {
        AWS_REGION: region ?? process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION,
        AWS_ACCESS_KEY_ID: process.env.AWS_ACCESS_KEY_ID,
        AWS_SECRET_ACCESS_KEY: process.env.AWS_SECRET_ACCESS_KEY,
        AWS_SESSION_TOKEN: process.env.AWS_SESSION_TOKEN,
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
    AWS_SESSION_TOKEN = sectionLines.find(([k]) => k === 'aws_session_token')?.[1]
    if (!AWS_REGION || !AWS_ACCESS_KEY_ID || !AWS_SECRET_ACCESS_KEY) {
        throw new Error('Incomplete AWS credentials file.')
    }
    return { AWS_REGION, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_SESSION_TOKEN }
}

export function awsRequest(
    env: LocalEnv,
    method: string,
    service: string,
    path: string,
    body?: unknown,
    headers?: { [k: string]: string },
    contentType = 'application/json',
    checksum?: boolean,
) {
    const b = body ? (typeof body === 'string' ? body : JSON.stringify(body)) : ''
    return awsStringRequest(
        env,
        method,
        service,
        path,
        body ? JSON.stringify(body) : '',
        contentType,
        {
            ...headers,
            ...(checksum && {
                'Content-MD5': createContentHash(b),
            }),
        },
    )
}

export function createContentHash(body: string) {
    return createHash('md5').update(body).digest('base64')
}

export function awsFormRequest(
    env: LocalEnv,
    method: string,
    service: string,
    path: string,
    body: URLSearchParams,
) {
    return awsStringRequest(
        env,
        method,
        service,
        path,
        body.toString(),
        'application/x-www-form-urlencoded',
    )
}

async function awsStringRequest(
    env: LocalEnv,
    method: string,
    service: string,
    path: string,
    body: string,
    contentType: string,
    headers?: { [k: string]: string },
) {
    const signer = new SignatureV4({
        service,
        region: service !== 'iam' ? env.AWS_REGION : 'us-east-1',
        sha256: AwsHash,
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
    const { headers: signedHeaders } = await signer.sign({
        method,
        protocol: 'https:',
        hostname: uri.hostname,
        path: uri.pathname,
        query,
        headers: {
            host: uri.hostname,
            'content-type': contentType,
            accept: 'application/json',
            ...headers,
        },
        body,
    })
    return await fetch(uri.toString(), {
        method,
        headers: signedHeaders,
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

export function isNotFound(e: unknown) {
    return thrownHasStatus(e, 404)
}

export function isConflict(e: unknown) {
    return thrownHasStatus(e, 409)
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

type SourceData = string | ArrayBuffer | ArrayBufferView

class AwsHash {
    readonly #secret?: SourceData
    #hash: Hash | Hmac

    constructor(secret?: SourceData) {
        this.#secret = secret
        this.#hash = makeHash(this.#secret)
    }

    digest() {
        return Promise.resolve(this.#hash.digest())
    }

    reset() {
        this.#hash = makeHash(this.#secret)
    }

    update(chunk: Uint8Array) {
        this.#hash.update(new Uint8Array(Buffer.from(chunk)))
    }
}

function makeHash(secret?: SourceData) {
    return secret ? createHmac('sha256', castSourceData(secret)) : createHash('sha256')
}

function castSourceData(data: SourceData) {
    if (Buffer.isBuffer(data)) {
        return data
    }
    if (typeof data === 'string') {
        return Buffer.from(data)
    }
    if (ArrayBuffer.isView(data)) {
        return Buffer.from(data.buffer, data.byteOffset, data.byteLength)
    }
    return Buffer.from(data)
}
