# The store host

Wiring the root store, middleware order, adding a domain, and diagnosing why a reduce, reaction
or watcher never fires.

The store hosts many domains on one shared action bus, for the lifetime of the session.

## Wiring it

```ts
// store/store.ts
import './configure'                       // side-effect import, must be first
import { createStore } from '@askrubberduck/redux-kit/store'
import { registerStore, storeDispatch } from '@askrubberduck/redux-kit'
import * as cart from './cart'
import * as session from './session'
import { RootAction, RootState } from './types'

export { registerStore, storeDispatch }

// One list. Each domain contributes whatever it declares — state under its own name, folds,
// reactions and watchers — and is skipped for whatever it does not.
const domains = [cart.domain, session.domain]

// Message routers, listed separately and deliberately: a module that ships a `listen` is not
// automatically bound, and a domain may have a router the application has chosen not to wake.
const routers = [cart]

export const store = createStore<RootState, RootAction>({
  domains,
  // Order has consequences, so it stays here. Version stamping is placed first for you, and
  // subscription handling before anything that reacts to a payload — those have one correct
  // position, so they are not a choice.
  middleware: reactions => [...reactions, analyticsMiddleware],
  adapters: { routers, subscribers: [cart.subscriber] },
  enhancer: isDev ? composeWithDevTools : undefined,
  preloadedState: hydratedFromServer,        // seeds domains that have a key here
})
```

`createStore` lives behind the `/store` subpath because it is the one part that needs redux; the
root entry stays dependency-free. It returns `{ getState, dispatch, subscribe }` — a redux store's
own surface, so devtools and `react-redux`'s `Provider` take it unchanged.

It performs the wiring whose order is not a choice: create, attach watchers, bind routers, then
register for `storeDispatch`. Registering last matters — anything dispatched through that escape
hatch beforehand is silently dropped.

The state shape comes from the domains' own names, so there is no reducer map to keep in sync.
`reducers` is there for a domain you do not own, such as a third-party reducer. `preloadedState`
is a partial of the root state, for hydration — a domain with no key in it falls back to its own
`initial`.

## Configuring the kit

```ts
// store/configure.ts — imported first by store.ts
import { configure } from '@askrubberduck/redux-kit'

configure({
  logger,
  debug: process.env.NODE_ENV !== 'production',
  onUnhandledError: (error, dispatch, action) => {
    dispatch({ type: 'NOTIFICATION_RAISE', notification: { type: 'error', message: error.message } })
  },
  warnOnUnregisteredDispatch: process.env.NODE_ENV !== 'production',
})
```

`onUnhandledError` catches reactions from domains with no `onError`. Left at its default it only
logs, so a failing reaction never reaches the user — set it.

`configure` merges, so it can be called more than once and each call sets only what it names.
Call it before the store is created; `logger` defaults to silence and `debug` to `false`.

## Adding a domain

Two places, and forgetting the second fails silently:

| Step | Forgotten → symptom |
|---|---|
| Its state and actions in `RootState` / `RootAction` | type errors at every dispatch site |
| The domain in the `domains` array | **compiles and runs; nothing in it ever fires** |

A domain that also ships a message router needs a third: its module in the `routers` list. Same
failure mode — it compiles, and no message ever arrives.

## Dispatching from outside the tree

`storeDispatch` is the escape hatch for code that must not import the store — an api client
reacting to a 401, a navigation container, a timer. The indirection is the point: an api client
that imports the store, while domains import the api client, is a cycle.

```ts
if (response.status === 401) {
  storeDispatch({ type: 'SESSION_SIGN_OUT' })
}
```

It does nothing before the store exists. Turn on `warnOnUnregisteredDispatch` in development so
that failure is loud rather than invisible.

## Diagnosing "my thing never fires"

1. **Is the domain in the `domains` array?** Most common cause by far.
2. **Is the module actually imported?** Registration is an import side effect. A module
   referenced only as a type import is erased at compile time and never registers.
3. **For `storeDispatch` doing nothing** — is it running before the store is created?
4. **For a watcher** — does the selected value actually change by deep equality?
5. **For a subscription** — was `SUBSCRIBE` dispatched, and is the subscriber in `adapters`?

## Testing

`@askrubberduck/redux-kit/testing` builds a store wired the way this one is, and records every action.

```ts
import { createTestStore, flush } from '@askrubberduck/redux-kit/testing'

const store = createTestStore<RootState, RootAction>({ domains: [cart.domain, session.domain] })

await store.dispatchAsync({ type: 'CART_ADD_ITEM', sku: 'a', quantity: 1 })

expect(store.actionTypes()).toContain('CART_PRICING_REQUEST')
expect(store.getState().cart.isPending).toBe(true)
```

It takes the same options as `createStore`, so adapters, middleware and `preloadedState` can all
be exercised in a test.

The recorder gives you three views: `actionTypes()` for the common assertion, `actions()` for the
whole action objects when you need a payload or a `__version`, and `clearActions()` to drop
everything recorded so far — useful for asserting about one phase of a longer scenario:

```ts
await store.dispatchAsync({ type: 'CART_ADD_ITEM', sku: 'a', quantity: 1 })
store.clearActions()

await store.dispatchAsync({ type: 'CART_SET_QUANTITY', sku: 'a', quantity: 2 })
expect(store.actions()[0].__version).toBeGreaterThan(0)
```

`dispatchAsync` resolves once the reaction chain finishes; `dispatch` plus `await flush()` when
you want an intermediate state — `flush(times)` drains that many macrotasks, defaulting to 3, and
a longer chain may need more. Registration is global and throws on duplicates, so import domain
modules once per file and build fresh *stores* per test. `resetConfig()`, `resetActionVersion()`
and `resetRegisteredStore()` are exported from the same entry.
