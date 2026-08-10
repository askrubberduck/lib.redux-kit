import { expect } from 'chai'
import { useStore } from 'zustand'
import { resetConfig } from '../src/config'
import { wrapAsyncDispatch } from '../src/dispatch'
import { defineDomain } from '../src/domain'
import { createMessageRouter } from '../src/message-router'
import { resetRegisteredStore, storeDispatch } from '../src/registry'
import { createStore } from '../src/store'
import { createSubscriptions } from '../src/subscriptions'
import { flush, makeStream, makeTransport } from '../src/testing'
import { resetActionVersion } from '../src/version'
import { createZustandStore } from '../src/zustand'
import { StoreMiddleware } from '../src/types'
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

// The zustand host runs the same domain definitions as the redux host, so most of this file is the
// store spec asked again of a different container. The two sections that are not: the parity block
// at the end, which hosts *one* domain object under both and compares the outcome, and the
// notification block, which pins down the one behaviour that genuinely differs.

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

/** Records every action that reached the chain, for assertions about order and stamping. */
const recorder =
  (into: any[]): StoreMiddleware<any, any> =>
  () =>
  next =>
  action => {
    into.push(action)
    return next(action)
  }

describe('createZustandStore', () => {
  beforeEach(() => {
    resetConfig()
    resetRegisteredStore()
    resetActionVersion()
  })

  describe('state shape', () => {
    it('builds the state shape from the domains it hosts', () => {
      const store = createZustandStore<RootState, RootAction>({ domains: [cartDomain(), sessionDomain()] })

      expect(Object.keys(store.getState())).to.deep.equal(['cart', 'session'])
      expect(store.getState().cart).to.deep.equal(initialCartState)
    })

    it('throws when two domains claim the same name', () => {
      expect(() => createZustandStore<any, any>({ domains: [cartDomain(), cartDomain()] })).to.throw(/cart/)
    })

    it('merges extra reducers alongside the domains', () => {
      const store = createZustandStore<any, any>({
        domains: [cartDomain()],
        reducers: { legacy: (s = 'x') => s },
      })

      expect(Object.keys(store.getState()).sort()).to.deep.equal(['cart', 'legacy'])
    })

    it('accepts preloaded state', () => {
      const store = createZustandStore<RootState, RootAction>({
        domains: [cartDomain(), sessionDomain()],
        preloadedState: { cart: { ...initialCartState, total: 99 } },
      })

      expect(store.getState().cart.total).to.equal(99)
      // A slice with nothing preloaded still falls back to its own seed.
      expect(store.getState().session).to.deep.equal(initialSessionState)
    })

    it('gives a domain that owns no state no key, while still running its reactions', async () => {
      const analytics = defineDomain<unknown, CartAction, RootState, RootAction>({ name: 'analytics' })
      const seen: string[] = []
      analytics.on('CART_ADD_ITEM', async action => {
        seen.push(action.sku)
      })

      const store = createZustandStore<any, any>({ domains: [cartDomain(), analytics] })
      store.dispatch({ type: 'CART_ADD_ITEM', sku: 'a', quantity: 1 })
      await flush()

      expect(Object.keys(store.getState())).to.deep.equal(['cart'])
      expect(seen).to.deep.equal(['a'])
    })
  })

  describe('folds', () => {
    it('applies a fold and recomputes from the result', () => {
      const cart = cartDomain()
      cart.reduce('CART_ADD_ITEM', (state, action) => ({
        items: [...state.items, { sku: action.sku, quantity: action.quantity }],
      }))
      cart.recompute(state => ({ itemCount: state.items.length }))

      const store = createZustandStore<RootState, RootAction>({ domains: [cart, sessionDomain()] })
      store.dispatch({ type: 'CART_ADD_ITEM', sku: 'a', quantity: 2 })

      expect(store.getState().cart.items).to.deep.equal([{ sku: 'a', quantity: 2 }])
      expect(store.getState().cart.itemCount).to.equal(1)
    })

    it('keeps the slice by reference when a partial changed nothing', () => {
      const cart = cartDomain()
      cart.reduce('CART_SET_QUANTITY', () => ({ isPending: false }))

      const store = createZustandStore<RootState, RootAction>({ domains: [cart, sessionDomain()] })
      const before = store.getState()
      store.dispatch({ type: 'CART_SET_QUANTITY', sku: 'a', quantity: 1 })

      expect(store.getState()).to.equal(before)
      expect(store.getState().cart).to.equal(before.cart)
    })

    it('keeps every untouched slice by reference when one slice moves', () => {
      const cart = cartDomain()
      const session = sessionDomain()
      cart.reduce('CART_PRICING_RESPONSE', (_s, a) => ({ total: a.total }))

      const store = createZustandStore<RootState, RootAction>({ domains: [cart, session] })
      const before = store.getState()
      store.dispatch({ type: 'CART_PRICING_RESPONSE', total: 7 })

      expect(store.getState()).to.not.equal(before)
      expect(store.getState().session).to.equal(before.session)
    })
  })

  describe('notifications', () => {
    it('does not notify subscribers for an action that changed nothing', () => {
      const cart = cartDomain()
      const store = createZustandStore<RootState, RootAction>({ domains: [cart, sessionDomain()] })

      let notifications = 0
      store.subscribe(() => {
        notifications += 1
      })
      store.dispatch({ type: 'CART_NOOP' })

      expect(notifications).to.equal(0)
    })

    it('notifies once for an action that did change something', () => {
      const cart = cartDomain()
      cart.reduce('CART_PRICING_RESPONSE', (_s, a) => ({ total: a.total }))
      const store = createZustandStore<RootState, RootAction>({ domains: [cart, sessionDomain()] })

      let notifications = 0
      store.subscribe(() => {
        notifications += 1
      })
      store.dispatch({ type: 'CART_PRICING_RESPONSE', total: 3 })

      expect(notifications).to.equal(1)
    })

    it('differs from the redux host here, which notifies either way', () => {
      const redux = createStore<RootState, RootAction>({ domains: [cartDomain(), sessionDomain()] })

      let notifications = 0
      redux.subscribe(() => {
        notifications += 1
      })
      redux.dispatch({ type: 'CART_NOOP' })

      // Documented, not aspirational: redux notifies on every dispatch, so `shallowEqual` in a
      // selector is what stops the re-render there. Under zustand the fold already stopped it.
      expect(notifications).to.equal(1)
    })

    it('is the mechanism zustand selectors read through', () => {
      const cart = cartDomain()
      cart.reduce('CART_PRICING_RESPONSE', (_s, a) => ({ total: a.total }))
      const store = createZustandStore<RootState, RootAction>({ domains: [cart, sessionDomain()] })

      const seen: number[] = []
      store.subscribe(state => seen.push(state.cart.total))
      store.dispatch({ type: 'CART_PRICING_RESPONSE', total: 4 })
      store.dispatch({ type: 'CART_NOOP' })
      store.dispatch({ type: 'CART_PRICING_RESPONSE', total: 4 })

      // `useStore(store, s => s.cart.total)` is this subscription plus a re-render, so the same
      // three dispatches produce one render, not three.
      expect(seen).to.deep.equal([4])
      expect(typeof useStore).to.equal('function')
    })
  })

  describe('the middleware chain', () => {
    it('places version stamping first without being asked', () => {
      const seen: any[] = []
      const store = createZustandStore<any, any>({
        domains: [cartDomain()],
        middleware: reactions => [recorder(seen), ...reactions],
      })
      store.dispatch({ type: 'CART_NOOP' })

      expect(seen[0].__version).to.be.a('number')
    })

    it('lets the application place its own middleware around the reactions', async () => {
      const order: string[] = []
      const cart = cartDomain()
      cart.on('CART_NOOP', async () => {
        order.push('reaction')
      })

      const before: StoreMiddleware<any, any> = () => next => a => {
        order.push('before')
        return next(a)
      }
      const after: StoreMiddleware<any, any> = () => next => a => {
        order.push('after')
        return next(a)
      }

      const store = createZustandStore<any, any>({
        domains: [cart],
        middleware: reactions => [before, ...reactions, after],
      })
      store.dispatch({ type: 'CART_NOOP' })
      await flush()

      expect(order[0]).to.equal('before')
      expect(order).to.include('after')
      expect(order).to.include('reaction')
    })

    it('re-enters the whole chain for an action a middleware dispatches', async () => {
      const seen: any[] = []
      const cart = cartDomain()
      cart.on('CART_PRICING_REQUEST', async (_action, dispatch) => {
        dispatch({ type: 'CART_PRICING_RESPONSE', total: 1 })
      })

      const store = createZustandStore<any, any>({
        domains: [cart],
        middleware: reactions => [recorder(seen), ...reactions],
      })
      store.dispatch({ type: 'CART_PRICING_REQUEST' })
      await flush()

      // The recorder sits above the reactions, so a reaction's own dispatch reaching it proves the
      // dispatch handed to middleware re-enters at the top rather than resuming below.
      expect(seen.map(a => a.type)).to.deep.equal(['CART_PRICING_REQUEST', 'CART_PRICING_RESPONSE'])
    })
  })

  describe('reactions', () => {
    it('runs after the fold and observes the state as it was before it', async () => {
      const cart = cartDomain()
      const observed: number[] = []
      cart.reduce('CART_PRICING_RESPONSE', (_s, a) => ({ total: a.total }))
      cart.on('CART_PRICING_RESPONSE', async (_action, _dispatch, state) => {
        observed.push(state.cart.total)
      })

      const store = createZustandStore<RootState, RootAction>({ domains: [cart, sessionDomain()] })
      store.dispatch({ type: 'CART_PRICING_RESPONSE', total: 5 })
      await flush()

      expect(observed).to.deep.equal([0])
      expect(store.getState().cart.total).to.equal(5)
    })

    it('settles an awaited dispatch once the chain it triggered has finished', async () => {
      const order: string[] = []
      const cart = cartDomain()
      cart.on('CART_PRICING_REQUEST', async (_action, dispatch) => {
        order.push('request:start')
        await new Promise(resolve => setTimeout(resolve, 5))
        await dispatch({ type: 'CART_PRICING_RESPONSE', total: 3 })
        order.push('request:end')
      })
      cart.on('CART_PRICING_RESPONSE', async () => {
        await new Promise(resolve => setTimeout(resolve, 5))
        order.push('response')
      })

      const store = createZustandStore<RootState, RootAction>({ domains: [cart, sessionDomain()] })
      const dispatchAsync = wrapAsyncDispatch<RootAction>(store.dispatch)

      await dispatchAsync({ type: 'CART_PRICING_REQUEST' })
      order.push('awaited')

      expect(order).to.deep.equal(['request:start', 'response', 'request:end', 'awaited'])
    })

    it('settles an awaited dispatch nobody reacts to, so an await never hangs', async () => {
      const store = createZustandStore<RootState, RootAction>({ domains: [cartDomain(), sessionDomain()] })
      const dispatchAsync = wrapAsyncDispatch<RootAction>(store.dispatch)

      await dispatchAsync({ type: 'CART_NOOP' })

      expect(store.getState().cart).to.deep.equal(initialCartState)
    })

    it('propagates the causing version to what a reaction dispatches', async () => {
      const seen: any[] = []
      const cart = cartDomain()
      cart.on('CART_PRICING_REQUEST', async (_action, dispatch) => {
        await dispatch({ type: 'CART_PRICING_RESPONSE', total: 2 })
      })

      const store = createZustandStore<any, any>({
        domains: [cart],
        middleware: reactions => [recorder(seen), ...reactions],
      })
      store.dispatch({ type: 'CART_PRICING_REQUEST' })
      await flush()

      const [request, response] = seen
      expect(response.__requestVersion).to.equal(request.__version)
    })

    it('routes a throwing reaction to the domain error handler', async () => {
      const cart = cartDomain()
      const caught: string[] = []
      cart.on('CART_PRICING_REQUEST', async () => {
        throw new Error('pricing service is down')
      })
      cart.onError(async (_action, _dispatch, error) => {
        caught.push(error.message)
      })

      const store = createZustandStore<RootState, RootAction>({ domains: [cart, sessionDomain()] })
      store.dispatch({ type: 'CART_PRICING_REQUEST' })
      await flush()

      expect(caught).to.deep.equal(['pricing service is down'])
    })
  })

  describe('watchers', () => {
    it('fires when a selected value changes, with (next, previous, dispatch, state)', async () => {
      const cart = cartDomain()
      cart.reduce('CART_PRICING_RESPONSE', (_s, a) => ({ total: a.total }))
      const seen: any = {}
      cart.watch(
        'cart.total',
        s => ({ total: s.cart.total }),
        (next, previous, dispatch, state) => {
          seen.next = next
          seen.previous = previous
          seen.dispatchIsFunction = typeof dispatch === 'function'
          seen.stateTotal = state.cart.total
        },
      )

      const store = createZustandStore<RootState, RootAction>({ domains: [cart, sessionDomain()] })
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
      session.reduce('SESSION_SIGN_IN', (_s, a) => ({ isSignedIn: true, userId: a.userId }))
      let calls = 0
      cart.watch(
        'cart.total',
        s => ({ total: s.cart.total }),
        () => {
          calls += 1
        },
      )

      const store = createZustandStore<RootState, RootAction>({ domains: [cart, session] })
      store.dispatch({ type: 'SESSION_SIGN_IN', userId: 'u1' })
      await flush()

      expect(store.getState().session.isSignedIn).to.equal(true)
      expect(calls).to.equal(0)
    })

    it('can dispatch from a watcher', async () => {
      const cart = cartDomain()
      cart.reduce('CART_PRICING_RESPONSE', (_s, a) => ({ total: a.total }))
      cart.reduce('CART_CLEAR', () => ({ items: [], total: 0 }))
      cart.watch(
        'cart.overpriced',
        s => ({ total: s.cart.total }),
        (next, _previous, dispatch) => {
          if (next.total > 100) {
            dispatch({ type: 'CART_CLEAR' })
          }
        },
      )

      const store = createZustandStore<RootState, RootAction>({ domains: [cart, sessionDomain()] })
      store.dispatch({ type: 'CART_PRICING_RESPONSE', total: 500 })
      await flush()

      expect(store.getState().cart.total).to.equal(0)
    })

    it('throws when two domains claim the same watch key', () => {
      const a = cartDomain()
      const b = sessionDomain()
      a.watch(
        'shared',
        s => ({ t: s.cart.total }),
        () => undefined,
      )
      b.watch(
        'shared',
        s => ({ t: s.cart.total }),
        () => undefined,
      )

      expect(() => createZustandStore<RootState, RootAction>({ domains: [a, b] })).to.throw(/shared/)
    })
  })

  describe('adapters', () => {
    it('owns subscription lifecycle when subscribers are given', async () => {
      const upstream = makeStream<{ data: { price: number } }>()
      const { handle, subscriber } = createSubscriptions<CartSubscriptions, RootState, any>()
      const received: any[] = []
      handle(
        'CART_PRICE_UPDATES',
        () => upstream.stream as any,
        async payload => {
          received.push(payload)
        },
      )

      const store = createZustandStore<any, any>({
        domains: [cartDomain()],
        adapters: { subscribers: [subscriber] },
      })
      store.dispatch({ type: 'SUBSCRIBE', key: 'CART_PRICE_UPDATES', variables: { sku: 'a' } })
      upstream.emit({ data: { price: 3 } })
      await flush()

      expect(upstream.counts().subscribeCount).to.equal(1)
      expect(received).to.deep.equal([{ price: 3 }])

      store.dispatch({ type: 'UNSUBSCRIBE', key: 'CART_PRICE_UPDATES' })
      await flush()

      expect(upstream.counts().unsubscribeCount).to.equal(1)
    })

    it('binds message routers at startup', () => {
      const t = makeTransport<{ type: 'PRICE_TICK' }>()
      const router = createMessageRouter<{ type: 'PRICE_TICK' }, any, any>(t.transport)
      const cart = cartDomain()
      cart.reduce('CART_PRICING_RESPONSE', (_s, a) => ({ total: a.total }))
      router.handle('PRICE_TICK', (payload, dispatch) => {
        dispatch({ type: 'CART_PRICING_RESPONSE', total: payload.price })
      })

      const store = createZustandStore<any, any>({ domains: [cart], adapters: { routers: [router] } })
      t.emit('PRICE_TICK', { price: 15 })

      expect(store.getState().cart.total).to.equal(15)
    })
  })

  it('registers itself, so storeDispatch works without a separate call', () => {
    const cart = cartDomain()
    cart.reduce('CART_PRICING_RESPONSE', (_s, a) => ({ total: a.total }))

    const store = createZustandStore<RootState, RootAction>({ domains: [cart, sessionDomain()] })
    storeDispatch({ type: 'CART_PRICING_RESPONSE', total: 12 })

    expect(store.getState().cart.total).to.equal(12)
  })
})

