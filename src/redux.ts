import { shallowEqual, useSelector } from 'react-redux'
import { Action, Dispatch } from './types'

// Lives behind the '@askrubberduck/redux-kit/redux' subpath because it is the one React binding that
// needs react-redux. '/react' stays React-only, so a component-hosted domain — which never touches
// a store — pulls in neither react-redux nor redux.

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
