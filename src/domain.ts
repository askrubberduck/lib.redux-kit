import { getConfig } from './config'
import { wrapAsyncDispatch, wrapVersionDispatch } from './dispatch'
import { hasChanges } from './internal/diff'
import { CLAIMED, SETTLE } from './internal/marks'
import {
  Action,
  AsyncAction,
  AsyncDispatch,
  Dispatch,
  ExtractAction,
  StoreMiddleware,
  RecomputeHandler,
  ReduceHandler,
  Selector,
  VersionedAction,
  WatchHandler,
} from './types'

/**
 * A domain owns one piece of state and everything that happens to it: how actions change it, what
 * async work they trigger, what is derived from it, and what should happen when it changes.
 *
 * It is the only unit in this kit. A global store hosts many domains on a shared action bus; a
 * component hosts one on a private bus. The domain itself does not know which, and every capability
 * runs under both — with one difference a definition has to be written for: a reaction and a
 * watcher receive the root state under a store and this domain's own state under a component, which
 * is what TRootState declares.
 *
 *   TState       this domain's own state
 *   TAction      the actions it folds — widen it to reduce over another domain's actions too
 *   TRootState   the state a reaction and a watcher observe. Defaults to TState, which is what a
 *                component-hosted domain sees; a store-hosted domain passes the root state.
 *   TRootAction  everything reachable by dispatch. Defaults to TAction.
 */
export type Domain<
  TState,
  TAction extends Action,
  TRootState = TState,
  TRootAction extends Action = TAction,
> = {
  readonly name: string
  readonly initial?: TState | (() => TState)

  /**
   * Synchronous state change for an action type.
   *
   * Returns a *partial* state, which is diffed before merging: when nothing actually changed the
   * existing state object comes back by reference, so `shallowEqual` selectors do not re-render.
   * `undefined` leaves state alone; `{}` is the explicit no-op. A constant partial works in place
   * of a function.
   */
  reduce: <TType extends TAction['type']>(
    type: TType | TType[],
    handler: ReduceHandler<TState, ExtractAction<TAction, TType>>,
  ) => void

  /**
   * Async work for an action type, run after the reduce.
   *
   * Receives `(action, dispatch, state)` — state last, and always passed. `await dispatch(...)`
   * resolves once the chain that action triggered has finished.
   */
  on: <TType extends TRootAction['type']>(
    type: TType | TType[],
    handler: (
      action: ExtractAction<TRootAction, TType> & VersionedAction,
      dispatch: AsyncDispatch<TRootAction>,
      state: TRootState,
    ) => Promise<any>,
  ) => void

  /** Recomputes values from this domain's own state after every reduce that changed something. */
  recompute: (handler: RecomputeHandler<TState>) => void

  /**
   * Reacts to a *state* change rather than an action. The selector re-runs on every change and
   * the handler fires only when its result differs by deep equality.
   *
   * Keys are global across the host, so a duplicate throws at registration rather than letting
   * one watcher silently shadow another.
   */
  watch: <T>(
    key: string,
    selector: Selector<TRootState, TRootAction, T>,
    handler: WatchHandler<T, TRootState, TRootAction>,
  ) => void

  /** Fallback for any reaction in this domain that throws. One per domain. */
  onError: (handler: (action: any, dispatch: AsyncDispatch<TRootAction>, error: any) => Promise<any>) => void

  /**
   * Host-facing plumbing. A host consumes these; application code never should.
   */
  readonly $: DomainInternals<TState, TRootState, TRootAction>
}

/**
 * What a host needs from a domain: its name and its plumbing.
 *
 * A host does not care about the shape of `reduce` or `react` — those are the authoring surface,
 * and their generics differ per domain, which makes a list of domains heterogeneous. Depending on
 * only this keeps a store's `domains` list assignable without weakening the authoring types.
 */
export type HostedDomain = {
  readonly name: string
  readonly $: DomainInternals<any, any, any>
}

export type DomainInternals<TState, TRootState, TRootAction extends Action> = {
  /**
   * redux-compatible reducer over this domain's own state, or undefined for a domain that owns
   * none — one that exists purely to react, which a store hosts without giving it a key.
   */
  reducer?: (state: TState | undefined, action: any) => TState
  /** Middleware running this domain's reactions, for a store-hosted domain. */
  middleware: StoreMiddleware<any, TRootState>
  /** Registered watchers, for the host to attach. */
  watchers: () => [string, [Selector<TRootState, TRootAction, any>, WatchHandler<any, TRootState, TRootAction>]][]
  /** Folds and reacts in one pass, for a component-hosted domain with no middleware chain. */
  runLocal: (current: TState, action: any, dispatch: AsyncDispatch<any>) => TState
  /** Resolves the configured seed. Called once per mount by a component host. */
  seed: () => TState
}

export function defineDomain<
  TState,
  TAction extends Action,
  TRootState = TState,
  TRootAction extends Action = TAction,
