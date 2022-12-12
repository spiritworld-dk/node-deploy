import { reflect } from '@riddance/host/reflect'
import { Resolver } from './lib/aws/resolve.js'
import { getCurrentState, sync } from './lib/aws/sync.js'
import { getGlue } from './lib/glue.js'
import { stage } from './lib/stage.js'

const [, , pathOrEnvArg, envArg, glueFile] = process.argv
if (!pathOrEnvArg) {
    throw new Error('Please specify target environment name')
}
const path = envArg ? pathOrEnvArg : process.cwd()
const envName = envArg ? envArg : pathOrEnvArg

try {
    const resolver = new Resolver()
    const { service, implementations, corsSites, env, ...provider } = await getGlue(
        path,
        envName,
        resolver,
        glueFile,
    )

    const [currentState, reflection, code] = await Promise.all([
        getCurrentState(envName, service),
        reflect(path),
        stage(path, implementations, service),
    ])

    const host = await sync(
        envName,
        service,
        currentState,
        reflection,
        corsSites,
        await env,
        Object.fromEntries(code.map(c => [c.fn, c.code])),
        provider,
    )

    console.log('done.')

    console.log(`hosting on ${host}`)
} catch (e) {
    const fileError = e as { code?: string; path?: string }
    if (fileError.code === 'ENOENT' && fileError.path?.endsWith('glue.json')) {
        console.error(
            "Glue not found. Try to see if there isn't a glue project you can clone next to this project.",
        )
        // eslint-disable-next-line no-process-exit
        process.exit(1)
    }
    throw e
}
