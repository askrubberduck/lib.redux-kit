import { getConfig } from '../config'
import { wrapAsyncDispatch } from '../dispatch'
import type { HostedDomain } from '../domain'
import { createSubscriptionMiddleware } from '../subscription-middleware'
import { versionMiddleware } from '../version'
import { isEqual } from './diff'
import { Action, Dispatch, Selector, StateSource, StoreMiddleware, Subscriber, WatchHandler } from '../types'

// The parts of hosting many domains on one shared action bus that do not depend on where the state
// actually lives: which domain owns which key, what order the middleware runs in, how a chain is
// composed, and how a watcher becomes a store subscriber. Both the redux host and the zustand host
// are these four functions plus a state container, which is why the two agree on semantics by
// construction rather than by two implementations being kept in step by hand.
//
// Nothing here imports a state library, so a host entry pulls in only its own.

/** A slice reducer, in the shape redux expects and a domain produces. */
export type SliceReducer = (state: any, action: any) => any

/** The action a host folds to obtain the starting state. No domain reduces it. */
export const INIT_ACTION = { type: '@@redux-kit/INIT' }

/**
 * The state shape, as a map of key to reducer: one entry per domain that owns state, plus any
 * slice the application brought itself.
 *
 * A domain with no state contributes reactions and watchers but takes no key. Two domains claiming
 * one name is a boot-time throw rather than a silent overwrite.
 */
export function collectReducers(
  domains: HostedDomain[],
  extra?: Record<string, SliceReducer>,
): Record<string, SliceReducer> {
  const reducers: Record<string, SliceReducer> = { ...extra }

  for (const domain of domains) {
    if (!domain.$.reducer) {
      continue
    }
    if (reducers[domain.name]) {
      throw new Error(`Unable to mount domain '${domain.name}': the name is already taken`)
    }
    reducers[domain.name] = domain.$.reducer as SliceReducer
  }

  return reducers
}

/**
 * The middleware chain, in the one order that works.
 *
 * Version stamping runs first, so every middleware downstream sees a numbered action; subscription
 * handling runs before anything that reacts to a payload. Everything else is the application's
 * call, which is why `place` receives the domains' reaction middleware rather than the chain being
 * assembled here.
 */
export function buildChain(
  domains: HostedDomain[],
  subscribers?: Subscriber<any, any, any>[],
  place?: (reactions: StoreMiddleware<any, any>[]) => StoreMiddleware<any, any>[],
): StoreMiddleware<any, any>[] {
  const reactions = domains.map(domain => domain.$.middleware)

  return [
    versionMiddleware as StoreMiddleware<any, any>,
    ...(subscribers?.length ? [createSubscriptionMiddleware<any, any, any>(...subscribers)] : []),
    ...(place ? place(reactions) : reactions),
  ]
}

/**
 * Composes a middleware chain over a base dispatch — redux's `applyMiddleware`, without redux.
 *
 * The dispatch each middleware is handed re-enters the *finished* chain, so an action a middleware
 * dispatches passes through every middleware again rather than resuming halfway down. That
 * indirection is why the placeholder below is needed: the api object is built before the chain it
 * closes over exists.
 *
 * The redux host does not use this — redux composes its own chain, and going through
 * `applyMiddleware` is what keeps store enhancers such as devtools working.
 */
export function applyChain<TState>(
  chain: StoreMiddleware<any, any>[],
  getState: () => TState,
  base: Dispatch<any>,
): Dispatch<any> {
  let dispatch: Dispatch<any> = () => {
    throw new Error('Unable to dispatch while the middleware chain is still being built')
  }

  const api = { getState, dispatch: (action: any) => dispatch(action) }
  dispatch = chain.map(middleware => middleware(api)).reduceRight<Dispatch<any>>((next, wrap) => wrap(next), base)

  return dispatch
}

/** What attaching watchers needs of a host: read state, dispatch into it, and hear about changes. */
export type WatchableStore<TState, TAction extends Action> = StateSource<TState, TAction> & {
  subscribe: (listener: () => void) => () => void
}

/**
 * Subscribes every domain's watchers. Watch keys are global to the host, so a collision across two
 * domains is a bug rather than a merge, and throws here at boot.
 */
export function attachWatchers<TState, TAction extends Action>(
  store: WatchableStore<TState, TAction>,
  domains: HostedDomain[],
): void {
  const attached = new Set<string>()

  for (const domain of domains) {
    for (const [key, [selector, handler]] of domain.$.watchers()) {
      if (attached.has(key)) {
        throw new Error(`Unable to attach watcher '${key}': the key is already taken`)
      }
      store.subscribe(createWatcher(store, selector, handler))
      attached.add(key)
    }
  }
}

/**
 * Turns a watcher registration into a store subscriber: re-run the selector, fire only on a real
 * change. Handler errors are swallowed and logged — a watcher must never break the dispatch that
 * triggered it, and its value still advances so it does not re-fire in a loop.
 *
 * Note the cost: the selector receives a fresh `{ ...state, dispatch }`, so each watcher spreads
 * the root state on every store notification.
 */
function createWatcher<T, TState, TAction extends Action>(
  store: WatchableStore<TState, TAction>,
  selector: Selector<TState, TAction, T>,
  handle: WatchHandler<T, TState, TAction>,
) {
  let current = selector({ ...store.getState(), dispatch: store.dispatch })
  const asyncDispatch = wrapAsyncDispatch(store.dispatch)

  return async () => {
    const state = store.getState()
    const next = selector({ ...state, dispatch: store.dispatch })

    if (!isEqual(current, next)) {
      const previous = current
      current = next
      try {
        await handle(next, previous, asyncDispatch, state)
      } catch (error: any) {
        getConfig().logger.error('Unhandled error while calling watch handler', error?.message)
      }
    }
  }
}
