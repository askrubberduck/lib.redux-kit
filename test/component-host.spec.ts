import { expect } from 'chai'
import { configure, resetConfig } from '../src/config'
import { defineDomain } from '../src/domain'
import { notifyWatchers, seedWatchers, WatcherEntry } from '../src/internal/local-watchers'
import { flush } from '../src/testing'

// The component host has no `store.subscribe` to hang watchers off, so it drives them itself.
// These exercise that plumbing directly: `useDomain` is a thin wrapper around it, and testing it
// through React would need a renderer to prove nothing the plumbing does not already say.

type PanelState = { n: number; label: string }
type PanelAction = { type: 'INC' } | { type: 'RELABEL'; label: string }

const panelDomain = () => {
  const domain = defineDomain<PanelState, PanelAction>({ name: 'panel', initial: { n: 0, label: 'a' } })
  domain.reduce('INC', state => ({ n: state.n + 1 }))
  domain.reduce('RELABEL', (_state, action) => ({ label: action.label }))
  return domain
}

const entriesOf = (domain: ReturnType<typeof panelDomain>) =>
  domain.$.watchers() as unknown as WatcherEntry<PanelState, PanelAction>[]

const noopDispatch = (async () => undefined) as any

describe('component-hosted watchers', () => {
  afterEach(() => resetConfig())

  it('fires when the selected value changes, with (next, previous, dispatch, state)', async () => {
    const domain = panelDomain()
    const calls: any[] = []
    domain.watch('panel:n', s => ({ n: s.n }), async (next, previous, _dispatch, state) => {
      calls.push({ next, previous, state })
    })

    const entries = entriesOf(domain)
    const seen = seedWatchers(entries, { n: 0, label: 'a' }, noopDispatch)

    notifyWatchers(entries, seen, { n: 1, label: 'a' }, noopDispatch)
    await flush()

    expect(calls).to.have.length(1)
    expect(calls[0].next).to.deep.equal({ n: 1 })
    expect(calls[0].previous).to.deep.equal({ n: 0 })
    expect(calls[0].state).to.deep.equal({ n: 1, label: 'a' })
  })

  it('does not fire on arrival — the mount value is the first baseline', async () => {
    const domain = panelDomain()
    let fired = 0
    domain.watch('panel:n', s => ({ n: s.n }), async () => {
      fired += 1
    })

    const entries = entriesOf(domain)
    const seen = seedWatchers(entries, { n: 7, label: 'a' }, noopDispatch)

    // The very first transition lands on the same value the component mounted with.
    notifyWatchers(entries, seen, { n: 7, label: 'a' }, noopDispatch)
    await flush()

    expect(fired).to.equal(0)
  })

  it('does not fire when an unrelated part of the state changed', async () => {
    const domain = panelDomain()
    let fired = 0
    domain.watch('panel:n', s => ({ n: s.n }), async () => {
      fired += 1
    })

    const entries = entriesOf(domain)
    const seen = seedWatchers(entries, { n: 0, label: 'a' }, noopDispatch)

    notifyWatchers(entries, seen, { n: 0, label: 'b' }, noopDispatch)
    await flush()

    expect(fired).to.equal(0)
  })

  it('records the new value before handlers run, so a repeat transition is not re-fired', async () => {
    const domain = panelDomain()
    let fired = 0
    domain.watch('panel:n', s => ({ n: s.n }), async () => {
      fired += 1
    })

    const entries = entriesOf(domain)
    const seen = seedWatchers(entries, { n: 0, label: 'a' }, noopDispatch)

    notifyWatchers(entries, seen, { n: 1, label: 'a' }, noopDispatch)
    notifyWatchers(entries, seen, { n: 1, label: 'a' }, noopDispatch)
    await flush()

    expect(fired).to.equal(1)
  })

  it('logs a throwing handler instead of breaking the dispatch that triggered it', async () => {
    const logged: any[] = []
    configure({ logger: { debug: () => undefined, info: () => undefined, error: (...a) => logged.push(a) } })

    const domain = panelDomain()
    domain.watch('panel:n', s => ({ n: s.n }), async () => {
      throw new Error('watcher blew up')
    })

    const entries = entriesOf(domain)
    const seen = seedWatchers(entries, { n: 0, label: 'a' }, noopDispatch)

    expect(() => notifyWatchers(entries, seen, { n: 1, label: 'a' }, noopDispatch)).to.not.throw()
    await flush()

    expect(logged).to.have.length(1)
    expect(logged[0][1]).to.equal('watcher blew up')
  })
})
