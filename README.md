# @askrubberduck/redux-kit

A layer over redux that collapses one feature's moving parts — its reducers, the async work its
actions trigger, its recomputed values, its state watchers and its error handling — into a single
object called a **domain**, and runs that object in either of two places: the application's redux
store, or one React component for as long as it is mounted.

It is not a redux replacement. The store host is redux, `createStore` returns a redux store, and
devtools and `react-redux`'s `Provider` take it unchanged.

## What it solves

**A feature is spread across files that have to agree, and nothing enforces it.** In a plain redux
app one feature is a reducer, an action union, thunks or sagas registered somewhere else,
selectors, and an entry in the root reducer map. Miss the last one and the code still compiles and
still runs — the feature is just silently inert. A domain carries its own name and the store builds
the state shape from the domains it is handed, so there is no map to fall out of sync.

**Reducers spread state to signal a change, and then components re-render for no reason.** A fold
here returns a *partial*, which is diffed against current state before merging; when nothing
actually differs the existing state object comes back by reference, so `shallowEqual` selectors do
not re-render. Returning `undefined` means "leave it alone" and `{}` is an explicit no-op. The
memoization you would otherwise hand-write is a property of the fold.

**Async work lives away from the state it changes.** `on` registers a plain async function against
an action type, in the same definition as the `reduce` for that type. No generators, no effect DSL,
no separate middleware to register per feature. It receives `(action, dispatch, state)` and runs
after the fold.

**State belonging to one screen has no good home.** A global slice outlives the screen and needs a
reset action someone will forget; `useReducer` plus `useEffect` is a second architecture with no
recomputed values and no error path. `useDomain` hosts the same domain definition on a private bus,
seeded per mount, discarded on unmount.

**Dependent async work has no ordering primitive.** `await dispatch(...)` resolves once the entire
chain that action set off has settled — every fold, and every reaction those dispatches triggered
in turn. Actions nobody reacts to still settle, so an await never hangs.

**Long-lived streams have a lifecycle someone has to own.** Subscriptions are opened per key with
variables, deduplicated, force-re-subscribed on a transport error or an error payload, and closed
on completion — by the store, not by a component's effect. Socket buses bind once at startup and
route by message type.

**Slow responses overwrite fast ones.** Every action carries a monotonic `__version`, and a
reaction's dispatches carry the version of the action that caused them, so a reduce can reject a
response that belongs to an intent the user has already superseded. This is a protocol you opt into
per feature, not something that happens automatically — see
[reference/versioning.md](skills/redux-kit/reference/versioning.md).

**Where it does not help:** there is no cancellation. Nothing here aborts in-flight work — no
`takeLatest`, no `race`, no `AbortSignal` plumbing. The version stamp lets a late response be
*ignored*; it does not stop it. For HTTP request/response, a query library that cancels is the
better tool, and the two compose fine.

Anything that feeds actions in from outside — a socket, a GraphQL subscription, an analytics tap —
is an **adapter**, covered further down.

Two differences from redux-toolkit worth knowing before you read the examples: there is no immer,
so a fold returns a partial rather than mutating a draft, and there are no generated action
creators — you write the action union and dispatch plain objects.

## Install

```bash
npm install @askrubberduck/redux-kit
```

There are no required peers, and one dependency: `dequal`, for the structural comparison a fold and
a watcher both need. The root entry pulls in neither redux nor React. Add `react` for `/react`,
`react-redux` for `/redux`, and `redux` for `/store` — each is an optional peer, declared so npm
does not install one you never import.

## A domain

```ts
import { defineDomain } from '@askrubberduck/redux-kit'

export const cart = defineDomain<CartState, CartAction, RootState, RootAction>({
  name: 'cart',
  initial: { items: [], total: 0, itemCount: 0, isPending: false },
})

// a fold — (state, action), matching redux's own reducer signature. Returns a partial.
cart.reduce('CART_ADD_ITEM', (state, action) => ({ items: [...state.items, action.item] }))

// recomputed after every fold that changed something
cart.recompute(state => ({ itemCount: state.items.length }))

// async work for an action type — (action, dispatch, state), state last and always passed.
// Store-hosted, `state` is the root state, which is what the last two generics declare.
cart.on('CART_PRICING_REQUEST', async (action, dispatch, state) => {
  const { total } = await api.priceCart(state.cart.items)
  dispatch({ type: 'CART_PRICING_RESPONSE', total })
})

// reacts to a state change rather than an action. The first argument is a registration key,
// unique across the host — it is not a state path.
cart.watch('cart:pricing', s => ({ total: s.cart.total }), (next, previous, dispatch) => { ... })

cart.onError(async (action, dispatch, error) => { ... })
```

