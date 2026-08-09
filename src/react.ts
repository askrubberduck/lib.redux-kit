import React from 'react'
import { shallowEqual, useSelector } from 'react-redux'
import { Domain } from './domain'
import { releaseActionVersion } from './version'
import { Action, AsyncDispatch, Dispatch, VersionedAction } from './types'

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

  const dispatch: AsyncDispatch<TAction> = React.useCallback(
    async (action: TAction & VersionedAction) => {
      action.__version = action.__version ?? releaseActionVersion()

      const next = domain.$.runLocal(stateRef.current, action, dispatch as AsyncDispatch<any>)
      stateRef.current = next
      setState(next)
    },
    [domain],
  )

  return [state, dispatch]
}

/**
 * Reads from the store and hands back `dispatch` alongside the selected values, so a component
 * destructures both in one call.
 *
 * The selector **must return an object** — comparison is always `shallowEqual`. Derive inside the
 * selector rather than in the component body; that is what keeps the comparison meaningful.
 * Selecting a whole domain defeats it entirely.
 */
export function createReduxHooks<TState, TAction extends Action>(dispatch: Dispatch<TAction>) {
  const useRedux = <TSelected extends object>(
    selector: (state: TState) => TSelected,
  ): TSelected & { dispatch: Dispatch<TAction> } => {
    const result = useSelector(selector, shallowEqual)
    // Spread rather than mutate: `useSelector` caches the value it returns and compares the next
    // selector result against it. Writing `dispatch` onto that cached object would give it one
    // more key than every future result, so `shallowEqual` would never match again and the
    // component would re-render on every action.
    return { ...result, dispatch }
  }

  const useReduxDispatch = (): { dispatch: Dispatch<TAction> } => ({ dispatch })

  return { useRedux, useReduxDispatch }
}
