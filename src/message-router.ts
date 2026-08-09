import { Action, Dispatch } from './types'

/**
 * The transport a message router binds to: a persistent bus that routes messages by type.
 * A socket client satisfies this shape.
 */
export type MessageTransport<TMessage extends { type: string }> = {
  listen: <TType extends TMessage['type']>(type: TType, callback: (payload: any) => void) => void
}

/**
 * Routes messages from a persistent bus into dispatches.
 *
 * Deliberately *not* the same mechanism as `createSubscriptions`, despite the family
 * resemblance. A subscription is opened and closed per key with variables and has a lifecycle
 * the kit manages; a message router binds once to an always-on bus and has none. Collapsing
 * them would mean inventing a lifecycle the transport does not have.
 *
 * ARITY RULE: the handler receives state only when it declares three parameters.
 */
export function createMessageRouter<
  TMessage extends { type: string },
  TAction extends Action,
  TState = unknown,
>(transport: MessageTransport<TMessage>) {
  const handlers = new Map<TMessage['type'], any>()

  const handle = <TType extends TMessage['type']>(
    type: TType,
    handler: (payload: any, dispatch: Dispatch<TAction>, state: TState) => any,
  ) => {
    if (handlers.has(type)) {
      throw new Error(`Unable to mount message handler '${String(type)}': Handler already exists`)
    }
    handlers.set(type, handler)
  }

  /** Binds every registered handler to the transport. Call once, when the store is created. */
  const listen = (dispatch: Dispatch<TAction>, getState: () => TState) => {
    handlers.forEach((handler, type) => {
      transport.listen(type, payload => {
        const state = handler.length >= 3 ? getState() : undefined
        handler(payload, dispatch, state)
      })
    })
  }

  return { handle, listen }
}
