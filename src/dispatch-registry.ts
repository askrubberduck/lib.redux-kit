import { Action, AsyncDispatch } from './types'

/**
 * Routes an action back to one specific local store, by id.
 *
 * A local store can dispatch into the global store freely, but the return path is the hard
 * one: a global effect finishing an async request has no way to reach the particular component
 * instance that started it. Registering that component's dispatch under an id gives the effect
 * a way back, so it can report completion to exactly one instance rather than broadcasting.
 *
 * Register on mount, unregister on unmount. `handle` returns false when nothing is registered
 * for the id, which is the normal case after the component has gone.
 */
export function createDispatchRegistry<TAction extends Action>() {
  const dispatchers = new Map<string, AsyncDispatch<TAction>>()

  function handle(uid: string, action: TAction): boolean {
    const dispatcher = dispatchers.get(uid)

    if (!dispatcher) {
      return false
    }

    dispatcher(action)
    return true
  }

  function register(uid: string, dispatcher: AsyncDispatch<TAction>) {
    dispatchers.set(uid, dispatcher)
  }

  function unregister(uid: string) {
    dispatchers.delete(uid)
  }

  return { handle, register, unregister }
}