## The two hosts

```ts
// a store — many domains, one shared action bus, session lifetime
import { createStore } from '@askrubberduck/redux-kit/store'

export const store = createStore<RootState, RootAction>({
  domains: [cart, session],
  middleware: reactions => [...reactions, analyticsMiddleware],
})
```

```tsx
// a component — one domain, a private bus, mount lifetime
import { useDomain } from '@askrubberduck/redux-kit/react'

const [state, dispatch] = useDomain(panel)
```

Folds, recomputed values, reactions, watchers and error handling all run in both hosts. **One
thing genuinely differs, and a domain that ignores it will not survive the move:** `reduce` and
`recompute` always receive this domain's own state, but a reaction (`on`) and a watcher receive
the whole root state when store-hosted and only this domain's state when component-hosted. The
third and fourth type parameters exist to declare that root view — leave them off, as a
component-hosted domain does, and `state` is the domain's own.

A domain that reads state in an `on` or a `watch` therefore belongs to one host or the other. One
that does not is portable as written.

## Adapters

An adapter is built by its own factory and handed to the store. A domain does not carry one.

```ts
import { createMessageRouter, createSubscriptions } from '@askrubberduck/redux-kit'

const prices = createSubscriptions<PriceSubscription, RootState, RootAction>()
prices.handle(
  'cart.prices',
  variables => api.watchPrices(variables),
  async (payload, dispatch) => dispatch({ type: 'CART_PRICING_RESPONSE', total: payload.total }),
)

const inbox = createMessageRouter<Message, RootAction>(socket)
inbox.handle('CART_CLEARED', (payload, dispatch) => dispatch({ type: 'CART_RESET' }))

createStore<RootState, RootAction>({
  domains: [cart, session],
  adapters: { subscribers: [prices.subscriber], routers: [inbox] },
})
```

## API

| Export | Purpose |
|---|---|
| `defineDomain` | the only authoring API: state, folds, reactions, recomputed values, watchers, error handling |
| `createSubscriptions` | live channels opened per key, with a lifecycle the store owns |
| `createMessageRouter` | routes messages from an always-on bus |
| `createAuditMiddleware` | read-only tap on the action stream |
| `createDispatchRegistry` | routes an action back to one component instance |
| `registerStore` / `storeDispatch` | dispatch from outside the component tree |
| `configure` | inject logger, debug flag, unhandled-error handler |

Subpaths: `/react` for `useDomain`, `/redux` for `createReduxHooks`, `/store` for `createStore`,
`/testing` for `createTestStore`, `flush`, `makeStream`, `makeTransport` and the resets. Each one
carries exactly the peer it needs — `/react` needs only React, `/redux` adds react-redux, `/store`
needs redux — so a component-hosted domain never pulls a store dependency in.

## Two rules that are easy to get wrong

**State is last, dispatch immediately before it.** The one exception is `reduce`, which is
`(state, action)` because that is redux's own reducer signature.

**Adapters gate state on arity.** A subscription factory or handler receives state only if it
declares the parameter, so a function-level default parameter silently costs you state. A default
inside a destructuring pattern is safe. Domains do not do this — a reaction always receives state.

## Agent instructions

The package ships its own agent instructions in `skills/redux-kit/`. `SKILL.md` covers the model
and the domain API and routes to one file per topic in `reference/`, so an agent reads the one its
task needs rather than all four. Point at them from `AGENTS.md`:

```md
## @askrubberduck/redux-kit

Before writing a domain, store, adapter or React binding, locate the installed `@askrubberduck/redux-kit`
package and read `skills/redux-kit/SKILL.md` inside it, then whichever file in its `reference/`
directory that file routes you to.
```

That is the whole setup. Nothing is copied, so nothing goes stale on upgrade, and one entry covers
every agent that reads that file. It says *locate* rather than naming a path because
`node_modules/@askrubberduck/redux-kit/` is not where the package lands under pnpm or in a hoisted
workspace, and a pointer to a path that does not exist fails silently.

## Development

```bash
npm install
npm test               # mocha; typechecks the tests first
npm run build
npm run check:circular
```

MIT
