import { createStore as createVanillaStore, StoreApi } from 'zustand/vanilla'
import { applyChain, attachWatchers, buildChain, collectReducers, INIT_ACTION, SliceReducer } from './internal/host'
import { registerStore } from './registry'
import { HostedDomain } from './domain'
import { Action, Dispatch, StateSource, StoreMiddleware, Subscriber } from './types'

// Lives behind the '@askrubberduck/redux-kit/zustand' subpath because it is the one part that needs
// zustand. It is a peer of the redux host, not a replacement: the same domain definitions, the same
// middleware chain in the same order, the same watcher semantics — a different state container.
//
// What makes the port small is that a domain never knew which host it was under. `$.reducer` is a
// plain `(state, action) => state`, and `$.middleware` is redux's middleware *shape* declared
// locally in `types.ts` rather than imported from redux, so both compose here unchanged.
//
// Two things zustand gives that redux does not: `setState` skips notifying subscribers when the
// next root state is reference-equal to the current one, which pairs exactly with a fold that
// returns the same object when nothing moved; and `useStore(store, selector)` needs no Provider.

/** Anything that translates an outside stream into dispatched actions. */
export type Adapters = {
  /** Subscription sources, from `createSubscriptions`. The store owns their lifecycle. */
  subscribers?: Subscriber<any, any, any>[]
  /** Always-on message routers, from `createMessageRouter`. Bound once at startup. */
  routers?: { listen: (dispatch: any, getState: any) => void }[]
}

export type ZustandStoreOptions<TState, TAction extends Action> = {
  /** Every domain this store hosts. Each contributes its state, folds, reactions and watchers. */
  domains: HostedDomain[]
  /**
   * The middleware chain, given the domains' reaction middleware to place. Version stamping and
   * subscription handling are placed for you, for the same reasons as under the redux host.
   */
  middleware?: (reactions: StoreMiddleware<any, any>[]) => StoreMiddleware<any, any>[]
  adapters?: Adapters
  /** Slices not owned by a domain definition — a third-party reducer, say. */
  reducers?: Record<string, SliceReducer>
  preloadedState?: Partial<TState>
}

/**
 * A zustand store with `dispatch` on it.
 *
 * It is a real `StoreApi`, so `useStore`, `subscribeWithSelector` and the rest of zustand's own
 * surface work on it unchanged — including `setState`, which writes state without going through a
 * fold and is therefore the one door out of the model. Reach for it only in a test.
 */
export type ZustandStore<TState, TAction extends Action> = StoreApi<TState> & {
  dispatch: Dispatch<TAction>
}

/**
 * Hosts many domains on one shared action bus over a zustand store, for the lifetime of the
 * session.
 *
 * Same order of operations as the redux host, and for the same reasons: create, attach watchers,
 * bind routers, then register for `storeDispatch` — anything dispatched through that escape hatch
 * before the last step is silently dropped.
 */
export function createZustandStore<TState, TAction extends Action>(
  options: ZustandStoreOptions<TState, TAction>,
): ZustandStore<TState, TAction> {
  const { domains, middleware, adapters = {}, reducers, preloadedState } = options

  const reducerMap = collectReducers(domains, reducers)
  const store = createVanillaStore<TState>(() => seedState<TState>(reducerMap, preloadedState))

  // The bottom of the chain: fold every slice, then hand the result to zustand whole. `replace` is
  // true because a fold already produced the complete next state, and zustand's own shallow merge
  // would otherwise re-add a key a reducer had deliberately dropped.
  const base: Dispatch<any> = action => {
    store.setState(current => rootReduce(reducerMap, current, action), true)
  }

  const dispatch = applyChain<TState>(buildChain(domains, adapters.subscribers, middleware), store.getState, base)
  const host = Object.assign(store, { dispatch }) as ZustandStore<TState, TAction>

  attachWatchers(host, domains)

  for (const router of adapters.routers ?? []) {
    router.listen(host.dispatch, host.getState)
  }

  registerStore(host as StateSource<any, any>)

  return host
}

/**
 * The starting state: every slice folded once over an action no domain reduces, so each falls back
 * to its own seed. A preloaded slice is passed in as the current state instead, which is how a
 * reducer's default parameter lets it through untouched.
 */
function seedState<TState>(reducers: Record<string, SliceReducer>, preloaded?: Partial<TState>): TState {
  const state: Record<string, unknown> = {}

  for (const key of Object.keys(reducers)) {
    state[key] = reducers[key]((preloaded as Record<string, unknown> | undefined)?.[key], INIT_ACTION)
  }

  return state as TState
}

/**
 * Folds every slice and returns the **same root object by reference** when no slice moved.
 *
 * That is not an optimisation, it is the contract the rest of the kit is written against: a fold
 * returns the existing state when a partial changed nothing, and zustand skips notifying its
 * subscribers when `setState` produces a reference-equal state. Build a fresh root object here and
 * every `useStore` in the tree re-renders on every action nobody reduced.
 */
function rootReduce<TState>(reducers: Record<string, SliceReducer>, state: TState, action: any): TState {
  let next: Record<string, unknown> | undefined

  for (const key of Object.keys(reducers)) {
    const current = (state as Record<string, unknown>)[key]
    const value = reducers[key](current, action)

    if (value !== current) {
      next ??= { ...(state as Record<string, unknown>) }
      next[key] = value
    }
  }

  return (next as TState) ?? state
}
