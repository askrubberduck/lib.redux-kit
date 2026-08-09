---
name: redux-kit
description: Use for any work in a codebase that uses @askrubberduck/redux-kit — writing or changing a domain, wiring the root store, middleware order, reading state or dispatching from a React component, a component-hosted domain, GraphQL subscriptions, socket messages, analytics taps, discarding stale responses from a slow service, or diagnosing why a reduce, reaction or watcher never fires. Explains the one unit the kit has, then routes to a reference file per topic.
---

# redux-kit

The kit has **one unit and two hosts**.

A **domain** owns a piece of state and everything that happens to it. A **store** hosts many
domains on one shared action bus for the session; a **component** hosts one on a private bus for
as long as it is mounted. The same domain definition works in either — nothing is available in one
host and missing from the other.

Everything else is an **adapter**: something that turns an outside event into a dispatched action.

## What this is not

- **Not redux-saga.** No generators, no `yield`, no effect DSL. `on` takes a plain async function
  keyed by action type.
- **Not redux-toolkit.** `defineDomain` here has no immer and no action creators. Folds return a
  *partial* state; mutating does nothing.
- **Not automatic.** A domain registers its handlers when its module is first imported. A module
  nobody imports does nothing.

## A domain

```ts
// store/cart/action.ts — the action union, including any foreign action this domain folds
import { SessionSignOut } from '../session'

export type CartAction = AddItem | SetQuantity | PricingRequest | PricingResponse | SessionSignOut
```

```ts
// store/cart/domain.ts — the domain object, imported by every other file in the module
import { defineDomain } from '@askrubberduck/redux-kit'
import { CartAction } from './action'
import { RootAction, RootState } from '../types'
import type { CartState } from './reducer'

const initState: CartState = { items: [], total: 0, itemCount: 0, isPending: false }

export const domain = defineDomain<CartState, CartAction, RootState, RootAction>({
  name: 'cart',
  initial: initState,
})
```

```ts
// store/cart/reducer.ts — owns the state shape and every fold over it
import { domain } from './domain'
import { CartItem } from './types'

export type CartState = {
  items: CartItem[]
  total: number
  itemCount: number
  isPending: boolean
}

const { reduce, derive } = domain

// synchronous state change — (state, action), matching redux's own reducer signature
reduce('CART_ADD_ITEM', (state, action) => ({ items: [...state.items, action.item] }))
reduce('CART_PRICING_REQUEST', { isPending: true })          // a constant partial also works
reduce('SESSION_SIGN_OUT', initState)                        // the app-wide reset convention
reduce(['CART_ADD_ITEM', 'CART_SET_QUANTITY'], { isPending: true })   // an array of types

// values computed from this domain's own state, after every reduce that changed something
derive(state => ({ itemCount: state.items.length }))
```

```ts
// store/cart/saga.ts — reactions and watchers
import { cartApi } from 'app/cart-api'
import { domain } from './domain'

const { on, watch, onError } = domain

// async work — (action, dispatch, state), state last and always passed. Runs *after* the reduce,
// so `state` is already the post-action value. Takes an array of types too.
on('CART_PRICING_REQUEST', async (action, dispatch, state) => {
  const { total } = await cartApi.priceCart(state.cart.items)

  return dispatch({ type: 'CART_PRICING_RESPONSE', total })
})

// a reaction to a state change rather than to an action
watch('cart.item-count', s => ({ n: s.cart.itemCount }), (next, previous, dispatch) => {
  if (next.n > 0 && previous.n === 0) {
    dispatch({ type: 'CART_PRICING_REQUEST' })
  }
})

// fallback for any reaction in this domain that throws
onError(async (action, dispatch, error) => {
  dispatch({ type: 'CART_PRICING_ERROR', error: error.message })
})
```

The state type lives in `reducer.ts` beside the folds that maintain it, and `domain.ts` takes it
as a **type-only import**. That direction matters: `reducer.ts` imports the domain *value*, so a
value import back the other way is a cycle, and the seed would be read before it is initialised.

The four generics are **own state**, **actions it folds**, then the **root state** and **root
actions** a reaction and a watcher see. The last two default to the first two — which is exactly
what a component-hosted domain wants, so a local one is just
`defineDomain<PanelState, PanelAction>`.

## The rules

**Parameter order: state is always last, dispatch immediately before it.** The one exception is a
reduce, which is `(state, action)` because that is redux's reducer signature and breaking it would
surprise every reader.

