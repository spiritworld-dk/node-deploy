import { Agent } from 'node:https'
import { localAwsEnv } from './lite.js'
import { getApi } from './services/apiGateway.js'
import { getFunctions } from './services/lambda.js'

const agent = new Agent({
    keepAlive: true,
    maxSockets: 4,
})

export class Resolver {
    #env

    constructor(prefix: string) {
        this.#env = localAwsEnv(undefined, prefix)
    }

    async getEnvironment(prefix: string, service: string): Promise<{ [key: string]: string }> {
        const functions = await getFunctions(await this.#env, agent, prefix, service)
        return Object.fromEntries(functions.flatMap(fn => Object.entries(fn.env)))
    }

    async getBaseUrl(prefix: string, service: string): Promise<string | undefined> {
        const api = await getApi(await this.#env, agent, prefix, service)
        return (api.api?.apiEndpoint ?? '') + '/'
    }
}
