import { createStore, StoreOptions } from './store'
import { wrapAsyncDispatch } from './dispatch'
import { resetConfig } from './config'
import { resetActionVersion } from './version'
import { resetRegisteredStore } from './registry'
import { Action, StoreMiddleware, ObservableLike } from './types'

// Test helpers. This entry is never bundled into an application, so like the store host it may
// depend on redux directly — asserting store behaviour against a hand-rolled fake store would
// mostly test the fake.

export { resetConfig, resetActionVersion, resetRegisteredStore }

export type TestStore<TState, TAction extends Action> = {
  getState: () => TState
  /** Fire and forget, like a component would. */
  dispatch: (action: TAction) => void
  /** Resolves once the reaction chain this action triggered has finished. */
  dispatchAsync: (action: TAction) => Promise<void>
  subscribe: (listener: () => void) => () => void
  /** Every action that reached the store, in order, including ones reactions dispatched. */
  actions: () => TAction[]
  /** Just the types, which is usually what an assertion wants. */
  actionTypes: () => string[]
  clearActions: () => void
}

/**
 * A store wired the way an application wires one, with every action recorded.
 *
 * Use `dispatchAsync` when the assertion depends on a reaction having finished; `dispatch` plus
 * `flush()` when you want to observe an intermediate state.
 */
export function createTestStore<TState, TAction extends Action = any>(
  options: StoreOptions<TState, TAction>,
): TestStore<TState, TAction> {
  const recorded: TAction[] = []
  const recorder: StoreMiddleware<any, any> = () => next => action => {
    recorded.push(action)
    return next(action)
  }

  const store = createStore<TState, TAction>({
    ...options,
    middleware: reactions => [recorder, ...(options.middleware ? options.middleware(reactions) : reactions)],
  })

  const asyncDispatch = wrapAsyncDispatch(store.dispatch as any)

  return {
    getState: store.getState,
    dispatch: store.dispatch,
    dispatchAsync: action => asyncDispatch(action as any),
    subscribe: store.subscribe,
    actions: () => [...recorded],
    actionTypes: () => recorded.map(a => a.type),
    clearActions: () => {
      recorded.length = 0
    },
  }
}

/**
 * Waits for pending macrotasks to drain, so deferred dispatches and reactions have run.
 *
 * Reactions are scheduled rather than awaited, so an assertion made immediately after a
 * synchronous `dispatch` sees the state before they ran.
 */
export const flush = async (times = 3): Promise<void> => {
  for (let i = 0; i < times; i++) {
    await new Promise(resolve => setTimeout(resolve, 0))
  }
}

export type FakeStream<T> = {
  stream: ObservableLike<T>
  emit: (value: T) => void
  fail: (error: any) => void
  complete: () => void
  counts: () => { subscribeCount: number; unsubscribeCount: number }
}

/** A controllable stand-in for a subscription transport, satisfying the same structural contract. */
export function makeStream<T>(): FakeStream<T> {
  const observers: any[] = []
  let subscribeCount = 0
  let unsubscribeCount = 0

  const stream: ObservableLike<T> = {
    subscribe(observer: any) {
      subscribeCount += 1
      observers.push(observer)
      observer.start?.({})
      let closed = false
      return {
        unsubscribe() {
          unsubscribeCount += 1
          closed = true
          // A real transport stops delivering here. Without this the double keeps feeding
          // every observer it has ever seen, and one failure cascades into re-subscribe storms.
          const at = observers.indexOf(observer)
          if (at >= 0) {
            observers.splice(at, 1)
          }
        },
        get closed() {
          return closed
        },
      }
    },
  }

  return {
    stream,
    emit: value => observers.forEach(o => o.next(value)),
    fail: error => observers.forEach(o => o.error(error)),
    complete: () => observers.forEach(o => o.complete()),
    counts: () => ({ subscribeCount, unsubscribeCount }),
  }
}

/** A transport stand-in for `createMessageRouter`. */
export function makeTransport<TMessage extends { type: string }>() {
  const listeners = new Map<string, (payload: any) => void>()

  return {
    transport: {
      listen: (type: TMessage['type'], callback: (payload: any) => void) => {
        listeners.set(type, callback)
      },
    },
    emit: (type: TMessage['type'], payload: any) => listeners.get(type)?.(payload),
    boundTypes: () => [...listeners.keys()],
  }
}
