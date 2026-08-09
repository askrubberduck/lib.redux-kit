import { defer } from './internal/defer'
import { deferred } from './internal/async'
import { SETTLE } from './internal/marks'
import { Action, AsyncDispatch, Dispatch, VersionedAction } from './types'

/**
 * Makes a dispatch awaitable. The returned promise settles once the effect chain triggered by
 * the action has finished, which is what allows an effect to sequence work with
 * `await dispatch(...)`.
 *
 * The action is dispatched on the next macrotask carrying an `__unlock` resolver; the effects
 * middleware calls it in a `finally`, so the promise settles even when no handler is
 * registered and even when a handler throws.
 */
export const wrapAsyncDispatch =
  <TAction extends Action>(dispatch: Dispatch<TAction>): AsyncDispatch<TAction> =>
  (action: TAction): Promise<void> => {
    const settled = deferred()
    defer(() => dispatch({ ...action, [SETTLE]: settled.resolve }))
    return settled.promise
  }

/**
 * Stamps every dispatched action with the version of the action that caused it, unless it
 * already carries one. Applied to the dispatch handed to an effect handler, so causality
 * propagates transitively down a chain.
 */
export const wrapVersionDispatch =
  <TAction extends VersionedAction>(
    dispatch: AsyncDispatch<TAction>,
    __requestVersion?: number,
  ): AsyncDispatch<TAction> =>
  (action: TAction): Promise<void> =>
    // Versions start at 1, so a falsy `__requestVersion` means the action carries none.
    dispatch({ ...action, __requestVersion: action.__requestVersion || __requestVersion })
