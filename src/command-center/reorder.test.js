import { describe, test, expect } from 'vitest'
import { dropIndexAt, planReorder, positionBetween, stepSlot } from './reorder'
import { dropMarkClass } from './useReorderDrag'

const task = (id, position) => ({ id, position, title: id })
const TASKS = [task('a', 1), task('b', 2), task('c', 3), task('d', 4)]

describe('positionBetween', () => {
  test('the midpoint between two neighbours, or one past the only neighbour', () => {
    expect(positionBetween(1, 2)).toBe(1.5)
    expect(positionBetween(undefined, 2)).toBe(1)
    expect(positionBetween(3, undefined)).toBe(4)
    expect(positionBetween(undefined, undefined)).toBe(0)
  })
})

describe('dropIndexAt', () => {
  const rects = [{ top: 0, height: 44 }, { top: 44, height: 44 }, { top: 88, height: 44 }]
  test('the upper half of a row drops before it, the lower half after it', () => {
    expect(dropIndexAt(rects, 10)).toBe(0)
    expect(dropIndexAt(rects, 30)).toBe(1)
    expect(dropIndexAt(rects, 60)).toBe(1)
    expect(dropIndexAt(rects, 120)).toBe(3)
    expect(dropIndexAt([], 50)).toBe(0)
  })
})

describe('stepSlot', () => {
  test('one step up or down, or to either end', () => {
    expect(stepSlot(2, 4, 'up')).toBe(1)
    expect(stepSlot(2, 4, 'down')).toBe(4)
    expect(stepSlot(0, 4, 'up')).toBe(0)
    expect(stepSlot(3, 4, 'down')).toBe(4)
    expect(stepSlot(2, 4, 'top')).toBe(0)
    expect(stepSlot(2, 4, 'bottom')).toBe(4)
  })
})

describe('planReorder', () => {
  test('moves one task to the midpoint of its new neighbours', () => {
    const plan = planReorder(TASKS, 'd', 1)
    expect(plan.updates).toEqual([{ id: 'd', position: 1.5 }])
    expect(plan.order).toEqual(['a', 'd', 'b', 'c'])
    expect(plan.index).toBe(1)
  })

  test('moving down counts the slot after the row it passes', () => {
    const plan = planReorder(TASKS, 'a', 3)
    expect(plan.updates).toEqual([{ id: 'a', position: 3.5 }])
    expect(plan.order).toEqual(['b', 'c', 'a', 'd'])
  })

  test('the ends go one past the first or last row', () => {
    expect(planReorder(TASKS, 'c', 0).updates).toEqual([{ id: 'c', position: 0 }])
    expect(planReorder(TASKS, 'b', 4).updates).toEqual([{ id: 'b', position: 5 }])
  })

  test('the slots either side of the row, or an unknown task, are no move', () => {
    expect(planReorder(TASKS, 'b', 1)).toBeNull()
    expect(planReorder(TASKS, 'b', 2)).toBeNull()
    expect(planReorder(TASKS, 'zz', 0)).toBeNull()
  })

  test('a slot past the ends is held to them', () => {
    expect(planReorder(TASKS, 'c', 99).order).toEqual(['a', 'b', 'd', 'c'])
    expect(planReorder(TASKS, 'c', -5).order).toEqual(['c', 'a', 'b', 'd'])
  })

  test('when the neighbours leave no room between them, the whole group is numbered again in its new order', () => {
    const tight = [task('a', 1), task('b', 1), task('c', 1), task('d', 7)]
    const plan = planReorder(tight, 'd', 1)
    expect(plan.order).toEqual(['a', 'd', 'b', 'c'])
    expect(plan.updates).toEqual([
      { id: 'a', position: 1 }, { id: 'd', position: 2 }, { id: 'b', position: 3 }, { id: 'c', position: 4 },
    ])
  })

  test('a task with no position yet counts as 0', () => {
    const plan = planReorder([{ id: 'a' }, task('b', 1)], 'b', 0)
    expect(plan.updates).toEqual([{ id: 'b', position: -1 }])
  })
})

describe('dropMarkClass', () => {
  test('marks the held row and the slot under the pointer, but not the slots around the held row', () => {
    expect(dropMarkClass(null, 0, 4)).toBe('')
    const drag = { id: 'b', index: 1, slot: 3 }
    expect(dropMarkClass(drag, 1, 4)).toBe(' is-dragging')
    expect(dropMarkClass(drag, 3, 4)).toBe(' is-drop-before')
    expect(dropMarkClass(drag, 0, 4)).toBe('')
    expect(dropMarkClass({ id: 'b', index: 1, slot: 4 }, 3, 4)).toBe(' is-drop-after')
    expect(dropMarkClass({ id: 'b', index: 1, slot: 1 }, 0, 4)).toBe('')
    expect(dropMarkClass({ id: 'b', index: 1, slot: 2 }, 2, 4)).toBe('')
  })
})
