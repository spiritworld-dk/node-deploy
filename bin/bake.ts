import { Resolver } from './lib/aws/resolve.js'
import { getGlue } from './lib/glue.js'
import { writeFile } from 'node:fs/promises'
import { gzipSync } from 'node:zlib'
import { join } from 'node:path'

const [, , pathOrEnvArg, envArg, compressOrGlueFileArg, glueFileArg] = process.argv
if (!pathOrEnvArg) {
    throw new Error('Please specify target environment name')
}
const path = envArg ? pathOrEnvArg : process.cwd()
const envName = envArg ? envArg : pathOrEnvArg
const glueFile = glueFileArg
    ? glueFileArg
    : compressOrGlueFileArg !== '--compress'
      ? compressOrGlueFileArg
      : undefined

try {
    const resolver = new Resolver(envName)

    const { env } = await getGlue(path, envName, resolver, glueFile)

    await writeFile(
        join(path, '.env'),
        makeEnvFilePayload(await env, compressOrGlueFileArg === '--compress'),
        'utf-8',
    )

    console.log('baked.')
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

export function makeEnvFilePayload(variables: { [k: string]: string }, compress = false) {
    if (compress) {
        return `COMPRESSED_ENV=${gzipSync(JSON.stringify(variables), { level: 9 }).toString(
            'base64',
        )}`
    }
    return Object.entries(variables)
        .map(([name, value]) => {
            return `${name}=${value}`
        })
        .join('\n')
}
