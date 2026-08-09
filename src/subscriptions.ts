import {
  Action,
  Dispatch,
  ObservableLike,
  ResultLike,
  Subscriber,
  Subscription,
  SubscriptionAction,
} from './types'

type ExtractSubscription<TSubscription extends Subscription, TKey extends TSubscription['key']> = Extract<
  TSubscription,
  { key: TKey }
>

/**
 * Declares one module's subscription channels. Each channel binds a key to two things: a
 * factory that opens the stream, and a handler for the payloads it delivers.
 *
 * This only *declares* channels. Nothing opens until the object returned here is passed to
 * `createSubscriptionMiddleware`, which owns the actual subscription handles and their
 * lifecycle.
 *
 * ARITY RULE, in two positions — state is fetched only when the function asks for it:
 *   the factory receives state when it declares two parameters;
 *   the handler receives state when it declares three.
 * A function-level default or rest parameter lowers `Function.length` and silently yields
 * `undefined` state.
 */
export function createSubscriptions<
  TSubscription extends Subscription,
  TState = unknown,
  TAction extends Action = SubscriptionAction<TSubscription>,
>() {
  const factories = new Map<
    TSubscription['key'],
    (variables: any, state: TState) => ObservableLike<ResultLike<any>> | undefined
  >()
  const handlers = new Map<TSubscription['key'], (payload: any, dispatch: Dispatch<TAction>, state: TState) => any>()

  const subscriber: Subscriber<TSubscription, TState, TAction> = {
    subscribe: (key, variables, getState) => {
      const factory = factories.get(key)
      if (!factory) {
        return undefined
      }

      let state: any
      if (factory.length === 2) {
        state = getState()
      }
      return factory(variables, state)
    },
    handle: async (key, payload, dispatch, getState) => {
      const handler = handlers.get(key)
      if (!handler) {
        return
      }

      let state: any
      if (handler.length === 3) {
        state = getState()
      }

      await handler(payload, dispatch, state)
    },
  }

  const handle = <TKey extends TSubscription['key'], TSub extends ExtractSubscription<TSubscription, TKey>>(
    key: TKey,
    factory: (variables: TSub['variables'], state: TState) => ObservableLike<ResultLike<TSub['payload']>> | undefined,
    handler: (payload: TSub['payload'], dispatch: Dispatch<TAction>, state: TState) => Promise<any>,
  ) => {
    if (handlers.has(key)) {
      throw new Error(`Unable to mount subscription handler '${String(key)}': Handler already exists`)
    }
    handlers.set(key, handler)
    factories.set(key, factory as any)
  }

  return { handle, subscriber }
}
