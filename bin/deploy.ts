import { reflect } from '@riddance/host/reflect'
import { getCurrentState, sync } from './lib/aws/sync.js'
import { getGlue } from './lib/glue.js'
import { stage } from './lib/stage.js'

const [, , pathOrEnvArg, envArg] = process.argv
if (!pathOrEnvArg) {
    throw new Error('Please specify target environment name')
}
const path = envArg ? pathOrEnvArg : process.cwd()
const envName = envArg ? envArg : pathOrEnvArg

try {
    const { service, implementations, corsSites, env } = await getGlue(path, envName)

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
        env,
        Object.fromEntries(code.map(c => [c.fn, c.code])),
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
