import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

export async function getGlue(path: string, envName: string) {
    const [packageJson, glueJson] = await Promise.all([
        readFile(join(path, 'package.json'), 'utf-8'),
        readFile(join(path, '..', 'glue', 'glue.json'), 'utf-8'),
    ])
    const { name: service } = JSON.parse(packageJson) as { name: string }
    const glue = JSON.parse(
        glueJson.replaceAll('$SERVICE', service).replaceAll('$ENV', envName),
    ) as {
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
            }
        }
    }

    const cors = glue.services[service]?.cors
    return {
        service,
        implementations: {
            ...glue.implementations,
        },
        corsSites: cors ? glue.websites[cors] ?? [] : [],
        env: {
            ...glue.env,
            ...glue.services[service]?.env,
        },
    }
}
