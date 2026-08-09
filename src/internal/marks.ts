/**
 * Bookkeeping the kit attaches to an action while it travels through a domain's middleware.
 *
 * Symbols rather than string keys for two reasons: an application can never collide with them
 * by naming an action field the same thing, and they do not appear in a serialised action, so a
 * devtools log or an analytics tap sees only what the author actually wrote.
 */

/** Resolves the promise returned by an awaited dispatch. */
export const SETTLE = Symbol('redux-kit/settle')

/** Set once an action has reached a handler, so its promise settles exactly once. */
export const CLAIMED = Symbol('redux-kit/claimed')
