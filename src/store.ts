import {
  applyMiddleware,
  combineReducers,
  legacy_createStore as reduxCreateStore,
  Middleware,
  Reducer,
  StoreEnhancer,
} from 'redux'
import { getConfig } from './config'
import { wrapAsyncDispatch } from './dispatch'
import { isEqual } from './internal/diff'
import { registerStore } from './registry'
import { HostedDomain } from './domain'
import { createSubscriptionMiddleware } from './subscription-middleware'
import { versionMiddleware } from './version'
import { Action, StoreMiddleware, StateSource, Selector, Subscriber, WatchHandler } from './types'

// Lives behind the '@askrubberduck/redux-kit/store' subpath because it is the one part that needs redux
// itself. The root entry stays dependency-free, so a consumer using only domains and a component
// host never pulls redux in.

/** Anything that translates an outside stream into dispatched actions. */
export type Adapters = {
  /** Subscription sources, from `createSubscriptions`. The store owns their lifecycle. */
  subscribers?: Subscriber<any, any, any>[]
  /** Always-on message routers, from `createMessageRouter`. Bound once at startup. */
  routers?: { listen: (dispatch: any, getState: any) => void }[]
}

export type StoreOptions<TState, TAction extends Action> = {
  /**
   * Every domain this store hosts. Each contributes its state, folds, reactions and watchers.
   *
   * Typed as `HostedDomain` rather than `Domain`: a list of domains is heterogeneous by nature —
   * each names a different state and action union — and depending on the authoring signatures
   * would make the list unassignable. A host needs only the name and the plumbing.
   */
  domains: HostedDomain[]
  /**
   * The middleware chain, given the domains' reaction middleware to place.
   *
   * Order has consequences, so it stays at the call site rather than being assembled here. Two
   * pieces are placed for you because they have only one correct position: version stamping runs
   * first, and subscription handling before anything that reacts to a payload.
   */
  middleware?: (reactions: StoreMiddleware<any, any>[]) => StoreMiddleware<any, any>[]
  adapters?: Adapters
  /** Wraps the middleware enhancer, e.g. devtools composition in development. */
  enhancer?: (middlewareEnhancer: StoreEnhancer) => StoreEnhancer
  /** Slices not owned by a domain definition — a third-party reducer, say. */
  reducers?: Record<string, Reducer<any, any>>
  preloadedState?: Partial<TState>
}

export type Store<TState, TAction extends Action> = StateSource<TState, TAction> & {
  subscribe: (listener: () => void) => () => void
}

/**
 * Hosts many domains on one shared action bus, for the lifetime of the session.
 *
 * Performs the wiring whose order is not a choice: create, attach watchers, bind routers, then
 * register for `storeDispatch`. Registering last matters — anything dispatched through that
 * escape hatch beforehand is silently dropped.
 */
export function createStore<TState, TAction extends Action>(
  options: StoreOptions<TState, TAction>,
): Store<TState, TAction> {
  const { domains, middleware, adapters = {}, enhancer, reducers, preloadedState } = options

  const reducerMap: Record<string, Reducer<any, any>> = { ...reducers }
  for (const domain of domains) {
    // A domain with no state contributes reactions and watchers but takes no key.
    if (!domain.$.reducer) {
      continue
    }
    if (reducerMap[domain.name]) {
      throw new Error(`Unable to mount domain '${domain.name}': the name is already taken`)
    }
    reducerMap[domain.name] = domain.$.reducer as Reducer<any, any>
  }

  const reactions = domains.map(s => s.$.middleware)
  const chain: StoreMiddleware<any, any>[] = [
    versionMiddleware as StoreMiddleware<any, any>,
    ...(adapters.subscribers?.length ? [createSubscriptionMiddleware<any, any, any>(...adapters.subscribers)] : []),
    ...(middleware ? middleware(reactions) : reactions),
  ]

  const middlewareEnhancer = applyMiddleware(...(chain as unknown as Middleware[]))

  // Cast: combineReducers cannot prove a map built at runtime matches TState. It is built from
  // the same domains TState is written from, and a mismatch surfaces as an undefined domain at the
  // first selector that reads it.
  const store = reduxCreateStore(
    combineReducers<TState>(reducerMap as any) as any,
    preloadedState as any,
    (enhancer ? enhancer(middlewareEnhancer) : middlewareEnhancer) as any,
  ) as unknown as Store<TState, TAction>

  attachWatchers(store, domains)

  for (const router of adapters.routers ?? []) {
    router.listen(store.dispatch, store.getState)
  }

  registerStore(store as StateSource<any, any>)

  return store
}

/**
 * Subscribes every domain's watchers. Watch keys are global to the store, so a collision across
 * two domains is a bug rather than a merge, and throws here at boot.
 */
function attachWatchers<TState, TAction extends Action>(store: Store<TState, TAction>, domains: HostedDomain[]): void {
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
  store: Store<TState, TAction>,
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
