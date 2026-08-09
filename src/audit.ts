import { Action, StoreMiddleware } from './types'

/**
 * Watches the action stream without being able to change it — analytics, telemetry, session
 * recording, anything whose job is to notice rather than to act.
 *
 * The callback runs *after* the action has reached the reduces, and takes `getState` as a live
 * getter rather than a snapshot, so it reads the state the action produced. It is given no
 * dispatch, deliberately: an observer that can act is no longer an observer, and the ordering
 * guarantees below stop holding the moment one can re-enter the chain.
 */
export function createAuditMiddleware<TAction extends Action, TState = unknown>(
  callback: (action: TAction, getState: () => TState) => Promise<void> | void,
): StoreMiddleware<TAction, TState> {
  return ({ getState }) =>
    next =>
    async (action: TAction) => {
      next(action)

      await callback(action, getState)
    }
}
