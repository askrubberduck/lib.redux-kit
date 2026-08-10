# @askrubberduck/redux-kit

One unit, two hosts.

A **domain** owns a piece of state and everything that happens to it: how actions change it, what
async work they trigger, what is derived from it, and what should happen when it changes. A
**store** hosts many domains on one shared action bus; a **component** hosts one on a private bus.
The same domain definition works in either.

Everything else is an **adapter** — something that turns an outside event into a dispatched
action.

## What it is not

- **Not redux-saga.** No generators, no `yield`, no effect DSL. `on` takes a plain async function
  keyed by action type.
- **Not redux-toolkit.** No immer, no action creators. Folds return a *partial* state.
- **Does not depend on redux at the root.** Domains and the component host need nothing; only the
  store host does, and it lives behind a subpath.

## Install

```bash
npm install @askrubberduck/redux-kit
```

Peers: `lodash`, plus `react`/`react-redux` for `/react` and `redux` for `/store`.

## A domain

```ts
import { defineDomain } from '@askrubberduck/redux-kit'

export const cart = defineDomain<CartState, CartAction, RootState, RootAction>({
  name: 'cart',
  initial: { items: [], total: 0, isPending: false },
})

cart.reduce('CART_ADD_ITEM', (state, action) => ({ items: [...state.items, action.item] }))
cart.recompute(state => ({ itemCount: state.items.length }))

cart.on('CART_PRICING_REQUEST', async (action, dispatch, state) => {
  const { total } = await api.priceCart(state.cart.items)
  dispatch({ type: 'CART_PRICING_RESPONSE', total })
})

cart.watch('cart.total', s => ({ total: s.cart.total }), (next, previous, dispatch) => { ... })
cart.onError(async (action, dispatch, error) => { ... })
```

## Its two hosts

```ts
// a store — many domains, shared bus, session lifetime
import { createStore } from '@askrubberduck/redux-kit/store'

export const store = createStore<RootState, RootAction>({
  domains: [cart, session],
  middleware: reactions => [...reactions, analyticsMiddleware],
  adapters: { subscribers: [cart.subscriber], routers: [cart.router] },
})

// a component — one domain, private bus, mount lifetime
import { useDomain } from '@askrubberduck/redux-kit/react'

const [state, dispatch] = useDomain(panel)
```

## API

| Export | Purpose |
|---|---|
| `defineDomain` | the only authoring API: state, folds, reactions, derived values, watchers, error handling |
| `createSubscriptions` | live channels opened per key, with a lifecycle the store owns |
| `createMessageRouter` | routes messages from an always-on bus |
| `createAuditMiddleware` | read-only tap on the action stream |
| `createDispatchRegistry` | routes an action back to one component instance |
| `registerStore` / `storeDispatch` | dispatch from outside the component tree |
| `configure` | inject logger, debug flag, unhandled-error handler |

Subpaths: `/store` for `createStore`, `/react` for `useDomain` and `createReduxHooks`, `/testing`
for `createTestStore`, `flush`, `makeStream`, `makeTransport` and the resets. The rule throughout
is that anything needing a peer lives behind a subpath, so the root entry loads with none.

## Two rules that are easy to get wrong

**State is always last, dispatch immediately before it.** The one exception is a reduce, which is
`(state, action)` because that is redux's own reducer signature.

**Adapters gate state on arity.** A subscription factory or handler receives state only if it
declares the parameter, so a function-level default parameter silently costs you state. A default
inside a destructuring pattern is safe. Domains do not do this — a reaction always receives state.

## Agent instructions

The package ships agent instructions in `skills/redux-kit/`. `SKILL.md` covers the model and the
domain API; `reference/` holds one file per topic — the store host, the component host, adapters,
versioning — and `SKILL.md` routes to whichever the task needs, so an agent reads one of them
rather than all four.

Point your agent at them from `AGENTS.md`. That is all the setup there is: nothing is copied, so
nothing goes stale when you upgrade the package, and one entry covers every agent that reads the
file — Codex, Cursor, Jules, Aider, Gemini CLI, Zed, and Claude Code.

```md
## @askrubberduck/redux-kit

Before writing a domain, store, adapter or React binding, locate the installed `@askrubberduck/redux-kit`
package and read `skills/redux-kit/SKILL.md` inside it, then whichever file in its `reference/`
directory that file routes you to.
```

Written as a search rather than a literal path on purpose — `node_modules/@askrubberduck/redux-kit/` is not
where the package lands under pnpm or in a hoisted workspace, and a pointer to a path that does
not exist fails silently.

The same three lines work in `.cursor/rules/*.mdc` or `.github/instructions/*.instructions.md` if
you want them glob-scoped to your store directory. Claude Code users who want the stronger trigger
of a real skill can instead copy the directory in, and re-copy it on upgrade:

```bash
mkdir -p .claude/skills
cp -R node_modules/@askrubberduck/redux-kit/skills/redux-kit .claude/skills/
```

## Development

```bash
npm install
npm test               # mocha; typechecks the tests first
npm run build
npm run check:circular
```
