export function compare<T extends { name: string }, S extends { name: string }>(
    local: T[],
    current: S[],
) {
    const missing = local.filter(
        fn => current.find(remote => remote.name === fn.name) === undefined,
    )
    const surplus = current.filter(
        remote => local.find(fn => remote.name === fn.name) === undefined,
    )
    const existing = current.filter(
        remote => local.find(fn => remote.name === fn.name) !== undefined,
    )
    return { missing, surplus, existing }
}
