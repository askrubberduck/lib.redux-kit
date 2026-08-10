import { dequal as isEqual } from 'dequal'

/**
 * Whether any entry of `next` differs from `current`. Used to decide whether a reducer produced
 * a real change: when nothing differs the reducer returns the existing state object by
 * reference, so `shallowEqual` selectors do not re-render.
 */
export const hasChanges = <T extends object>(next: T, current: T): boolean =>
  Object.entries(next).some(([key, value]) => !isEqual(value, (current as any)?.[key]))

export { isEqual }
