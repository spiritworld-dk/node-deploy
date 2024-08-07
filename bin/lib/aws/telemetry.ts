import { localAwsEnv, LocalEnv } from './lite.js'
import { type AlarmConfig, type MetricFilterConfig, setupAlarm } from './services/cloudwatch.js'
import { createLambda, getFunction, getFunctions, updateLambda, zip } from './services/lambda.js'
import { ensureTopic, makeStatementData } from './services/sns.js'
import { setTimeout } from 'node:timers/promises'
import { missing } from '@riddance/fetch'
import { fileURLToPath } from 'node:url'
import { join, dirname } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { addTrigger, deleteTrigger, getTriggers } from './services/triggers.js'
import { getRole } from './services/roles.js'
import { randomUUID } from 'node:crypto'
import { rollupAndMinify } from '../stage.js'
import { readFile } from 'node:fs/promises'

export async function setupTelemetry(
    prefix: string,
    service: string,
    template: string,
    eventType: 'errors',
    config?:
        | {
              alarm?: AlarmConfig
              metricFilter?: MetricFilterConfig
              endpoint?: string
          }
        | false,
) {
    if (!config) {
        return
    }

    try {
        if (!config.endpoint) {
            console.warn('invalid telemetry config.')
            return
        }
        console.log('setting up telemetry.')

        const env = await localAwsEnv(undefined, prefix)

        const listener = await setupListener(env, prefix, service, template, {
            SLACK_WEBHOOK_URL: config.endpoint ?? missing('telemetry endpoint'),
        })
        await setTimeout(1000)
        const topicArn = await ensureTopic(env, `${prefix}-${service}-${eventType}`, {
            protocol: 'lambda',
            endpoint: listener.id,
        })
        await ensureTrigger(
            env,
            prefix,
            service,
            listener,
            makeStatementData(listener.id, topicArn),
        )
        const functions = await getFunctions(env, prefix, service)
        for (const f of functions.filter(i => i.name !== listener.name)) {
            console.log(`setting up alarm for ${f.name}`)
            await setupAlarm(
                env,
                `/aws/lambda/${prefix}-${service}-${f.name}`,
                `${prefix}-${service}-${f.name}-${eventType}`,
                `${prefix}-${service}-${eventType}`,
                config,
                topicArn,
            )
        }
        return [listener.name]
    } catch (err) {
        console.warn('Error setting up telemetry', err)
        return undefined
    }
}

async function setupListener(
    env: LocalEnv,
    prefix: string,
    service: string,
    name: string,
    environment: { [k: string]: string },
) {
    const path = join(dirname(fileURLToPath(import.meta.url)), '../', 'templates')
    const listenerFunctionBody = await readFile(join(path, `${name}.js`), {
        encoding: 'utf-8',
    })
    const [bundled] = (await rollupAndMinify(
        { entry: () => listenerFunctionBody, patch: (code: string) => `/*global fetch*/${code}` },
        './',
        path,
        [name],
    )) as [{ code: string; fn: string }]
    const existing = await getFunction(env, prefix, service, name)
    const zipped = await zip(bundled.code)
    const role = await getRole(env, prefix, service)
    if (!existing) {
        return createLambda(
            env,
            prefix,
            name,
            service,
            role?.Arn ?? missing('Role'),
            { nodeVersion: '>=20' },
            environment,
            zipped,
        )
    }
    if (zipped.sha256 !== existing.hash || !isDeepStrictEqual(environment, existing.env)) {
        await updateLambda(
            env,
            prefix,
            name,
            service,
            role?.Arn ?? missing('Role'),
            { nodeVersion: '>=20' },
            existing,
            environment,
            zipped,
        )
    }
    return existing
}

export async function ensureTrigger(
    env: LocalEnv,
    prefix: string,
    service: string,
    func: { id: string; name: string },
    statement: ReturnType<typeof makeStatementData>,
) {
    const [trigger] = (await getTriggers(env, prefix, service, [func])) ?? []
    const [existing, ...rest] = trigger?.statements ?? []
    if (existing && rest.length > 0) {
        throw new Error('Weird')
    }
    if (!existing) {
        await addTrigger(env, prefix, service, func.name, randomUUID(), statement)
        return
    }
    const { Sid: _, ...current } = existing
    if (!isDeepStrictEqual(current, statement)) {
        await deleteTrigger(env, prefix, service, func.name, existing.Sid)
        await addTrigger(env, prefix, service, func.name, randomUUID(), statement)
    }
}
