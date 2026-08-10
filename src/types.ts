import { CLAIMED, SETTLE } from './internal/marks'

/** Minimal action contract: everything in this kit keys off a string `type`. */
export type Action = { type: string }

/**
 * Actions carry two counters, both stamped by the kit rather than by their author.
 *
 * `__version` is a monotonic sequence number for the action itself.
 * `__requestVersion` is the `__version` of the action that *caused* this one, so a slow
 * response can be matched back to the intent that triggered it and discarded when a newer
 * intent has already superseded it.
 *
 * Both are **1-based and never 0**, which makes a falsy check a reliable test for absence:
 * `!action.__requestVersion` means no cause was recorded, and cannot be confused with a cause
 * that happened to be the first action of the process.
 */
export type VersionedAction = Action & { __version?: number; __requestVersion?: number }

/** An action carrying the kit's in-flight bookkeeping. See `internal/marks`. */
export type AsyncAction<TAction extends Action> = TAction & {
  [SETTLE]?: () => void
  [CLAIMED]?: boolean
}

/** Narrow a discriminated action union to the member with a given `type`. */
export type ExtractAction<TAction extends Action, TType extends TAction['type']> = Extract<TAction, { type: TType }>

/**
 * A reducer handler. Either a function of the current state and action, or a constant partial
 * used as the next state. Returning `undefined` leaves the state untouched; returning `{}` is
 * the idiomatic explicit no-op.
 */
export type ReduceHandler<TState, TAction extends Action> =
  | Partial<TState>
  | void
  | ((state: TState, action: TAction & VersionedAction) => Partial<TState> | void)

/** Recomputes values from state after every reduce that changed something. */
export type RecomputeHandler<TState> = (state: TState) => Partial<TState> | void

/**
 * An action on its way out.
 *
 * `__requestVersion` is accepted alongside the action's own fields so a root intent can be
 * re-attached by hand at a hop that would otherwise reset it to the immediate cause. Nothing else
 * from `VersionedAction` is: `__version` is issued by the host and taking one from a caller would
 * let two actions share a number.
 */
export type Dispatched<TAction extends Action> = TAction & { __requestVersion?: number }

export type Dispatch<TAction extends Action> = (action: Dispatched<TAction>) => void

export type AsyncDispatch<TAction extends Action> = (action: Dispatched<TAction>) => Promise<void>

export type MiddlewareAPI<TAction extends Action, TState> = {
  dispatch: Dispatch<TAction>
  getState(): TState
}

/**
 * The middleware shape this kit produces. Structurally compatible with redux's own
 * middleware, but declared locally so the kit does not depend on redux.
 */
export type StoreMiddleware<TAction extends Action, TState> = (
  api: MiddlewareAPI<TAction, TState>,
) => (next: Dispatch<TAction>) => (action: any) => any

/**
 * Reads a value out of the store for a watcher. `dispatch` is merged into the argument so a
 * selector can build a value that closes over it.
 */
export type Selector<TState, TAction extends Action, T = unknown> = (
  state: TState & { dispatch: Dispatch<TAction> },
) => T

export type WatchHandler<T, TState, TAction extends Action> = (
  newValue: Readonly<T>,
  oldValue: Readonly<T>,
  dispatch: AsyncDispatch<TAction>,
  state: TState,
) => any

/** A store object a watcher can read from and dispatch to. */
export type StateSource<TState, TAction extends Action> = {
  dispatch: Dispatch<TAction>
  getState: () => TState
}

/**
 * Declares one subscription channel: its key, the variables needed to open it, and the shape
 * of the payloads it delivers. `id` distinguishes concurrent subscriptions on the same key.
 */
export type Subscription = {
  key: string
  id?: string
  variables?: unknown
  payload: unknown
}

/**
 * The subscription transport, declared structurally so any observable satisfying this shape
 * works and the kit needs no GraphQL client dependency.
 */
export type ObservableLike<T> = {
  subscribe(observer: {
    start?: (subscription: any) => void
    next: (value: T) => void
    error: (error: any) => void
    complete: () => void
  }): SubscriptionHandle
}

export type SubscriptionHandle = {
  unsubscribe(): void
  readonly closed: boolean
}

/** A delivered subscription result: payload plus any non-fatal errors reported alongside it. */
export type ResultLike<T> = {
  data?: T | null
  errors?: readonly any[] | null
}

export type Subscriber<TSubscription extends Subscription, TState, TAction extends Action> = {
  subscribe: (
    key: TSubscription['key'],
    variables: TSubscription['variables'],
    getState: () => TState,
  ) => ObservableLike<ResultLike<TSubscription['payload']>> | undefined
  handle: (
    key: TSubscription['key'],
    payload: TSubscription['payload'],
    dispatch: Dispatch<TAction>,
    getState: () => TState,
  ) => any
}

/**
 * The four reserved actions the subscription middleware owns. Add this to a root action union
 * to make them dispatchable from anywhere.
 *
 * The conditional is not a no-op: it makes the type **distributive**, so a union of subscription
 * declarations yields one action shape per member and each keeps its own `key`/`variables`/
 * `payload` pairing. Collapse it and the pairing is lost — one shape with every key unioned
 * against every variables type, which type-checks a SUBSCRIBE that mixes two channels.
 */
export type SubscriptionAction<TSubscription extends Subscription> = TSubscription extends {
  key: TSubscription['key']
}
  ?
      | {
          type: 'SUBSCRIBE'
          key: TSubscription['key']
          id?: TSubscription['id']
          variables: TSubscription['variables']
          force?: boolean
        }
      | { type: 'UNSUBSCRIBE'; key: TSubscription['key']; id?: TSubscription['id'] }
      | { type: 'UNSUBSCRIBE_ALL' }
      | {
          type: 'SUBSCRIPTION_PAYLOAD'
          key: TSubscription['key']
          payload: TSubscription['payload']
          id?: TSubscription['id']
        }
  : never
