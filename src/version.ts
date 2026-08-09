import { StoreMiddleware, VersionedAction } from './types'

let globalVersion = 0

/**
 * Takes the next action sequence number.
 *
 * **Versions start at 1 and are never 0.** That is deliberate: it makes a falsy check a
 * reliable test for absence, so `!action.__requestVersion` means "this action has no cause
 * recorded" and never "its cause happened to be the first action of the process". Without the
 * guarantee, every consumer comparing these fields would have to remember to write
 * `!== undefined` instead of the obvious thing.
 */
export const releaseActionVersion = (): number => ++globalVersion

/** Resets the counter, so the next release is 1 again. Intended for tests. */
export const resetActionVersion = (): void => {
  globalVersion = 0
}

/**
 * Stamps `__version` on every action that does not already have one.
 *
 * Must be installed **first** in the middleware chain, so that every downstream middleware —
 * effects in particular — sees a numbered action and can propagate causality from it.
 */
export const versionMiddleware: StoreMiddleware<VersionedAction, unknown> =
  () => next => (action: VersionedAction) =>
    next({ ...action, __version: action.__version || releaseActionVersion() })
