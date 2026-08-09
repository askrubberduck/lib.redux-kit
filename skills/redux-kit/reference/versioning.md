# Action versioning

`__version`, `__requestVersion`, and the stale-response-rejection pattern — for when a slow
service races fast user edits and stale responses overwrite fresh state.

The problem this solves: a user edits quantity three times quickly, three pricing requests go
out, and they come back out of order. The oldest response lands last and the total is wrong.

Versioning lets a reducer recognise a response that belongs to an intent it has already moved
past, and drop it.

## The two fields

Both are stamped by the kit. Never declare them on your action types — they arrive via
`VersionedAction`.

- **`__version`** — a monotonic sequence number, stamped on every action by
  the store host. Starts at 1 and is never 0. Think "when did this happen".
- **`__requestVersion`** — the `__version` of the action that caused this one. Think "what
  caused this".

Version stamping is placed first in the chain by `createStore`; it is not something you wire.

## What `__requestVersion` actually means

**It names the immediate cause, one hop up — not the root intent.** Each reaction
receives a dispatch seeded with *its own* action's `__version`, so the chain looks like this:

```
CART_SET_QUANTITY      __version: 1   __requestVersion: undefined
  └─ CART_PRICING_REQUEST    __version: 2   __requestVersion: 1    ← parent is version 1
       └─ CART_PRICING_RESPONSE  __version: 3   __requestVersion: 2  ← parent is version 2
```

Note the last line: the response points at the request, *not* at the original
`CART_SET_QUANTITY`. Propagation is one hop, automatic.

**To carry the root intent further, forward it by hand.** This is why the manual-forwarding
pattern exists:

```ts
cart.on('CART_PRICING_REQUEST', async (action, dispatch, state) => {
  const { total } = await api.priceCart(state.cart.items)
  dispatch({
    type: 'CART_PRICING_RESPONSE',
    total,
    __requestVersion: action.__requestVersion,   // re-attach, so the root survives the hop
  })
})
```

An explicitly-set `__requestVersion` is preserved rather than overwritten. Forward it at every
hop between the intent and the response you want to guard.

## The stale-response-rejection pattern

Three parts. All three are required — two out of three silently does nothing.

**1. A watermark in domain state:**

```ts
export type CartState = {
  items: CartItem[]
  total: number
  isPending: boolean
  __requestVersion: number      // highest intent this domain has accepted
}

export const initialCartState: CartState = { items: [], total: 0, isPending: false, __requestVersion: 0 }
```

`0` is the right initial watermark: real versions start at 1, so it reads as "nothing accepted
yet" and the first response always passes the guard.

**2. Bump the watermark on every user-intent action**, from `action.__version` — the intent's
own number:

```ts
cart.reduce('CART_SET_QUANTITY', (state, action) => ({
  items: applyQuantity(state.items, action),
  isPending: true,
  __requestVersion: action.__version,
}))

cart.reduce('CART_CLEAR', (_state, action) => ({
  ...initialCartState,
  isPending: true,
  __requestVersion: action.__version,
}))
```

**3. Drop responses older than the watermark**, comparing `action.__requestVersion`:

```ts
cart.reduce('CART_PRICING_RESPONSE', (state, action) => {
  if (action.__requestVersion && action.__requestVersion < state.__requestVersion) {
    // A newer intent has already superseded this response.
    return undefined                    // undefined leaves state untouched
  }
  return {
    total: action.total,
    isPending: false,
    __requestVersion: action.__requestVersion ?? state.__requestVersion,
  }
})
```

Every action that starts new in-flight work must bump the watermark. Miss one and its
responses are compared against a stale floor.

## Two things to know

**Versions are 1-based, so a falsy check means absent.** The counter never issues 0, precisely
so that `!action.__requestVersion` reliably means "no cause recorded" and can never be confused
with a real cause. Write the obvious thing:

```ts
if (action.__requestVersion && action.__requestVersion < state.__requestVersion) {
  return undefined
}
```

**The guard is one-directional.** It drops *older* responses. It does nothing about a response
that never arrives — that still needs a timeout, and `isPending` still needs clearing.

## When not to reach for this

Only where fast repeated intents race a genuinely slow response. It costs a state field, a
bump in every intent handler, and a guard in every response handler — all of which must stay
in sync. For a screen that fires one request and waits, `isPending` is enough.

## Checklist

- [ ] `__requestVersion` field on the domain state, initialised
- [ ] Every user-intent action bumps it from `action.__version`
- [ ] Every response handler compares before applying
- [ ] `__requestVersion` forwarded by hand at each hop between intent and response
- [ ] `__version` / `__requestVersion` never declared on your own action types