>(config: {
  /** The key this domain's state occupies in the host's state. */
  name: string
  /**
   * Starting state, or a factory when each host should get its own copy.
   *
   * Omit it for a domain that owns no state and exists only to react to other domains' actions.
   */
  initial?: TState | (() => TState)
}): Domain<TState, TAction, TRootState, TRootAction> {
  const { name, initial } = config

  const reduceHandlers = new Map<string, ReduceHandler<TState, any>>()
  const onHandlers = new Map<string, any>()
  const watchers = new Map<string, [Selector<TRootState, TRootAction, any>, WatchHandler<any, TRootState, TRootAction>]>()
  let recomputeHandler: RecomputeHandler<TState> | undefined
  let errorHandler: ((action: any, dispatch: AsyncDispatch<TRootAction>, error: any) => Promise<any>) | undefined

  const mount = (map: Map<string, any>, type: string | string[], handler: any, what: string) => {
    for (const t of Array.isArray(type) ? type : [type]) {
      // Almost always a mistake, and silent if allowed: one handler would simply win.
      if (map.has(t)) {
        throw new Error(`Unable to mount ${what} '${String(t)}' on domain '${name}': already exists`)
      }
      map.set(t, handler)
    }
  }

  const reduce: Domain<TState, TAction, TRootState, TRootAction>['reduce'] = (type, handler) =>
    mount(reduceHandlers, type as any, handler, 'reduce')

  const on: Domain<TState, TAction, TRootState, TRootAction>['on'] = (type, handler) =>
    mount(onHandlers, type as any, handler, 'reaction')

  const once = (what: string, taken: boolean, set: () => void) => {
    if (taken) {
      throw new Error(`Unable to mount ${what} on domain '${name}': already exists`)
    }
    set()
  }

  const recompute = (handler: RecomputeHandler<TState>) =>
    once('recompute', !!recomputeHandler, () => {
      recomputeHandler = handler
    })

  const watch: Domain<TState, TAction, TRootState, TRootAction>['watch'] = (key, selector, handler) => {
    if (watchers.has(key)) {
      throw new Error(`Unable to mount watcher '${key}': already exists`)
    }
    watchers.set(key, [selector, handler as WatchHandler<any, TRootState, TRootAction>])
  }

  const onError: Domain<TState, TAction, TRootState, TRootAction>['onError'] = handler =>
    once('onError', !!errorHandler, () => {
      errorHandler = handler
    })

  const seed = (): TState =>
    typeof initial === 'function' ? (initial as () => TState)() : (initial as TState)

  /**
   * The reduce, written once and used by both hosts: look the handler up, allow a constant partial,
   * treat `undefined` as no change, diff before merging, and recompute derived values only when
   * something actually moved.
   */
  const applyReduce = (state: TState, action: any): TState => {
    const handler = reduceHandlers.get(action.type)
    if (!handler) {
      return state
    }

    const next = typeof handler === 'function' ? handler(state, action) : handler
    if (next === undefined) {
      return state
    }

    if (!hasChanges(next as object, state as object)) {
      return state
    }

    const merged = { ...state, ...next }
    return recomputeHandler ? { ...merged, ...recomputeHandler(merged) } : merged
  }

  const reducer =
    initial === undefined ? undefined : (state: TState = seed(), action: any): TState => applyReduce(state, action)

  const runHandler = async (action: AsyncAction<any>, state: TRootState, dispatch: Dispatch<any>) => {
    const handler = onHandlers.get(action.type)
    if (!handler) {
      return
    }

    const versionDispatch = wrapVersionDispatch(
      wrapAsyncDispatch(dispatch) as unknown as AsyncDispatch<TRootAction>,
      action.__version,
    )

    try {
      await handler(action, versionDispatch, state)
    } catch (error: any) {
      if (errorHandler) {
        await errorHandler(action, versionDispatch, error)
      } else {
        getConfig().onUnhandledError(error, versionDispatch as AsyncDispatch<any>, action)
      }
    }
  }

  const middleware: StoreMiddleware<any, TRootState> = ({ dispatch, getState }) => next => async (action: AsyncAction<any>) => {
    const handled = onHandlers.has(action.type)

    try {
      // State is read before chaining onward, so a reaction observes the state as it was
      // *before* this action reached the folds.
      const state = handled ? getState() : (undefined as unknown as TRootState)
      try {
        if (!handled) {
          return
        }
        action[CLAIMED] = true
      } finally {
        next(action)
      }

      await runHandler(action, state, dispatch)
    } finally {
      // Release an awaiting dispatch. Actions nobody reacts to still settle, so `await
      // dispatch(...)` never hangs.
      if (handled || !action[CLAIMED]) {
        action[CLAIMED] = true
        action[SETTLE]?.()
      }
    }
  }

  const runLocal = (current: TState, action: any, dispatch: AsyncDispatch<any>): TState => {
    const next = applyReduce(current, action)

    if (onHandlers.has(action.type)) {
      // Deferred so the reduce has settled and the host holds the new state before work begins.
      void Promise.resolve().then(() => runHandler(action, next as unknown as TRootState, dispatch as Dispatch<any>))
    }

    const { debug, logger } = getConfig()
    if (debug) {
      logger.info(`${name}: ${action.type}`, next, action)
    }

    return next
  }

  return {
    name,
    initial,
    reduce,
    on,
    recompute,
    watch,
    onError,
    $: { reducer, middleware, watchers: () => [...watchers.entries()], runLocal, seed },
  }
}
