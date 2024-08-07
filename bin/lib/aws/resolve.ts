import { localAwsEnv } from './lite.js'
import { fetchApis, getApiEndpoint } from './services/apiGateway.js'
import { fetchFunctions, getFunctions } from './services/lambda.js'

export class Resolver {
    readonly #env

    constructor(prefix: string) {
        this.#env = localAwsEnv(undefined, prefix)
    }

    async prefetch() {
        await Promise.all([fetchFunctions(await this.#env), fetchApis(await this.#env)])
    }

    async getEnvironment(prefix: string, service: string): Promise<{ [key: string]: string }> {
        const functions = await getFunctions(await this.#env, prefix, service)
        return Object.fromEntries(functions.flatMap(fn => Object.entries(fn.env)))
    }

    async getBaseUrl(prefix: string, service: string): Promise<string | undefined> {
        return ((await getApiEndpoint(await this.#env, prefix, service)) ?? '') + '/'
    }
}
