import { expect } from 'chai'
import { wrapVersionDispatch } from '../src/dispatch'
import { defineDomain } from '../src/domain'
import { releaseActionVersion, resetActionVersion } from '../src/version'
import { createTestStore, flush } from '../src/testing'
import { CartAction, CartState, RootAction, RootState, initialCartState } from './fixtures'

const cartDomain = () =>
  defineDomain<CartState, CartAction, RootState, RootAction>({ name: 'cart', initial: initialCartState })

describe('action versioning', () => {
  beforeEach(() => resetActionVersion())

  it('stamps a monotonically increasing __version on every action', () => {
    const store = createTestStore<any, any>({ domains: [cartDomain()] })

    store.dispatch({ type: 'CART_NOOP' })
    store.dispatch({ type: 'CART_NOOP' })
    store.dispatch({ type: 'CART_NOOP' })

    expect(store.actions().map((a: any) => a.__version)).to.deep.equal([1, 2, 3])
  })

  it('never issues version 0, so a falsy check reliably means absent', () => {
    // The point of the 1-based counter: a consumer writes `!action.__requestVersion` rather
    // than having to remember `!== undefined`.
    const issued = Array.from({ length: 50 }, () => releaseActionVersion())

    expect(issued.every(v => v > 0)).to.equal(true)
  })

  it('never overwrites a version an action already carries', () => {
    const store = createTestStore<any, any>({ domains: [cartDomain()] })

    store.dispatch({ type: 'CART_NOOP', __version: 99 } as any)

    expect((store.actions()[0] as any).__version).to.equal(99)
  })

  it('stamps __requestVersion from the immediate cause, one hop up', async () => {
    const cart = cartDomain()
    const seen: Record<string, { version?: number; requestVersion?: number }> = {}

    cart.on('CART_SET_QUANTITY', async (action, dispatch) => {
      seen.setQuantity = { version: action.__version, requestVersion: (action as any).__requestVersion }
      await dispatch({ type: 'CART_PRICING_REQUEST' })
    })
    cart.on('CART_PRICING_REQUEST', async (action, dispatch) => {
      seen.request = { version: action.__version, requestVersion: (action as any).__requestVersion }
      await dispatch({ type: 'CART_PRICING_RESPONSE', total: 5 })
    })
    cart.on('CART_PRICING_RESPONSE', async action => {
      seen.response = { version: action.__version, requestVersion: (action as any).__requestVersion }
    })

    const store = createTestStore<any, any>({ domains: [cart] })
    await store.dispatchAsync({ type: 'CART_SET_QUANTITY', sku: 'a', quantity: 2 })

    // Each hop is seeded from the dispatching action's own version, so __requestVersion names
    // the parent rather than the root. Carrying the root further is a manual act.
    expect(seen.setQuantity).to.deep.equal({ version: 1, requestVersion: undefined })
    expect(seen.request).to.deep.equal({ version: 2, requestVersion: 1 })
    expect(seen.response).to.deep.equal({ version: 3, requestVersion: 2 })
  })

  it('carries the root version further when a reaction forwards it by hand', async () => {
    const cart = cartDomain()
    let responseRequestVersion: number | undefined

    cart.on('CART_SET_QUANTITY', async (_a, dispatch) => {
      await dispatch({ type: 'CART_PRICING_REQUEST' })
    })
    cart.on('CART_PRICING_REQUEST', async (action, dispatch) => {
      await dispatch({
        type: 'CART_PRICING_RESPONSE',
        total: 5,
        __requestVersion: (action as any).__requestVersion,
      } as any)
    })
    cart.on('CART_PRICING_RESPONSE', async action => {
      responseRequestVersion = (action as any).__requestVersion
    })

    const store = createTestStore<any, any>({ domains: [cart] })
    await store.dispatchAsync({ type: 'CART_SET_QUANTITY', sku: 'a', quantity: 2 })

    expect(responseRequestVersion).to.equal(1)
  })

  it('wrapVersionDispatch stamps, and does not overwrite a value already present', async () => {
    const dispatched: any[] = []
    const dispatch = wrapVersionDispatch(async (a: any) => {
      dispatched.push(a)
    }, 7)

    await dispatch({ type: 'A' } as any)
    await dispatch({ type: 'B', __requestVersion: 3 } as any)

    expect(dispatched[0].__requestVersion).to.equal(7)
    expect(dispatched[1].__requestVersion).to.equal(3)
  })

  it('supports the stale-response-rejection pattern a reduce builds on top', async () => {
    type Watermarked = CartState & { watermark: number }
    const cart = defineDomain<Watermarked, any>({
      name: 'cart',
      initial: { ...initialCartState, watermark: 0 },
    })

    cart.reduce('CART_SET_QUANTITY', (_s, action) => ({ isPending: true, watermark: action.__version }))
    cart.reduce('CART_PRICING_RESPONSE', (state, action) => {
      // A falsy check is safe: versions are 1-based, so 0 never occurs.
      if (action.__requestVersion && action.__requestVersion < state.watermark) {
        return undefined
      }
      return { total: action.total, isPending: false }
    })

    const store = createTestStore<any, any>({ domains: [cart] })
    // Twice, so the watermark is at least 2 and a "stale" value below it is still truthy —
    // version 0 does not exist, so it cannot stand in for an older request.
    store.dispatch({ type: 'CART_SET_QUANTITY', sku: 'a', quantity: 1 })
    store.dispatch({ type: 'CART_SET_QUANTITY', sku: 'a', quantity: 2 })
    const watermark = store.getState().cart.watermark
    expect(watermark).to.be.greaterThan(1)

    store.dispatch({ type: 'CART_PRICING_RESPONSE', total: 99, __requestVersion: watermark - 1 } as any)
    expect(store.getState().cart.total).to.equal(0)

    store.dispatch({ type: 'CART_PRICING_RESPONSE', total: 42, __requestVersion: watermark + 1 } as any)
    expect(store.getState().cart.total).to.equal(42)

    await flush()
  })
})
