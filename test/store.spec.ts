import { expect } from 'chai'
import { resetConfig } from '../src/config'
import { createMessageRouter } from '../src/message-router'
import { defineDomain } from '../src/domain'
import { createSubscriptions } from '../src/subscriptions'
import { createStore } from '../src/store'
import { resetRegisteredStore, storeDispatch } from '../src/registry'
import { createTestStore, flush, makeStream, makeTransport } from '../src/testing'
import {
  CartAction,
  CartState,
  RootAction,
  RootState,
  SessionAction,
  SessionState,
  initialCartState,
  initialSessionState,
} from './fixtures'

const cartDomain = () =>
  defineDomain<CartState, CartAction, RootState, RootAction>({ name: 'cart', initial: initialCartState })
const sessionDomain = () =>
  defineDomain<SessionState, SessionAction, RootState, RootAction>({ name: 'session', initial: initialSessionState })

type CartSubscriptions = {
  key: 'CART_PRICE_UPDATES'
  id?: string
  variables: { sku: string }
  payload: { price: number }
}

describe('createStore', () => {
  beforeEach(() => {
    resetConfig()
    resetRegisteredStore()
  })

  it('builds the state shape from the domains it hosts', () => {
    const store = createStore<RootState, RootAction>({ domains: [cartDomain(), sessionDomain()] })

    expect(Object.keys(store.getState())).to.deep.equal(['cart', 'session'])
  })

  it('throws when two domains claim the same name', () => {
    expect(() => createStore<any, any>({ domains: [cartDomain(), cartDomain()] })).to.throw(/cart/)
  })

  it('merges extra reducers alongside the domains', () => {
    const store = createStore<any, any>({
      domains: [cartDomain()],
      reducers: { legacy: (s = 'x') => s },
    })

    expect(Object.keys(store.getState()).sort()).to.deep.equal(['cart', 'legacy'])
  })

  it('registers itself, so storeDispatch works without a separate call', async () => {
    const cart = cartDomain()
    cart.reduce('CART_PRICING_RESPONSE', (_s, a) => ({ total: a.total }))

    const store = createStore<RootState, RootAction>({ domains: [cart, sessionDomain()] })
    storeDispatch({ type: 'CART_PRICING_RESPONSE', total: 12 })

    expect(store.getState().cart.total).to.equal(12)
  })

  it('places version stamping first without being asked', () => {
    const store = createTestStore<any, any>({ domains: [cartDomain()] })
    store.dispatch({ type: 'CART_NOOP' })

    expect((store.actions()[0] as any).__version).to.be.a('number')
  })

  it('lets the application place its own middleware around the reactions', async () => {
    const order: string[] = []
    const cart = cartDomain()
    cart.on('CART_NOOP', async () => {
      order.push('reaction')
    })

    const before = () => (next: any) => (a: any) => {
      order.push('before')
      return next(a)
    }
    const after = () => (next: any) => (a: any) => {
      order.push('after')
      return next(a)
    }

    const store = createStore<any, any>({
      domains: [cart],
      middleware: reactions => [before as any, ...reactions, after as any],
    })
    store.dispatch({ type: 'CART_NOOP' })
    await flush()

    expect(order[0]).to.equal('before')
    expect(order).to.include('after')
    expect(order).to.include('reaction')
  })

  describe('watchers', () => {
    it('fires when a selected value changes, with (next, previous, dispatch, state)', async () => {
      const cart = cartDomain()
      cart.reduce('CART_PRICING_RESPONSE', (_s, a) => ({ total: a.total }))
      const seen: any = {}
      cart.watch('cart.total', s => ({ total: s.cart.total }), (next, previous, dispatch, state) => {
        seen.next = next
        seen.previous = previous
        seen.dispatchIsFunction = typeof dispatch === 'function'
        seen.stateTotal = state.cart.total
      })

      const store = createStore<RootState, RootAction>({ domains: [cart, sessionDomain()] })
      store.dispatch({ type: 'CART_PRICING_RESPONSE', total: 9 })
      await flush()

      expect(seen.next).to.deep.equal({ total: 9 })
      expect(seen.previous).to.deep.equal({ total: 0 })
      expect(seen.dispatchIsFunction).to.equal(true)
      expect(seen.stateTotal).to.equal(9)
    })

    it('does not fire when the selected value is unchanged', async () => {
      const cart = cartDomain()
      const session = sessionDomain()
      let calls = 0
      cart.watch('cart.total', s => ({ total: s.cart.total }), () => {
        calls += 1
      })

      const store = createStore<RootState, RootAction>({ domains: [cart, session] })
      store.dispatch({ type: 'SESSION_SIGN_IN', userId: 'u1' })
      await flush()

      expect(calls).to.equal(0)
    })

    it('throws when two domains claim the same watch key', () => {
      const a = cartDomain()
      const b = sessionDomain()
      a.watch('shared', s => ({ t: s.cart.total }), () => undefined)
      b.watch('shared', s => ({ t: s.cart.total }), () => undefined)

      expect(() => createStore<RootState, RootAction>({ domains: [a, b] })).to.throw(/shared/)
    })
  })

  describe('adapters', () => {
    it('owns subscription lifecycle when subscribers are given', async () => {
      const upstream = makeStream<{ data: { price: number } }>()
      const { handle, subscriber } = createSubscriptions<CartSubscriptions, RootState, any>()
      const received: any[] = []
      handle('CART_PRICE_UPDATES', () => upstream.stream as any, async payload => {
        received.push(payload)
      })

      const store = createStore<any, any>({ domains: [cartDomain()], adapters: { subscribers: [subscriber] } })
      store.dispatch({ type: 'SUBSCRIBE', key: 'CART_PRICE_UPDATES', variables: { sku: 'a' } } as any)
      upstream.emit({ data: { price: 3 } })
      await flush()

      expect(upstream.counts().subscribeCount).to.equal(1)
      expect(received).to.deep.equal([{ price: 3 }])
    })

    it('binds message routers at startup', () => {
      const t = makeTransport<{ type: 'PRICE_TICK' }>()
      const router = createMessageRouter<{ type: 'PRICE_TICK' }, any, any>(t.transport)
      const cart = cartDomain()
      cart.reduce('CART_PRICING_RESPONSE', (_s, a) => ({ total: a.total }))
      router.handle('PRICE_TICK', (payload, dispatch) => {
        dispatch({ type: 'CART_PRICING_RESPONSE', total: payload.price })
      })

      const store = createStore<any, any>({ domains: [cart], adapters: { routers: [router] } })
      t.emit('PRICE_TICK', { price: 15 })

      expect(store.getState().cart.total).to.equal(15)
    })

    it('binds only the routers it is given', () => {
      const bound = makeTransport<{ type: 'A' }>()
      const dormant = makeTransport<{ type: 'B' }>()
      const r1 = createMessageRouter<{ type: 'A' }, any, any>(bound.transport)
      const r2 = createMessageRouter<{ type: 'B' }, any, any>(dormant.transport)
      r1.handle('A', () => undefined)
      r2.handle('B', () => undefined)

      createStore<any, any>({ domains: [cartDomain()], adapters: { routers: [r1] } })

      // A router the store was not given stays silent, even though it exists.
      expect(bound.boundTypes()).to.deep.equal(['A'])
      expect(dormant.boundTypes()).to.deep.equal([])
    })
  })

  it('applies an enhancer when one is given', () => {
    let wrapped = false
    createStore<any, any>({
      domains: [cartDomain()],
      enhancer: e => {
        wrapped = true
        return e
      },
    })

    expect(wrapped).to.equal(true)
  })

  it('accepts preloaded state', () => {
    const store = createStore<any, any>({
      domains: [cartDomain()],
      preloadedState: { cart: { ...initialCartState, total: 99 } },
    })

    expect(store.getState().cart.total).to.equal(99)
  })
})
