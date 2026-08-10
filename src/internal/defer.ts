// Three mechanisms, picked in the order React's own scheduler picks them:
//
//   setImmediate    where the host has it, which in practice means Node
//   MessageChannel  otherwise, which means every browser
//   setTimeout      last, for a host with neither
//
// The middle one is why this is not just `setTimeout(fn, 0)`: browsers clamp a timer nested more
// than five deep to ~4ms, and deeply nested dispatch chains are this kit's hot path. A
// MessageChannel is not a timer, so it is not clamped.
//
// This was the `setimmediate` package until it became the last runtime dependency worth removing.
// That package installs `globalThis.setImmediate`, which is more than a library should take from
// its host, and it is dead weight on Node, where the global already exists.

export type Scheduler = (callback: () => void) => void

/** The globals the choice depends on. Passed in so every branch can be exercised by a test. */
export type SchedulerHost = {
  setImmediate?: (callback: () => void) => unknown
  MessageChannel?: typeof MessageChannel
}

const viaMessageChannel = (Channel: typeof MessageChannel): Scheduler => {
  const pending: (() => void)[] = []
  const channel = new Channel()

  // Exactly one message is posted per scheduled callback, so taking one from the front here keeps
  // the queue and the message stream in step.
  //
  // The catch is load-bearing rather than defensive. A throw that escapes `onmessage` stops the
  // port draining, so one bad callback would strand every callback queued behind it — where under
  // `setImmediate` each is its own task and a throw costs only itself. Rethrowing from a timer
  // keeps the two branches behaving alike: the error still reaches the host unhandled, and the
  // queue still moves.
  channel.port1.onmessage = () => {
    const run = pending.shift()

    if (!run) {
      return
    }

    try {
      run()
    } catch (error) {
      setTimeout(() => {
        throw error
      }, 0)
    }
  }

  return callback => {
    pending.push(callback)
    channel.port2.postMessage(undefined)
  }
}

export const createScheduler = (host: SchedulerHost): Scheduler => {
  if (typeof host.setImmediate === 'function') {
    const immediate = host.setImmediate
    return callback => {
      immediate(callback)
    }
  }

  if (typeof host.MessageChannel === 'function') {
    return viaMessageChannel(host.MessageChannel)
  }

  return callback => {
    setTimeout(callback, 0)
  }
}

let schedule: Scheduler | undefined

/**
 * Schedules work as a macrotask, after the current call stack unwinds and after already-queued
 * microtasks. The ordering matters: it lets a dispatch complete its pass through the reducer
 * before a nested dispatch begins.
 *
 * The mechanism is resolved on first use rather than at import, so a bundle that pulls this module
 * in but never dispatches opens no channel.
 */
export const defer = (callback: () => void): void => {
  schedule ??= createScheduler(globalThis as SchedulerHost)
  schedule(callback)
}
