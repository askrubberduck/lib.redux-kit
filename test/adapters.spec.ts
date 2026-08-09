import { expect } from 'chai'
import { configure, resetConfig } from '../src/config'
import { createDispatchRegistry } from '../src/dispatch-registry'
import { createMessageRouter } from '../src/message-router'
import { defineDomain } from '../src/domain'
import { createSubscriptions } from '../src/subscriptions'
import { createSubscriptionMiddleware } from '../src/subscription-middleware'
import { createAuditMiddleware } from '../src/audit'
import { getRegisteredStore, resetRegisteredStore, storeDispatch } from '../src/registry'
import { createTestStore, flush, makeStream, makeTransport } from '../src/testing'
import { CartAction, CartState, initialCartState } from './fixtures'

type CartSubscriptions = {
  key: 'CART_PRICE_UPDATES'
  id?: string
  variables: { sku: string }
  payload: { price: number }
}

const cartDomain = () => defineDomain<CartState, CartAction>({ name: 'cart', initial: initialCartState })

describe('subscriptions', () => {
  beforeEach(() => resetConfig())

  const setup = () => {
    const upstream = makeStream<{ data: { price: number } }>()
    const { handle, subscriber } = createSubscriptions<CartSubscriptions, any, any>()
    return { upstream, handle, subscriber }
  }

  const storeWith = (subscriber: any) =>
    createTestStore<any, any>({ domains: [cartDomain()], adapters: { subscribers: [subscriber] } })

  it('opens a stream on SUBSCRIBE and fans payloads out to the handler', async () => {
    const { upstream, handle, subscriber } = setup()
    const received: any[] = []
    handle('CART_PRICE_UPDATES', () => upstream.stream as any, async p => {
      received.push(p)
    })

    const store = storeWith(subscriber)
    store.dispatch({ type: 'SUBSCRIBE', key: 'CART_PRICE_UPDATES', variables: { sku: 'a' } })
    upstream.emit({ data: { price: 12 } })
    await flush()

    expect(store.actionTypes()).to.include('SUBSCRIPTION_PAYLOAD')
    expect(received).to.deep.equal([{ price: 12 }])
  })

  it('ignores a duplicate SUBSCRIBE unless it carries force', () => {
    const { upstream, handle, subscriber } = setup()
    handle('CART_PRICE_UPDATES', () => upstream.stream as any, async () => undefined)
    const store = storeWith(subscriber)
    const action = { type: 'SUBSCRIBE', key: 'CART_PRICE_UPDATES', variables: { sku: 'a' } }

    store.dispatch(action)
    store.dispatch(action)
    expect(upstream.counts().subscribeCount).to.equal(1)

    store.dispatch({ ...action, force: true })
    expect(upstream.counts().subscribeCount).to.equal(2)
    expect(upstream.counts().unsubscribeCount).to.equal(1)
  })

  it('re-subscribes on a transport error and on errors in a payload', () => {
    const { upstream, handle, subscriber } = setup()
    handle('CART_PRICE_UPDATES', () => upstream.stream as any, async () => undefined)
    const store = storeWith(subscriber)
    store.dispatch({ type: 'SUBSCRIBE', key: 'CART_PRICE_UPDATES', variables: { sku: 'a' } })

    upstream.fail(new Error('dropped'))
    expect(upstream.counts().subscribeCount).to.equal(2)

    upstream.emit({ errors: [{ message: 'transient' }] } as any)
    expect(upstream.counts().subscribeCount).to.equal(3)
  })

  it('keeps concurrent subscriptions on one key apart by id, and UNSUBSCRIBE_ALL closes them', () => {
    const { upstream, handle, subscriber } = setup()
    handle('CART_PRICE_UPDATES', () => upstream.stream as any, async () => undefined)
    const store = storeWith(subscriber)

    store.dispatch({ type: 'SUBSCRIBE', key: 'CART_PRICE_UPDATES', id: 'a', variables: { sku: 'a' } })
    store.dispatch({ type: 'SUBSCRIBE', key: 'CART_PRICE_UPDATES', id: 'b', variables: { sku: 'b' } })
    expect(upstream.counts().subscribeCount).to.equal(2)

    store.dispatch({ type: 'UNSUBSCRIBE_ALL' })
    expect(upstream.counts().unsubscribeCount).to.equal(2)
  })

  it('drops the channel when the stream completes', () => {
    const { upstream, handle, subscriber } = setup()
    handle('CART_PRICE_UPDATES', () => upstream.stream as any, async () => undefined)
    const store = storeWith(subscriber)

    store.dispatch({ type: 'SUBSCRIBE', key: 'CART_PRICE_UPDATES', variables: { sku: 'a' } })
    upstream.complete()
    // Forgotten, so a fresh SUBSCRIBE opens a new stream rather than being deduped.
    store.dispatch({ type: 'SUBSCRIBE', key: 'CART_PRICE_UPDATES', variables: { sku: 'a' } })

    expect(upstream.counts().subscribeCount).to.equal(2)
  })

  it('gives the factory and the handler state only when they declare it', async () => {
    const { upstream, handle, subscriber } = setup()
    let factoryState: any = 'not called'
    let handlerState: any = 'not called'

    handle(
      'CART_PRICE_UPDATES',
      ((_v: any, state: any) => {
        factoryState = state
        return upstream.stream
      }) as any,
      (async (_p: any, _d: any, state: any) => {
        handlerState = state
      }) as any,
    )

    const store = storeWith(subscriber)
    store.dispatch({ type: 'SUBSCRIBE', key: 'CART_PRICE_UPDATES', variables: { sku: 'a' } })
    upstream.emit({ data: { price: 1 } })
    await flush()

    expect(factoryState.cart).to.deep.equal(initialCartState)
    expect(handlerState.cart).to.deep.equal(initialCartState)
  })

  it('throws when a key is registered twice', () => {
    const { upstream, handle } = setup()
    handle('CART_PRICE_UPDATES', () => upstream.stream as any, async () => undefined)

    expect(() => handle('CART_PRICE_UPDATES', () => upstream.stream as any, async () => undefined)).to.throw(
      /already exists/,
    )
  })

  it('is inert for a key no subscriber declared', () => {
    const { subscriber } = setup()
    const store = storeWith(subscriber)

    expect(() => store.dispatch({ type: 'SUBSCRIBE', key: 'UNKNOWN', variables: {} })).to.not.throw()
  })

  it('can be composed by hand for a store assembled without the kit host', () => {
    const { upstream, handle, subscriber } = setup()
    handle('CART_PRICE_UPDATES', () => upstream.stream as any, async () => undefined)

    expect(typeof createSubscriptionMiddleware(subscriber)).to.equal('function')
  })
})

