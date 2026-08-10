import React from 'react'
import { Domain } from './domain'
import { notifyWatchers, seedWatchers } from './internal/local-watchers'
import { releaseActionVersion } from './version'
import { Action, AsyncDispatch, VersionedAction } from './types'

// React only, deliberately: a component-hosted domain needs no store, so this entry must not reach
// for react-redux. `createReduxHooks`, which does, lives at '@askrubberduck/redux-kit/redux'.

/**
 * Hosts one domain for one component: a private action bus, state seeded per mount, and a lifetime
 * that ends with the component.
 *
 * The same domain definition a store would host. Pass `seed` when the starting state depends on
 * something only the component knows; otherwise the domain's own initial state is used.
 */
export function useDomain<TState, TAction extends Action>(
  domain: Domain<TState, TAction, any, any>,
  seed?: TState,
): [TState, AsyncDispatch<TAction>] {
  // Resolved once per mount. A factory initial state gives each component its own copy.
  const [initial] = React.useState<TState>(() => seed ?? domain.$.seed())

  const [state, setState] = React.useState<TState>(initial)
  const stateRef = React.useRef<TState>(initial)

  // Read once, as the store host does at `createStore`: registration is an import side effect and
  // has already happened by the time anything mounts.
  const watchers = React.useMemo(() => domain.$.watchers(), [domain])

  // The watched values, per mount like the state itself. Seeded on the first dispatch rather than
  // at render, because seeding needs the `dispatch` this hook is still building.
  const seen = React.useRef<Map<string, unknown>>()

  const dispatch: AsyncDispatch<TAction> = React.useCallback(
    async (action: TAction & VersionedAction) => {
      action.__version = action.__version ?? releaseActionVersion()

      const next = domain.$.runLocal(stateRef.current, action, dispatch as AsyncDispatch<any>)
      stateRef.current = next
      setState(next)

      if (watchers.length) {
        const before = (seen.current ??= seedWatchers(watchers, initial, dispatch))
        notifyWatchers(watchers, before, next, dispatch)
      }
    },
    [domain, initial, watchers],
  )

  return [state, dispatch]
}
