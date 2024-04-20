import commonjs from '@rollup/plugin-commonjs'
import json from '@rollup/plugin-json'
import { nodeResolve } from '@rollup/plugin-node-resolve'
import virtual from '@rollup/plugin-virtual'
import { rollup, RollupCache, SourceMap } from '@rollup/wasm-node'
import { createHash } from 'node:crypto'
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import zlib from 'node:zlib'
// eslint-disable-next-line camelcase
import { minify_sync } from 'terser'
import { install } from './npm.js'

type Implementation = {
    implementation: string
    version: string
}

const aws = {
    entry: (fn: string) => `
import './${fn}.js'
import { awsHandler } from '@riddance/aws-host/http'

export const handler = awsHandler
`,
    patch: (code: string) => `/*global fetch AbortController*/${code}`,
}

export async function stage(
    path: string,
    implementations: { [fromPackage: string]: Implementation },
    service: string,
) {
    const stagePath = join(tmpdir(), 'riddance', 'stage', service)
    console.log(`stage dir: ${stagePath}`)
    console.log('staging...')
    const { functions, hashes } = await copyAndPatchProject(path, stagePath, implementations)

    console.log('syncing dependencies...')
    await install(stagePath)
    hashes['package-lock.json'] = createHash('sha256')
        .update(await readFile(join(stagePath, 'package-lock.json')))
        .digest('base64')

    let previous: { [source: string]: string } = {}
    try {
        previous = JSON.parse(await readFile(join(stagePath, '.hashes.json'), 'utf-8')) as {
            [source: string]: string
        }
    } catch (e) {
        if ((e as { code?: string }).code !== 'ENOENT') {
            throw e
        }
    }

    const packageChange =
        previous['package.json'] !== hashes['package.json'] ||
        previous['package-lock.json'] !== hashes['package-lock.json']

    const hashesJson = JSON.stringify(hashes, undefined, '  ')
    const changed = []
    const unchanged = []
    for (const fn of functions) {
        const file = fn + '.js'
        if (previous[file] !== hashes[file] || packageChange) {
            changed.push(fn)
        } else {
            unchanged.push(fn)
        }
        delete previous[file]
        delete hashes[file]
    }
    const nonFunctionFilesUnchanged = isDeepStrictEqual(previous, hashes)
    if (nonFunctionFilesUnchanged) {
        const code = [
            ...(await rollupAndMinify(aws, path, stagePath, changed)),
            ...(await Promise.all(
                unchanged.map(async fn => ({
                    fn,
                    code: await readFile(join(stagePath, fn + '.min.js'), 'utf-8'),
                })),
            )),
        ]
        await writeFile(join(stagePath, '.hashes.json'), hashesJson)
        return code
    } else {
        const code = await rollupAndMinify(aws, path, stagePath, functions)
        await writeFile(join(stagePath, '.hashes.json'), hashesJson)
        return code
    }
}

async function copyAndPatchProject(
    path: string,
    target: string,
    implementations: { [fromPackage: string]: Implementation },
) {
    const hashes: { [source: string]: string } = {}
    const sourceFiles = (await find(path)).map(f => f.substring(path.length + 1))
    const serviceFiles = sourceFiles.filter(f => f.endsWith('.js') && !f.includes('/'))

    for (const sf of sourceFiles) {
        hashes[sf] = await mkDirCopyFile(join(path, sf), join(target, sf), implementations)
    }

    const packageFile = join(target, 'package.json')
    const packageJson = JSON.parse(await readFile(packageFile, 'utf-8')) as {
        name: string
        config?: unknown
        dependencies: { [packageName: string]: string }
        devDependencies?: unknown
    }

    for (const [pkg, sub] of Object.entries(implementations)) {
        if (packageJson.dependencies[pkg]) {
            delete packageJson.dependencies[pkg]
            packageJson.dependencies[sub.implementation] = sub.version
        }
    }
    delete packageJson.devDependencies

    const updated = JSON.stringify(packageJson)
    hashes['package.json'] = createHash('sha256').update(updated).digest('base64')
    await writeFile(packageFile, updated)

    return { functions: serviceFiles.map(f => f.substring(0, f.length - 3)), hashes }
}

async function mkDirCopyFile(
    source: string,
    target: string,
    implementations: { [fromPackage: string]: Implementation },
) {
    let code = await readFile(source, 'utf-8')
    for (const [fromPackage, toPackage] of Object.entries(implementations)) {
        code = code.replaceAll(
            new RegExp(
                `import \\{ ([^}]+) \\} from '${fromPackage.replaceAll('/', '\\/')}(|/[^']+)';`,
                'gu',
            ),
            `import { $1 } from '${toPackage.implementation}$2';`,
        )
    }
    try {
        await writeFile(target, code)
    } catch {
        await mkdir(dirname(target), { recursive: true })
        await writeFile(target, code)
    }
    return createHash('sha256').update(code).digest('base64')
}

