# The component host

Reading store state and dispatching from React, and hosting a domain inside one component when
its state belongs to a single screen.

Two hooks, on two subpaths. `useRedux` — built by `createReduxHooks` from
`@askrubberduck/redux-kit/redux` — reads the global store. `useDomain`, from
`@askrubberduck/redux-kit/react`, hosts one domain inside a component. They are split so that
`/react` needs only React: a component-hosted domain touches no store, so it pulls in neither
react-redux nor redux.

## Reading the store

```ts
// hooks/useRedux.ts — once per application
import { createReduxHooks } from '@askrubberduck/redux-kit/redux'
import { RootAction, RootState, storeDispatch } from 'app/store'

export const { useRedux, useReduxDispatch } = createReduxHooks<RootState, RootAction>(storeDispatch)
```

Bind it to `storeDispatch`, not `store.dispatch`. Reaching for the store object pulls every domain
in the application into whatever imports this hook; `storeDispatch` is late-bound and pulls in
nothing.

```tsx
const { items, total, isPending, dispatch } = useRedux(({ cart }) => ({
  items: cart.items,
  total: cart.total,
  isPending: cart.isPending,
}))
```

**The selector must return an object** — comparison is always `shallowEqual`.

**Derive inside the selector, not in the component body.** The comparison then covers the derived
value, so an unrelated change cannot re-render you:

```tsx
const { canCheckout, dispatch } = useRedux(({ cart, session }) => ({
  canCheckout: cart.items.length > 0 && session.isSignedIn && !cart.isPending,
}))
```

**Never select a whole domain.** It defeats `shallowEqual` entirely — the domain object identity
changes on every reduce, so the component re-renders on every action touching it:

```tsx
const { cart } = useRedux(({ cart }) => ({ cart }))   // ❌
```

**Return primitives where you can.** `shallowEqual` compares one level, so a selector returning a
fresh array or object every call always compares unequal. Select something stable and map with
`useMemo` in the component.

Write-only component? `useReduxDispatch()` never re-renders from the store. `dispatch` is stable
for the app's lifetime.

## A domain hosted by a component

When state has exactly one owner and nothing else reads it — a form, a wizard, a modal managing
its own request — host the domain in the component instead. The state dies with the component: no
domain to reset, no cleanup to forget.

The definition is an ordinary domain. Only the last two generics differ: leave them off, and
reactions and watchers see this domain's own state.

A component-hosted domain lives in the module's `hook.ts`, alongside the hook that mounts it —
state type, seed, domain, folds and reactions in one file, because nothing outside reads any of
them.

```ts
// store/checkout/hook.ts
import { defineDomain } from '@askrubberduck/redux-kit'
import { useDomain } from '@askrubberduck/redux-kit/react'
import { storeDispatch } from '../store'
import { PanelAction } from './action'

export type PanelState = {
  quantity: number
  unitPrice: number
  subtotal: number
  isConfirming: boolean
  error?: string
}

const initState: PanelState = { quantity: 1, unitPrice: 0, subtotal: 0, isConfirming: false }

const localStore = defineDomain<PanelState, PanelAction>({ name: 'checkoutPanel', initial: initState })
const { reduce, recompute, on } = localStore

reduce('PANEL_SET_QUANTITY', (_state, action) => ({ quantity: action.quantity }))
reduce('PANEL_CONFIRM', { isConfirming: true, error: undefined })
recompute(state => ({ subtotal: state.quantity * state.unitPrice }))

on('PANEL_CONFIRM', async (_action, dispatch, state) => {
  try {
    const { orderId } = await checkoutApi.confirm({ quantity: state.quantity })

    return dispatch({ type: 'PANEL_CONFIRMED', orderId })
  } catch (error: any) {
    return dispatch({ type: 'PANEL_FAILED', error: error.message })
  }
})

export function useCheckoutPanel() {
  const [state, dispatch] = useDomain(localStore)

  const { isSignedIn } = useRedux(({ session }) => ({ isSignedIn: session.isSignedIn }))

  function confirm() {
    if (!isSignedIn) {
      storeDispatch({ type: 'SESSION_SIGN_IN_PROMPT' })
      return
    }
    dispatch({ type: 'PANEL_CONFIRM' })
  }

  return { ...state, confirm }
}
```

Define the domain at **module scope**, not inside the component — registration happens once, and
each mounted component gets its own copy of the state. The `useRedux` / `storeDispatch` pair above
is the normal shape: a component-hosted domain reads and writes the store freely, it just does not
keep its own state there.

Export the hook, not the domain. The domain object is an implementation detail of this file, and a
second component calling `useDomain` on it would get its own unrelated copy of the state — which
is almost never what the second caller expects.

**When the seed depends on the component**, pass it at mount. Give the domain a factory `initial`
so each mount gets a fresh object, or omit `initial` entirely when there is no sensible default:

```ts
const localStore = defineDomain<AccountsState, AccountsAction>({ name: 'accounts' })

export function useAccounts(accountType: AccountType) {
  const [state, dispatch] = useDomain(localStore, initialFor(accountType))
  // ...
}
```

## Reaching a component-hosted domain from the store

A component-hosted domain can dispatch outward with `storeDispatch` freely. The return path is the
hard one: a store reaction finishing an async request has no way to reach the particular
component instance that started it. `createDispatchRegistry` gives it one.

The registry lives in the **store domain's `saga.ts`**, next to the reactions that use it — not in
the component. The component hands its own `dispatch` over as a field on the request action, and
the reaction that starts the work registers it:

```ts
// store/checkout/saga.ts
import { createDispatchRegistry } from '@askrubberduck/redux-kit'
import { domain } from './domain'

const { on } = domain
const panelDispatchers = createDispatchRegistry<PanelAction>()

const idFor = (orderRef: string) => `checkout/${orderRef}`

on('CHECKOUT_CONFIRM_REQUEST', async ({ orderRef, dispatch: panelDispatch }, dispatch) => {
  if (panelDispatch) {
    panelDispatchers.register(idFor(orderRef), panelDispatch)
  }

  const response = await checkoutApi.confirm(orderRef)

  return dispatch(
    response.ok
      ? { type: 'CHECKOUT_CONFIRMED', orderRef, orderId: response.orderId }
      : { type: 'CHECKOUT_FAILED', orderRef, error: response.message },
  )
})

on(['CHECKOUT_CONFIRMED', 'CHECKOUT_FAILED'], async (action, dispatch) => {
  const handled = panelDispatchers.handle(idFor(action.orderRef), action)

  // Nothing registered means the panel has gone. Fall back to something app-wide rather than
  // dropping the outcome on the floor.
  if (!handled && action.type === 'CHECKOUT_FAILED') {
    dispatch({ type: 'NOTIFICATION_RAISE', notification: { type: 'error', message: action.error } })
  }
})
```

```tsx
// in the component's hook
storeDispatch({ type: 'CHECKOUT_CONFIRM_REQUEST', orderRef, dispatch })
```

`handle` returns `false` when nothing is registered — the normal case once the component has
unmounted, and the signal to fall back as above rather than assume the outcome was delivered.

Passing `dispatch` on the action rather than registering in a `useEffect` keeps registration and
the work it belongs to in one place: there is no window where the request is in flight and the
return path is not yet registered, and nothing to unregister on unmount.

## Checklist

- [ ] Selector returns an object, and derives inside itself
- [ ] No whole-domain selection
- [ ] Component-hosted domains defined at module scope, exported as a hook rather than a domain
- [ ] State a second screen needs to read moved to the store instead
- [ ] Every registry `handle` has a fallback for the `false` case
