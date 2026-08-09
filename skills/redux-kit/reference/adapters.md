# Adapters

Connecting an outside source to a store — GraphQL subscriptions, socket messages, a read-only
analytics tap.

An adapter turns something outside the store into a dispatched action. Three of them, chosen by
what the outside thing looks like.

| Source | Adapter |
|---|---|
| a channel opened per key, with variables and a lifecycle | `createSubscriptions` |
| an always-on bus that routes by message type | `createMessageRouter` |
| the action stream itself, observed and never changed | `createAuditMiddleware` |

(`createDispatchRegistry` routes an action the other way — back into a component instance. It
lives in [component.md](component.md).)

## Subscriptions

Declare the channels, bind each key to a stream factory and a payload handler, then hand the
subscriber to the store — which owns opening, closing and retrying.

```ts
// store/cart/subscriptions.ts
import { createSubscriptions } from '@askrubberduck/redux-kit'
import { CartAction } from './action'
import { RootState } from '../types'

export type CartSubscriptions = {
  key: 'CART_PRICE_UPDATES'
  id?: string
  variables: { sku: string }
  payload: { priceChanged: { sku: string; price: number } }
}

const { handle, subscriber } = createSubscriptions<CartSubscriptions, RootState, CartAction>()

handle(
  'CART_PRICE_UPDATES',
  variables => api.subscribeToPrice(variables),
  async (payload, dispatch) => {
    dispatch({ type: 'CART_PRICE_CHANGED', ...payload.priceChanged })
  },
)

export { subscriber }
```

Add `SubscriptionAction<RootSubscriptions>` to the root action union so the reserved actions are
dispatchable: `SUBSCRIBE`, `UNSUBSCRIBE`, `UNSUBSCRIBE_ALL`, and `SUBSCRIPTION_PAYLOAD`. You dispatch the first three; the middleware dispatches the fourth
when a payload arrives.

```tsx
useEffect(() => {
  if (!sku) return
  dispatch({ type: 'SUBSCRIBE', key: 'CART_PRICE_UPDATES', id: sku, variables: { sku } })
  return () => dispatch({ type: 'UNSUBSCRIBE', key: 'CART_PRICE_UPDATES', id: sku })
}, [sku])
```

The `id` is what lets several components subscribe to one key at once; without it they collide
on a single channel.

Behaviour worth knowing: a duplicate `SUBSCRIBE` is a no-op unless it carries `force`, so firing
it from a re-rendering component is harmless. A payload carrying `errors`, and a transport-level
error, both trigger an automatic forced re-subscribe — you do not write retry logic. `complete`
closes the channel and forgets it. Payloads fan out to every registered subscriber.

Any observable works: the stream is typed structurally, so a GraphQL client satisfies it with no
adapter, as does anything exposing `subscribe({ next, error, complete })` returning
`{ unsubscribe, closed }`.

**The arity rule lives here.** Both the factory and the handler receive state *only if they
declare the parameter* — `factory.length === 2`, `handler.length === 3`. A function-level default
parameter lowers that count and silently costs you state; a default inside a destructuring
pattern is fine.

## Message routers

For an always-on bus. No keys, no variables, no lifecycle — bound once at startup.

```ts
// store/cart/listen.ts
import { createMessageRouter } from '@askrubberduck/redux-kit'
import { CartAction } from './action'
import { CartMessage, socket } from '../stream'
import { RootState } from '../types'

const { handle, listen } = createMessageRouter<CartMessage, CartAction, RootState>(socket)

handle('PRICE_TICK', (payload, dispatch) => {
  dispatch({ type: 'CART_PRICE_CHANGED', sku: payload.sku, price: payload.price })
})

export { listen }
```

Re-export `listen` from the module barrel and hand the **module** to the store:

```ts
import * as cart from './cart'

const routers = [cart]
// adapters: { routers }
```

The store calls `.listen(dispatch, getState)` on each entry, so anything carrying a `listen` works
— the module namespace, or the router object itself. What does not work is passing `listen` on its
own: the store has no way to call a bare function it cannot find by name.

The transport is anything with `listen(type, callback)`. Nothing binds until the store does it, so
a module that ships a router the store was never given stays silent — a real state a codebase
drifts into, and one nothing will warn you about.

This is deliberately *not* the same mechanism as a subscription, despite the resemblance:
collapsing them would mean inventing a lifecycle the bus does not have.


## Audit taps

A read-only tap for analytics and telemetry. It receives the action and a live `getState`, and no
dispatch: a tap that can dispatch is not a tap.

```ts
// store/analytics/index.ts
import { createAuditMiddleware } from '@askrubberduck/redux-kit'
import { RootState } from '../types'
import { mapAction } from './map'
import { IncomingActions } from './types'

export function createAnalyticsMiddleware() {
  return createAuditMiddleware<IncomingActions, RootState>((action, getState) => {
    // Analytics must never be able to break a dispatch, so the callback swallows its own
    // failures. The kit deliberately does not, so this stays one consumer's choice.
    try {
      const event = mapAction(action, getState)
      if (event) {
        track(event)
      }
    } catch {
      // reported elsewhere
    }
  })
}
```

Place it after the reactions: `middleware: reactions => [...reactions, createAnalyticsMiddleware()]`.
Unlike a reaction — which sees pre-reduce state — an audit tap runs after the folds, so
`getState()` returns the post-action value.

Type it against **the actions it actually maps**, not `RootAction`. A narrow `IncomingActions`
union makes the mapping exhaustive-checkable and makes an action the tap forgot a compile error
rather than a silent gap.

Keep the mapping in its own module. An audit tap that grows branching logic is a reaction wearing
a disguise.

## Testing adapters

`@askrubberduck/redux-kit/testing` ships `makeStream()` and `makeTransport()` — controllable stand-ins
satisfying the same structural contracts, so a subscription or router can be tested without a
real client.

```ts
const { stream, emit, fail, complete, counts } = makeStream<CartPayload>()
// hand `stream` back from the factory under test, then drive it:
emit({ priceChanged: { sku: 'a', price: 5 } })   // deliver a payload
fail(new Error('socket died'))                    // transport error → forced re-subscribe
complete()                                        // channel closes and is forgotten
counts()                                          // { subscribeCount, unsubscribeCount }
```

`counts()` is how you assert the lifecycle: that a duplicate `SUBSCRIBE` did *not* open a second
channel, or that an error did re-open one.

```ts
const { transport, emit, boundTypes } = makeTransport<CartMessage>()
const router = createMessageRouter<CartMessage, CartAction, RootState>(transport)
// after the store has bound it:
expect(boundTypes()).toContain('PRICE_TICK')
emit('PRICE_TICK', { sku: 'a', price: 5 })
```
