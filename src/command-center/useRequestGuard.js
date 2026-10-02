import { useCallback, useRef } from 'react'

/**
 * Guards a fetch against its own earlier calls.
 *
 * Every tab both polls on a timer and refetches after the user does something, so two requests for
 * the same list are routinely in flight at once. Whichever response arrives last wins, and that is
 * not always the one issued last: a slow poll started before an edit can land after it and put the
 * pre-edit list back on screen, so a task ticked complete reappears unchecked until the next poll.
 *
 * Call `beginRequest()` when a fetch starts; it returns a predicate that is true only while that
 * fetch is still the most recent one. Guard every setState on it.
 *
 *   const beginRequest = useRequestGuard()
 *   const load = useCallback(async () => {
 *     const isCurrent = beginRequest()
 *     const res = await api.listTasks()
 *     if (isCurrent()) setTasks(res.tasks)
 *   }, [api, beginRequest])
 */
export function useRequestGuard() {
  const sequence = useRef(0)
  return useCallback(() => {
    const mine = sequence.current + 1
    sequence.current = mine
    return () => mine === sequence.current
  }, [])
}
