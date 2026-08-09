export type Deferred = {
  promise: Promise<void>
  resolve: () => void
}

/** A promise plus the handle that settles it from elsewhere. */
export const deferred = (): Deferred => {
  let resolve!: () => void
  const promise = new Promise<void>(r => {
    resolve = r
  })

  return { promise, resolve }
}
