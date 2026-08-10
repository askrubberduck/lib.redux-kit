import {
  applyMiddleware,
  combineReducers,
  legacy_createStore as reduxCreateStore,
  Middleware,
  Reducer,
  StoreEnhancer,
} from 'redux'
import { attachWatchers, buildChain, collectReducers } from './internal/host'
import { registerStore } from './registry'
import { HostedDomain } from './domain'
import { Action, StoreMiddleware, StateSource, Subscriber } from './types'

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

  const reducerMap = collectReducers(domains, reducers as Record<string, any> | undefined)
  const chain = buildChain(domains, adapters.subscribers, middleware)

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
