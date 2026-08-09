import { getConfig } from './config'
import { Action, StateSource } from './types'

let registeredStore: StateSource<any, any> | null = null

/**
 * Dispatch from outside the component tree — an api client reacting to a 401, a navigation
 * container, a scheduled task.
 *
 * Late-bound on purpose: modules that import this do not import the store, which keeps the
 * dependency graph acyclic. The cost is that it **silently does nothing** before
 * `registerStore` has run. Anything dispatched during module initialisation is dropped.
 */
export const storeDispatch = <TAction extends Action>(action: TAction): void => {
  if (!registeredStore) {
    if (getConfig().warnOnUnregisteredDispatch) {
      getConfig().logger.error(
        `storeDispatch('${action?.type}') before registerStore — the action was dropped.`,
      )
    }
    return
  }

  registeredStore.dispatch(action)
}

/** Binds the store the `storeDispatch` escape hatch dispatches into. Call once, at startup. */
export const registerStore = <TState, TAction extends Action>(store: StateSource<TState, TAction>): void => {
  registeredStore = store
}

/** Reads the registered store, or null before registration. */
export const getRegisteredStore = (): StateSource<any, any> | null => registeredStore

/** Clears the registered store. Intended for tests. */
export const resetRegisteredStore = (): void => {
  registeredStore = null
}