async function find(dir: string): Promise<string[]> {
    let results: string[] = []
    let i = 0
    for (;;) {
        const list = (await readdir(dir)).filter(
            f =>
                !f.startsWith('.') &&
                !f.endsWith('.ts') &&
                !f.endsWith('.gz') &&
                !f.endsWith('.min.js') &&
                f !== 'tsconfig.json' &&
                f !== 'dictionary.txt' &&
                f !== 'node_modules' &&
                f !== 'test' &&
                f !== 'bin',
        )
        let file = list[i++]
        if (!file) {
            return results
        }
        file = dir + '/' + file
        const stats = await stat(file)
        if (stats.isDirectory()) {
            results = results.concat(await find(file))
        } else {
            results.push(file)
        }
    }
}

type Host = {
    entry: (fn: string) => string
    patch?: (bundled: string) => string
}

async function rollupAndMinify(host: Host, _path: string, stagePath: string, functions: string[]) {
    const minified = []
    let rollupCache: RollupCache | undefined
    for (const fn of functions) {
        const bundler = await rollup({
            input: 'entry',
            cache: rollupCache,
            treeshake: {
                correctVarValueBeforeDeclaration: false,
                propertyReadSideEffects: false,
                unknownGlobalSideEffects: false,
                moduleSideEffects: true,
            },
            plugins: [
                // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-explicit-any
                (virtual as any)({
                    entry: aws.entry(fn),
                }),
                nodeResolve({
                    exportConditions: ['node'],
                    rootDir: stagePath,
                }),
                // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-explicit-any
                (commonjs as any)(),
                // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-explicit-any
                (json as any)(),
            ],
            onwarn: warning => {
                if (warning.code === 'THIS_IS_UNDEFINED') {
                    return
                }
                console.warn(`${warning.code ?? warning.message} [${fn}]`)
                if (
                    warning.code === 'CIRCULAR_DEPENDENCY' &&
                    warning.ids &&
                    warning.ids.length !== 0
                ) {
                    console.warn(warning.ids.map(p => relative(stagePath, p)).join(' -> '))
                }
            },
        })
        rollupCache = bundler.cache
        const { output } = await bundler.generate({
            format: 'cjs',
            compact: true,
            sourcemap: true,
            manualChunks: () => 'entry.js',
            generatedCode: {
                preset: 'es2015',
                arrowFunctions: true,
                constBindings: true,
                objectShorthand: true,
            },
        })
        if (output.length !== 2) {
            console.log(output[2])
            throw new Error('Weird')
        }
        if (output[1]?.type !== 'asset' || output[1].fileName !== '_virtual_entry.js.map') {
            console.log(output[2])
            throw new Error('Weird')
        }
        const [{ code, map }] = output
        if (!map || map.version !== 3) {
            throw new Error('Source map missing.')
        }
        minified.push(pack(host, stagePath, fn, code, { ...map, version: 3 }))
    }
    return await Promise.all(minified)
}

async function pack(
    host: Host,
    stagePath: string,
    fn: string,
    source: string,
    map: SourceMap & { version: 3 },
) {
    console.log(`minifying ${fn}`)
    // eslint-disable-next-line camelcase
    const min = minify_sync(
        { [`${fn}.js`]: source },
        {
            compress: {
                module: true,
                ecma: 2015,
                // eslint-disable-next-line camelcase
                hoist_funs: true,
                // eslint-disable-next-line camelcase
                booleans_as_integers: true,
            },
            mangle: {
                module: true,
            },
            sourceMap: {
                content: map,
                filename: `${fn}.js.map`,
            },
            format: {
                ecma: 2020,
                comments: false,
            },
        },
    )
    if (!min.code) {
        throw new Error('Weird')
    }
    const code = host.patch ? host.patch(min.code) : min.code
    console.log(`${fn} minified`)
    await Promise.all([
        writeFile(join(stagePath, fn + '.min.js'), code),
        writeFile(
            join(stagePath, fn + '.min.js.map.gz'),
            await gzip(min.map as unknown as ArrayBufferLike),
        ),
    ])

    return { fn, code }
}

function gzip(data: ArrayBufferLike) {
    return new Promise<Buffer>((resolve, reject) => {
        zlib.gzip(data, { level: 9 }, (err, buf) => {
            if (err) {
                reject(err)
                return
            }
            resolve(buf)
        })
    })
}
