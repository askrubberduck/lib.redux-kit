// The authoring surface. Everything here is something an application writes against; the wiring
// each host performs is deliberately not exported.

export { defineDomain } from './domain'
export type { HostedDomain, Domain } from './domain'

// Adapters — turn an outside stream into dispatched actions.
export { createSubscriptions } from './subscriptions'
export { createMessageRouter } from './message-router'
export { createAuditMiddleware } from './audit'

// Bridges and configuration.
export { createDispatchRegistry } from './dispatch-registry'
export { registerStore, storeDispatch } from './registry'
export { configure } from './config'
export type { Settings, Logger } from './config'

// Types an application names when it writes a domain, a selector or an adapter.
export type {
  Action,
  AsyncDispatch,
  Dispatch,
  ObservableLike,
  ResultLike,
  Selector,
  Subscription,
  SubscriptionAction,
  VersionedAction,
  WatchHandler,
} from './types'
export type { MessageTransport } from './message-router'

// The store host lives at '@askrubberduck/redux-kit/store' — it is the one part that needs redux.
// React bindings live at '@askrubberduck/redux-kit/react', test helpers at '@askrubberduck/redux-kit/testing'.
