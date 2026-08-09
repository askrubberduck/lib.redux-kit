import 'setimmediate'

// A deliberately generic domain: a cart whose totals are recomputed by a slow pricing service,
// and a session that can sign in and out. Between them they exercise every capability a domain
// has — optimistic edits racing a response, derived values, a reset action, and a watcher.

export type CartState = {
  items: { sku: string; quantity: number }[]
  total: number
  itemCount: number
  isPending: boolean
  error?: string
}

export type SessionState = { isSignedIn: boolean; userId?: string }

export type RootState = { cart: CartState; session: SessionState }

export type CartAction =
  | { type: 'CART_ADD_ITEM'; sku: string; quantity: number }
  | { type: 'CART_SET_QUANTITY'; sku: string; quantity: number }
  | { type: 'CART_CLEAR' }
  | { type: 'CART_PRICING_REQUEST' }
  | { type: 'CART_PRICING_RESPONSE'; total: number }
  | { type: 'CART_PRICING_ERROR'; error: string }
  | { type: 'CART_NOOP' }

export type SessionAction =
  | { type: 'SESSION_SIGN_IN'; userId: string }
  | { type: 'SESSION_SIGN_OUT' }

export type RootAction = CartAction | SessionAction

export const initialCartState: CartState = { items: [], total: 0, itemCount: 0, isPending: false }
export const initialSessionState: SessionState = { isSignedIn: false }
