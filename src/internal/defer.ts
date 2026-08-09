// Installs a global `setImmediate` when the host lacks one. The package is MessageChannel-based
// in browsers, so unlike `setTimeout(fn, 0)` it is not subject to the ~4ms clamp browsers apply
// to timers nested more than five deep — and deeply nested dispatch chains are exactly this
// kit's hot path. Importing for side effects only; it is a no-op where setImmediate exists.
import 'setimmediate'

/**
 * Schedules work as a macrotask, after the current call stack unwinds and after already-queued
 * microtasks. The ordering matters: it lets a dispatch complete its pass through the reducer
 * before a nested dispatch begins.
 */
export const defer = (callback: () => void): void => {
  setImmediate(callback)
}
