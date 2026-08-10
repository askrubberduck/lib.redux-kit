import { getConfig } from '../config'
import { isEqual } from './diff'
import { Action, AsyncDispatch, Selector, WatchHandler } from '../types'

// Watcher plumbing for the component host. The store host attaches watchers to `store.subscribe`,
// which a component host has no equivalent of — its state lives in the hook. So the same two rules
// are implemented here against a per-mount map instead: fire on a real change, and never let a
// watcher break the dispatch that triggered it.

/** One registered watcher, in the shape a domain hands to a host. */
export type WatcherEntry<TState, TAction extends Action> = [
  string,
  [Selector<TState, TAction, any>, WatchHandler<any, TState, TAction>],
]

/** What both hosts hand a selector: the state, with `dispatch` merged in. */
const view = <TState, TAction extends Action>(state: TState, dispatch: AsyncDispatch<TAction>) =>
  ({ ...state, dispatch }) as TState & { dispatch: AsyncDispatch<TAction> }

/**
 * The watched values as of mount, so a watcher fires on a change rather than on arrival — the same
 * thing the store host does at the moment it attaches.
 */
export function seedWatchers<TState, TAction extends Action>(
  entries: WatcherEntry<TState, TAction>[],
  state: TState,
  dispatch: AsyncDispatch<TAction>,
): Map<string, unknown> {
  return new Map(entries.map(([key, [selector]]) => [key, selector(view(state, dispatch))]))
}

/**
 * Fires the watchers whose selected value changed, and records the new values.
 *
 * Every comparison and every write to `seen` happens before any handler runs, so two dispatches in
 * flight cannot interleave into a missed or a doubled fire. Handlers then run detached, and a throw
 * is logged rather than propagated: a watcher must never break the dispatch that triggered it, and
 * its value has already advanced, so it does not re-fire in a loop. Both choices match the store
 * host.
 */
export function notifyWatchers<TState, TAction extends Action>(
  entries: WatcherEntry<TState, TAction>[],
  seen: Map<string, unknown>,
  next: TState,
  dispatch: AsyncDispatch<TAction>,
): void {
  const fired: [WatchHandler<any, TState, TAction>, any, any][] = []

  for (const [key, [selector, handle]] of entries) {
    const value = selector(view(next, dispatch))
    const previous = seen.get(key)

    if (isEqual(previous, value)) {
      continue
    }

    seen.set(key, value)
    fired.push([handle, value, previous])
  }

  for (const [handle, value, previous] of fired) {
    Promise.resolve(handle(value, previous, dispatch, next)).catch((error: any) => {
      getConfig().logger.error('Unhandled error while calling watch handler', error?.message)
    })
  }
}
