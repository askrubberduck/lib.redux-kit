import { getConfig } from './config'
import {
  Action,
  Dispatch,
  StoreMiddleware,
  ObservableLike,
  ResultLike,
  Subscriber,
  Subscription,
  SubscriptionHandle,
} from './types'

/**
 * Owns every open subscription, keyed by `key` or `key:id`.
 *
 * Install it in the middleware chain and it takes over five reserved action types:
 *   SUBSCRIBE               open a channel, or no-op if already open unless `force`
 *   UNSUBSCRIBE             close one channel
 *   UNSUBSCRIBE_ALL         close everything, e.g. on sign-out
 *   SUBSCRIPTION_PAYLOAD    a delivered payload, fanned out to every registered subscriber
 *
 * Delivery failures re-subscribe rather than surfacing: an `errors` array on a payload and a
 * transport-level error both trigger a forced re-subscribe, while `complete` closes the
 * channel and drops it from the map.
 */
export function createSubscriptionMiddleware<TSubscription extends Subscription, TState, TAction extends Action>(
  ...subscribers: Subscriber<TSubscription, TState, TAction>[]
) {
  const subscriptions = new Map<string, SubscriptionHandle>()

  const keyOf = (key: TSubscription['key'], id: TSubscription['id']) => (id ? `${key}:${id}` : key)

  function subscribe(
    key: TSubscription['key'],
    id: TSubscription['id'],
    open: () => ObservableLike<ResultLike<TSubscription['payload']>> | undefined,
    dispatch: Dispatch<TAction>,
    force = false,
  ) {
    const { logger } = getConfig()

    const stream = open()
    if (!stream) {
      return
    }

    const keyId = keyOf(key, id)

    if (subscriptions.has(keyId)) {
      if (!force) {
        logger.debug('subscription already open, ignoring', keyId)
        return
      }
      unsubscribe(key, id)
    }
    logger.debug('opening subscription', keyId)

    const handle = stream.subscribe({
      start: () => {
        logger.debug('subscription acknowledged by the transport', keyId)
      },
      next: result => {
        logger.debug('subscription delivered a payload', keyId)

        if (result.data) {
          dispatch({ type: 'SUBSCRIPTION_PAYLOAD', key, id, payload: result.data } as any)
        }
        if (result.errors?.length) {
          logger.error('payload carried errors, reopening', keyId, result.errors)
          subscribe(key, id, open, dispatch, true)
        }
      },
      error: (error: any) => {
        logger.error('transport failed, reopening', keyId, error)
        subscribe(key, id, open, dispatch, true)
      },
      complete: () => {
        logger.debug('transport closed the subscription', keyId)
        unsubscribe(key, id)
      },
    })

    subscriptions.set(keyId, handle)
  }

  const unsubscribe = (key: TSubscription['key'], id: TSubscription['id']) => {
    const keyId = keyOf(key, id)

    const handle = subscriptions.get(keyId)
    if (!handle) {
      return
    }
    if (!handle.closed) {
      getConfig().logger.debug('closing subscription', keyId)
      handle.unsubscribe()
    }
    subscriptions.delete(keyId)
  }

  const unsubscribeAll = () => {
    for (const [keyId, handle] of subscriptions.entries()) {
      if (!handle.closed) {
        getConfig().logger.debug('closing every subscription', keyId)
        handle.unsubscribe()
      }
      subscriptions.delete(keyId)
    }
  }

  const middleware: StoreMiddleware<TAction, TState> =
    ({ dispatch, getState }) =>
    next =>
    async (action: any) => {
      next(action)

      switch (action.type) {
        case 'SUBSCRIBE': {
          subscribers.forEach(s => {
            subscribe(
              action.key,
              action.id,
              () => s.subscribe?.(action.key, action.variables, getState),
              dispatch,
              action.force,
            )
          })
          break
        }
        case 'UNSUBSCRIBE': {
          unsubscribe(action.key, action.id)
          break
        }
        case 'UNSUBSCRIBE_ALL': {
          unsubscribeAll()
          break
        }
        case 'SUBSCRIPTION_PAYLOAD': {
          subscribers.forEach(s => {
            s.handle?.(action.key, action.payload, dispatch, getState)
          })
          break
        }
      }
    }

  return middleware
}