// The claim the port rests on: a domain does not know which host it is under. So host the very same
// definition object under both and require the two to agree — same state, same action log, same
// order. Anything the zustand host gets wrong that the redux host gets right shows up here rather
// than as a subtle divergence in an application.
describe('redux and zustand hosts, same domain', () => {
  beforeEach(() => {
    resetConfig()
    resetRegisteredStore()
  })

  /** Everything a domain can do, in one definition, hosted twice. */
  const scriptedCart = () => {
    const cart = defineDomain<CartState, CartAction, RootState, RootAction>({
      name: 'cart',
      initial: initialCartState,
    })

    cart.reduce('CART_ADD_ITEM', (state, action) => ({
      items: [...state.items, { sku: action.sku, quantity: action.quantity }],
    }))
    cart.reduce('CART_PRICING_REQUEST', { isPending: true })
    cart.reduce('CART_PRICING_RESPONSE', (_state, action) => ({ total: action.total, isPending: false }))
    cart.reduce('CART_NOOP', () => ({}))
    cart.recompute(state => ({ itemCount: state.items.length }))

    cart.on('CART_PRICING_REQUEST', async (_action, dispatch, state) => {
      await dispatch({ type: 'CART_PRICING_RESPONSE', total: state.cart.items.length * 10 })
    })

    cart.watch(
      'cart.pricing',
      s => ({ pending: s.cart.isPending }),
      (next, _previous, _dispatch) => {
        fired.push(next.pending)
      },
    )

    return cart
  }

  let fired: boolean[] = []

  const script = async (dispatch: (action: any) => Promise<void>) => {
    await dispatch({ type: 'CART_ADD_ITEM', sku: 'a', quantity: 1 })
    await dispatch({ type: 'CART_ADD_ITEM', sku: 'b', quantity: 2 })
    await dispatch({ type: 'CART_NOOP' })
    await dispatch({ type: 'CART_PRICING_REQUEST' })
  }

  it('reaches the same state through the same actions', async () => {
    const cart = scriptedCart()
    const session = sessionDomain()

    resetActionVersion()
    fired = []
    const reduxSeen: any[] = []
    const redux = createStore<RootState, RootAction>({
      domains: [cart, session],
      middleware: reactions => [recorder(reduxSeen), ...reactions],
    })
    await script(wrapAsyncDispatch<any>(redux.dispatch))
    await flush()
    const reduxWatched = [...fired]

    resetActionVersion()
    resetRegisteredStore()
    fired = []
    const zustandSeen: any[] = []
    const zustand = createZustandStore<RootState, RootAction>({
      domains: [cart, session],
      middleware: reactions => [recorder(zustandSeen), ...reactions],
    })
    await script(wrapAsyncDispatch<any>(zustand.dispatch))
    await flush()
    const zustandWatched = [...fired]

    expect(zustand.getState()).to.deep.equal(redux.getState())
    expect(zustand.getState().cart.total).to.equal(20)
    expect(zustandSeen.map(a => a.type)).to.deep.equal(reduxSeen.map(a => a.type))
    expect(zustandSeen.map(a => a.__version)).to.deep.equal(reduxSeen.map(a => a.__version))
    expect(zustandSeen.map(a => a.__requestVersion)).to.deep.equal(reduxSeen.map(a => a.__requestVersion))
    expect(zustandWatched).to.deep.equal(reduxWatched)
  })
})