describe('createMessageRouter', () => {
  it('binds nothing until listen is called', () => {
    const t = makeTransport<{ type: 'PRICE_TICK' }>()
    const router = createMessageRouter<{ type: 'PRICE_TICK' }, any, any>(t.transport)
    router.handle('PRICE_TICK', () => undefined)

    expect(t.boundTypes()).to.deep.equal([])
  })

  it('routes a message and hands over dispatch, with state when declared', () => {
    const t = makeTransport<{ type: 'PRICE_TICK' } | { type: 'STOCK_TICK' }>()
    const router = createMessageRouter<{ type: 'PRICE_TICK' } | { type: 'STOCK_TICK' }, any, any>(t.transport)
    const dispatched: any[] = []
    let withState: any = 'not called'

    router.handle('PRICE_TICK', (payload, dispatch) => dispatch({ type: 'X', price: payload.price }))
    router.handle('STOCK_TICK', ((_p: any, _d: any, state: any) => {
      withState = state
    }) as any)
    router.listen(a => dispatched.push(a), () => ({ cart: initialCartState }))

    t.emit('PRICE_TICK', { price: 15 })
    t.emit('STOCK_TICK', {})

    expect(dispatched).to.deep.equal([{ type: 'X', price: 15 }])
    expect(withState.cart).to.deep.equal(initialCartState)
  })

  it('throws when a message type is registered twice', () => {
    const t = makeTransport<{ type: 'PRICE_TICK' }>()
    const router = createMessageRouter<{ type: 'PRICE_TICK' }, any, any>(t.transport)
    router.handle('PRICE_TICK', () => undefined)

    expect(() => router.handle('PRICE_TICK', () => undefined)).to.throw(/already exists/)
  })
})

describe('createAuditMiddleware', () => {
  it('observes actions after they reach the folds, with a live getState', async () => {
    const seen: any[] = []
    const tap = createAuditMiddleware<any, any>((action, getState) => {
      seen.push({ type: action.type, total: getState().cart.total })
    })
    const cart = cartDomain()
    cart.reduce('CART_PRICING_RESPONSE', (_s, a) => ({ total: a.total }))

    const store = createTestStore<any, any>({
      domains: [cart],
      middleware: reactions => [...reactions, tap],
    })
    store.dispatch({ type: 'CART_PRICING_RESPONSE', total: 5 })
    await flush()

    // Post-reduce state, unlike a reaction's pre-reduce snapshot.
    expect(seen).to.deep.equal([{ type: 'CART_PRICING_RESPONSE', total: 5 }])
  })
})

describe('createDispatchRegistry', () => {
  it('routes an action to the instance registered under an id', () => {
    const registry = createDispatchRegistry<any>()
    const received: any[] = []
    registry.register('panel-1', async a => {
      received.push(a)
    })

    expect(registry.handle('panel-1', { type: 'DONE' })).to.equal(true)
    expect(received).to.have.length(1)
  })

  it('reports false once the instance is gone, and keeps instances apart', () => {
    const registry = createDispatchRegistry<any>()
    const hits: string[] = []
    registry.register('one', async () => { hits.push('one') })
    registry.register('two', async () => { hits.push('two') })

    registry.handle('two', { type: 'DONE' })
    registry.unregister('two')

    expect(hits).to.deep.equal(['two'])
    expect(registry.handle('two', { type: 'DONE' })).to.equal(false)
  })
})

describe('storeDispatch registry', () => {
  beforeEach(() => resetRegisteredStore())

  it('silently does nothing before a store exists', () => {
    expect(getRegisteredStore()).to.equal(null)
    expect(() => storeDispatch({ type: 'CART_CLEAR' })).to.not.throw()
  })

  it('warns instead of vanishing when asked to', () => {
    const logged: any[] = []
    configure({
      warnOnUnregisteredDispatch: true,
      logger: { debug: () => undefined, info: () => undefined, error: (...a) => logged.push(a) },
    })

    storeDispatch({ type: 'CART_CLEAR' })

    expect(logged).to.have.length(1)
    expect(logged[0].join(' ')).to.contain('CART_CLEAR')
  })
})