**Folds return a partial, and no-ops are free.** The partial is diffed before merging; when
nothing changed the *same state object* comes back, so `shallowEqual` selectors do not re-render.
`undefined` means "leave it alone", `{}` is the explicit no-op.

**`await dispatch(...)` inside a reaction sequences work.** The promise resolves once the whole
chain that action triggered has finished — every reduce, and every reaction those dispatches set
off in turn. Bare `dispatch(...)` is fire-and-forget, which is what you want most of the time;
await it when the next step depends on the last having landed:

```ts
on('CART_CHECKOUT', async (action, dispatch) => {
  await dispatch({ type: 'CART_PRICING_REQUEST' })   // returns after pricing has settled
  dispatch({ type: 'CART_SUBMIT' })
})
```

**Duplicate registration throws at import time**, naming the domain. A collision surfaces at boot
rather than as one handler quietly winning.

**A domain may reduce another domain's actions** — import that action's *type* into your own union
in `action.ts`, which widens the generic. That is how one `SESSION_SIGN_OUT` resets everything.
Import the action type, never the other domain's state.

## Where a domain lives

```
store/cart/
  action.ts     the action union
  domain.ts     creates the domain; the one file every other imports
  reducer.ts    state type + folds + derive
  saga.ts       reactions and watchers
  types.ts      shared data types — the entities, not the state or the actions
  index.ts      barrel
  listen.ts     a message router, when the domain has one
  subscriptions.ts   subscription channels, when the domain has any
  hook.ts       a component-hosted domain, when the domain has one
```

The barrel re-exports the parts other modules consume, and the `domain` itself by name — a
`import * as cart` elsewhere then reads `cart.domain`, and importing the barrel is what registers
everything:

```ts
// store/cart/index.ts
export * from './action'
export * from './reducer'
export * from './saga'
export * from './types'
export { domain } from './domain'
```

A small domain may collapse `reducer.ts` and `saga.ts` into one file. `domain.ts` stays separate
either way: everything else imports it, so folding it into a file that also imports something is
how the cycle above gets reintroduced.

A domain that owns **no state** — one that exists only to react to other domains — declares no
`initial` and takes `void` as its state type. The store hosts it without giving it a key:

```ts
export const domain = defineDomain<void, AnalyticsAction, RootState, RootAction>({ name: 'analytics' })
```

## Types worth naming

Every concept above has an exported type, for the places inference does not reach — a helper
signature, a shared selector, a `domains` array.

| Annotating | Type |
|---|---|
| any action | `Action` — just `{ type: string }` |
| an action a reaction receives | `VersionedAction` — `Action` plus optional `__version` / `__requestVersion` |
| dispatch | `Dispatch<TAction>` fire-and-forget, `AsyncDispatch<TAction>` awaitable |
| a watcher's two halves | `Selector<TState, TAction, T>` and `WatchHandler<T, TState, TAction>` |
| one subscription channel's declaration | `Subscription` — `{ key, id?, variables?, payload }` |
| the reserved subscription actions, in the root union | `SubscriptionAction<TSubscription>` |
| a subscription stream and one delivered result | `ObservableLike<T>`, `ResultLike<T>` |
| a message-router transport | `MessageTransport<TMessage>` |
| a heterogeneous list of domains | `HostedDomain`; `Domain<...>` when you mean one specific domain |
| `configure`'s argument and the logger it takes | `Settings`, `Logger` |

All of the above come from the root entry. The subpaths add `StoreOptions`, `Store` and
`Adapters` from `/store`, and `TestStore` and `FakeStream` from `/testing`.

One quirk: a `Selector` receives `TState & { dispatch }`, not bare state — `dispatch` is merged
into the argument so a selector can build a value that closes over it.

## Where to go next

Everything above applies everywhere. Each file below covers one host or one problem — read the
one your task names, not all of them.

| Task | Read |
|---|---|
| Wiring the root store, middleware order, `configure`, adding a domain, `storeDispatch`, "why doesn't my reduce / reaction / watcher ever fire?", `createTestStore` | [reference/store.md](reference/store.md) |
| `useRedux`, `useReduxDispatch`, selector rules, a domain hosted by a component, `useDomain`, `createDispatchRegistry` | [reference/component.md](reference/component.md) |
| GraphQL subscriptions, socket messages, an always-on bus, a read-only analytics or telemetry tap: `createSubscriptions`, `createMessageRouter`, `createAuditMiddleware` | [reference/adapters.md](reference/adapters.md) |
| A slow service racing fast user edits, stale responses overwriting fresh state, `__version`, `__requestVersion` | [reference/versioning.md](reference/versioning.md) |
