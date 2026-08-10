import { expect } from 'chai'
import { createScheduler } from '../src/internal/defer'

// Node always has `setImmediate`, so without forcing the host the suite would only ever exercise
// one of the three branches — and the MessageChannel one is the branch every browser takes.

const settle = () => new Promise(resolve => setTimeout(resolve, 0))

// An open MessagePort holds the event loop open, so a suite that leaves one behind never exits.
// Tracking every channel the scheduler builds lets each test close its own.
const opened: MessageChannel[] = []

class Tracked extends MessageChannel {
  constructor() {
    super()
    opened.push(this)
  }
}

describe('deferring a macrotask', () => {
  afterEach(() => {
    opened.forEach(channel => {
      channel.port1.close()
      channel.port2.close()
    })
    opened.length = 0
  })

  it('uses setImmediate when the host has it', async () => {
    const seen: string[] = []
    const schedule = createScheduler({
      setImmediate: callback => {
        seen.push('setImmediate')
        return setTimeout(callback, 0)
      },
      MessageChannel,
    })

    schedule(() => seen.push('ran'))
    await settle()

    expect(seen).to.deep.equal(['setImmediate', 'ran'])
  })

  it('falls back to a MessageChannel where there is no setImmediate — the browser path', async () => {
    const schedule = createScheduler({ MessageChannel: Tracked })
    const seen: string[] = []

    schedule(() => seen.push('first'))
    schedule(() => seen.push('second'))
    await settle()

    expect(seen).to.deep.equal(['first', 'second'])
  })

  it('runs after already-queued microtasks, not before them', async () => {
    const schedule = createScheduler({ MessageChannel: Tracked })
    const order: string[] = []

    schedule(() => order.push('macrotask'))
    void Promise.resolve().then(() => order.push('microtask'))
    await settle()

    expect(order).to.deep.equal(['microtask', 'macrotask'])
  })

  it('keeps going after a callback throws, and still reports the error', async () => {
    const schedule = createScheduler({ MessageChannel: Tracked })
    const seen: string[] = []
    const escaped: Error[] = []

    // A throw that escapes `onmessage` stops the port draining, so this is what proves the second
    // callback is not stranded behind the first. Mocha's own handler has to stand down while the
    // error we deliberately caused goes past.
    const mochaHandlers = process.listeners('uncaughtException')
    mochaHandlers.forEach(handler => process.off('uncaughtException', handler))
    const collect = (error: Error) => escaped.push(error)
    process.on('uncaughtException', collect)

    schedule(() => {
      throw new Error('boom')
    })
    schedule(() => seen.push('after the throw'))

    await settle()
    await settle()

    process.off('uncaughtException', collect)
    mochaHandlers.forEach(handler => process.on('uncaughtException', handler))

    expect(seen).to.deep.equal(['after the throw'])
    expect(escaped.map(error => error.message)).to.deep.equal(['boom'])
  })

  it('falls back to setTimeout for a host with neither', async () => {
    const schedule = createScheduler({})
    let ran = false

    schedule(() => {
      ran = true
    })
    await settle()

    expect(ran).to.equal(true)
  })
})
