export function compare<T extends { name: string }, S extends { name: string }>(
    local: T[],
    current: S[],
) {
    const missing = local.filter(fn => current.every(remote => remote.name !== fn.name))
    const surplus = current.filter(remote => local.every(fn => remote.name !== fn.name))
    const existing = current.filter(remote => local.some(fn => remote.name === fn.name))
    const duplicates = existing.filter(
        (remote, ix) => existing.findIndex(e => e.name === remote.name) !== ix,
    )
    surplus.push(...duplicates)
    return { missing, surplus, existing: existing.filter(remote => !duplicates.includes(remote)) }
}
