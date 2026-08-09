import { expect } from 'chai'
import { configure, resetConfig } from '../src/config'
import { defineDomain } from '../src/domain'
import { resetActionVersion } from '../src/version'
import { createTestStore, flush } from '../src/testing'
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

const sessionDomain = () => {
  const domain = defineDomain<SessionState, SessionAction, RootState, RootAction>({
    name: 'session',
    initial: initialSessionState,
  })
  domain.reduce('SESSION_SIGN_IN', (_s, a) => ({ isSignedIn: true, userId: a.userId }))
  return domain
}


/** A domain's reducer, asserting it has one — a stateless domain deliberately does not. */
const reducerOf = <S,>(domain: { $: { reducer?: (state: S | undefined, action: any) => S } }) => {
  if (!domain.$.reducer) {
    throw new Error('domain has no reducer')
  }
  return domain.$.reducer
}

describe('defineDomain', () => {
  beforeEach(() => {
    resetConfig()
    resetActionVersion()
  })

  describe('reduce', () => {
    it('returns the identical state object when the partial changes nothing', () => {
      const cart = defineDomain<CartState, CartAction>({ name: 'cart', initial: initialCartState })
      cart.reduce('CART_NOOP', state => ({ total: state.total }))

      // Reference equality: this is what stops shallowEqual selectors re-rendering.
      expect(reducerOf(cart)(initialCartState, { type: 'CART_NOOP' })).to.equal(initialCartState)
    })

    it('treats undefined as "leave it alone" and {} as an explicit no-op', () => {
      const cart = defineDomain<CartState, CartAction>({ name: 'cart', initial: initialCartState })
      cart.reduce('CART_NOOP', () => undefined)
      cart.reduce('CART_CLEAR', () => ({}))

      expect(reducerOf(cart)(initialCartState, { type: 'CART_NOOP' })).to.equal(initialCartState)
      expect(reducerOf(cart)(initialCartState, { type: 'CART_CLEAR' })).to.equal(initialCartState)
    })

    it('treats setting a key to undefined as no change when the state lacks it', () => {
      // The state reads identically either way, so the reduce returns the same object and no
      // shallowEqual selector re-renders. Pinned because it is a judgement, not an accident:
      // comparing entry-by-entry says "no change", comparing key sets would say otherwise.
      type S = { total: number; error?: string }
      const d = defineDomain<S, CartAction>({ name: 'cart', initial: { total: 0 } })
      d.reduce('CART_NOOP', () => ({ error: undefined }))

      const before = { total: 0 } as S
      expect(reducerOf(d)(before, { type: 'CART_NOOP' })).to.equal(before)
    })

    it('accepts a constant partial in place of a function', () => {
      const cart = defineDomain<CartState, CartAction>({ name: 'cart', initial: initialCartState })
      cart.reduce('CART_PRICING_REQUEST', { isPending: true })

      expect(reducerOf(cart)(initialCartState, { type: 'CART_PRICING_REQUEST' }).isPending).to.equal(true)
    })

    it('registers one handler against several action types', () => {
      const cart = defineDomain<CartState, CartAction>({ name: 'cart', initial: initialCartState })
      cart.reduce(['CART_PRICING_REQUEST', 'CART_ADD_ITEM'], { isPending: true })

      expect(reducerOf(cart)(initialCartState, { type: 'CART_ADD_ITEM' }).isPending).to.equal(true)
      expect(reducerOf(cart)(initialCartState, { type: 'CART_PRICING_REQUEST' }).isPending).to.equal(true)
    })

    it('throws on a duplicate registration, naming the domain', () => {
      const cart = defineDomain<CartState, CartAction>({ name: 'cart', initial: initialCartState })
      cart.reduce('CART_CLEAR', initialCartState)

      expect(() => cart.reduce('CART_CLEAR', initialCartState)).to.throw(/cart/)
    })
  })

  describe('derive', () => {
    it('recomputes after every reduce that changed something', () => {
      const cart = defineDomain<CartState, CartAction>({ name: 'cart', initial: initialCartState })
      cart.reduce('CART_ADD_ITEM', (state, a) => ({ items: [...state.items, { sku: a.sku, quantity: a.quantity }] }))
      cart.derive(state => ({ itemCount: state.items.length }))

      const next = reducerOf(cart)(initialCartState, { type: 'CART_ADD_ITEM', sku: 'a', quantity: 1 })

      expect(next.itemCount).to.equal(1)
    })

    it('does not run when the reduce changed nothing', () => {
      const cart = defineDomain<CartState, CartAction>({ name: 'cart', initial: initialCartState })
      let calls = 0
      cart.reduce('CART_NOOP', state => ({ total: state.total }))
      cart.derive(state => {
        calls += 1
        return { itemCount: state.items.length }
      })

      reducerOf(cart)(initialCartState, { type: 'CART_NOOP' })

      expect(calls).to.equal(0)
    })

    // This capability existed only in the component host before the domain was unified.
    it('is available to a store-hosted domain', async () => {
      const cart = defineDomain<CartState, CartAction, RootState, RootAction>({
        name: 'cart',
        initial: initialCartState,
      })
      cart.reduce('CART_ADD_ITEM', (state, a) => ({ items: [...state.items, { sku: a.sku, quantity: a.quantity }] }))
      cart.derive(state => ({ itemCount: state.items.length }))

      const store = createTestStore<RootState, RootAction>({ domains: [cart, sessionDomain()] })
      store.dispatch({ type: 'CART_ADD_ITEM', sku: 'a', quantity: 1 })

      expect(store.getState().cart.itemCount).to.equal(1)
    })
  })

  describe('react', () => {
    it('receives (action, dispatch, state) with state always passed', async () => {
      const cart = defineDomain<CartState, CartAction, RootState, RootAction>({
        name: 'cart',
        initial: initialCartState,
      })
      const seen: any = {}
      // Two declared parameters: state still arrives. The arity rule is gone.
      cart.on('CART_PRICING_REQUEST', (async (...args: any[]) => {
        seen.action = args[0]
        seen.dispatchIsFunction = typeof args[1] === 'function'
        seen.state = args[2]
      }) as any)

      const store = createTestStore<RootState, RootAction>({ domains: [cart, sessionDomain()] })
      store.dispatch({ type: 'CART_PRICING_REQUEST' })
      await flush()

      expect(seen.action.type).to.equal('CART_PRICING_REQUEST')
      expect(seen.dispatchIsFunction).to.equal(true)
      expect(seen.state.cart).to.deep.equal(initialCartState)
    })

    it('sees the state from BEFORE the action reached the folds', async () => {
      const session = sessionDomain()
      let signedInDuring: boolean | undefined
      session.on('SESSION_SIGN_IN', async (_a, _d, state) => {
        signedInDuring = state.session.isSignedIn
      })

      const store = createTestStore<RootState, RootAction>({
        domains: [defineDomain<CartState, CartAction, RootState, RootAction>({ name: 'cart', initial: initialCartState }), session],
      })
      store.dispatch({ type: 'SESSION_SIGN_IN', userId: 'u1' })
      await flush()

      expect(signedInDuring).to.equal(false)
      expect(store.getState().session.isSignedIn).to.equal(true)
    })

    it('resolves an awaited dispatch only after the reaction finishes', async () => {
      const cart = defineDomain<CartState, CartAction, RootState, RootAction>({
        name: 'cart',
        initial: initialCartState,
      })
      const order: string[] = []
      cart.reduce('CART_PRICING_RESPONSE', (_s, a) => ({ total: a.total, isPending: false }))
      cart.on('CART_PRICING_REQUEST', async (_a, dispatch) => {
        order.push('start')
        await new Promise(r => setTimeout(r, 10))
        await dispatch({ type: 'CART_PRICING_RESPONSE', total: 7 })
        order.push('end')
      })

      const store = createTestStore<RootState, RootAction>({ domains: [cart, sessionDomain()] })
      await store.dispatchAsync({ type: 'CART_PRICING_REQUEST' })
      order.push('awaited')

      expect(order).to.deep.equal(['start', 'end', 'awaited'])
      expect(store.getState().cart.total).to.equal(7)
    })

    it('settles an awaited dispatch nobody reacts to, rather than hanging', async () => {
      const store = createTestStore<RootState, RootAction>({
        domains: [defineDomain<CartState, CartAction, RootState, RootAction>({ name: 'cart', initial: initialCartState }), sessionDomain()],
      })

      await store.dispatchAsync({ type: 'CART_NOOP' })
    })

    it('lets one domain react to another domain\'s action', async () => {
      const cart = defineDomain<CartState, CartAction | SessionAction, RootState, RootAction>({
        name: 'cart',
        initial: initialCartState,
      })
      cart.reduce('SESSION_SIGN_OUT', initialCartState)
      let reacted = false
      cart.on('SESSION_SIGN_IN', async () => {
        reacted = true
      })

      const store = createTestStore<RootState, RootAction>({ domains: [cart, sessionDomain()] })
      store.dispatch({ type: 'SESSION_SIGN_IN', userId: 'u1' })
      await flush()

      expect(reacted).to.equal(true)
    })
  })

  describe('onError', () => {
    it('catches a throwing reaction, in preference to the configured handler', async () => {
      let caught: any
      let fellBack = false
      configure({ onUnhandledError: () => { fellBack = true } })

      const cart = defineDomain<CartState, CartAction, RootState, RootAction>({ name: 'cart', initial: initialCartState })
      cart.on('CART_PRICING_REQUEST', async () => {
        throw new Error('pricing down')
      })
      cart.onError(async (_a, _d, error) => {
        caught = error
      })

      const store = createTestStore<RootState, RootAction>({ domains: [cart, sessionDomain()] })
      store.dispatch({ type: 'CART_PRICING_REQUEST' })
      await flush()

      expect(caught?.message).to.equal('pricing down')
      expect(fellBack).to.equal(false)
    })

    it('falls back to the configured handler when the domain registered none', async () => {
      let caught: any
      configure({ onUnhandledError: error => { caught = error } })

      const cart = defineDomain<CartState, CartAction, RootState, RootAction>({ name: 'cart', initial: initialCartState })
      cart.on('CART_PRICING_REQUEST', async () => {
        throw new Error('pricing down')
      })

      const store = createTestStore<RootState, RootAction>({ domains: [cart, sessionDomain()] })
      store.dispatch({ type: 'CART_PRICING_REQUEST' })
      await flush()

      expect(caught?.message).to.equal('pricing down')
    })

    // This capability existed only in the store host before the domain was unified.
    it('is available to a component-hosted domain', async () => {
      let caught: any
      configure({ onUnhandledError: error => { caught = error } })

      const panel = defineDomain<CartState, CartAction>({ name: 'panel', initial: initialCartState })
      panel.on('CART_PRICING_REQUEST', async () => {
        throw new Error('local failure')
      })

      panel.$.runLocal(initialCartState, { type: 'CART_PRICING_REQUEST' }, async () => undefined)
      await flush()

      expect(caught?.message).to.equal('local failure')
    })
  })

  describe('the same definition in either host', () => {
    const makePanel = () => {
      const panel = defineDomain<CartState, CartAction>({ name: 'cart', initial: initialCartState })
      panel.reduce('CART_ADD_ITEM', (state, a) => ({ items: [...state.items, { sku: a.sku, quantity: a.quantity }] }))
      panel.derive(state => ({ itemCount: state.items.length }))
      return panel
    }

    it('folds and derives identically when hosted by a component', () => {
      const next = makePanel().$.runLocal(initialCartState, { type: 'CART_ADD_ITEM', sku: 'a', quantity: 1 }, async () => undefined)

      expect(next.itemCount).to.equal(1)
    })

    it('folds and derives identically when hosted by a store', () => {
      const store = createTestStore<any, any>({ domains: [makePanel()] })
      store.dispatch({ type: 'CART_ADD_ITEM', sku: 'a', quantity: 1 })

      expect(store.getState().cart.itemCount).to.equal(1)
    })

    it('resolves a factory seed once per call, so hosts do not share state', () => {
      const panel = defineDomain<CartState, CartAction>({ name: 'cart', initial: () => ({ ...initialCartState, items: [] }) })

      expect(panel.$.seed()).to.not.equal(panel.$.seed())
      expect(panel.$.seed()).to.deep.equal(initialCartState)
    })
  })
})
