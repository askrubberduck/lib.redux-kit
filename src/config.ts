import { Action, AsyncDispatch } from './types'

export type Logger = {
  debug: (...args: any[]) => void
  info: (...args: any[]) => void
  error: (...args: any[]) => void
}

export type Settings = {
  /** Where the kit reports its own diagnostics. Defaults to silence. */
  logger: Logger
  /** Enables per-action logging in local stores. Defaults to false. */
  debug: boolean
  /**
   * Last-resort handler for an exception thrown by an effect that registered no
   * `handleException`. Defaults to logging the error.
   *
   * Host applications typically surface the failure here, e.g. by dispatching whatever action
   * their notification layer listens for.
   */
  onUnhandledError: (error: any, dispatch: AsyncDispatch<any>, action: Action) => void
  /**
   * Logs when `storeDispatch` is called before `registerStore`, where the action is dropped.
   * Off by default so existing consumers see no change; worth enabling in development, since
   * the failure is otherwise completely silent.
   */
  warnOnUnregisteredDispatch: boolean
}

const noopLogger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  error: () => undefined,
}

const defaults: Settings = {
  logger: noopLogger,
  debug: false,
  onUnhandledError: (error, _dispatch, action) => {
    defaults.logger.error('Unhandled error in effect handler', action?.type, error)
  },
  warnOnUnregisteredDispatch: false,
}

let current: Settings = { ...defaults }

/**
 * Injects host application concerns. Call once during startup, before the store is created.
 * Partial updates are merged, so callers can set only what they need.
 */
export function configure(config: Partial<Settings>): void {
  current = { ...current, ...config }
}

export function getConfig(): Readonly<Settings> {
  return current
}

/** Restores defaults. Intended for tests. */
export function resetConfig(): void {
  current = { ...defaults }
}
