import { describe, test, expect } from 'vitest'
import { dropIndexAt, dropTargetAt, planInsert, planReorder, positionAfter, positionBetween, stepSlot } from './reorder'
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
    expect(dropMarkClass(null, 'g', 0, 4)).toBe('')
    const drag = { id: 'b', index: 1, group: 'g', target: 'g', slot: 3 }
    expect(dropMarkClass(drag, 'g', 1, 4)).toBe(' is-dragging')
    expect(dropMarkClass(drag, 'g', 3, 4)).toBe(' is-drop-before')
    expect(dropMarkClass(drag, 'g', 0, 4)).toBe('')
    expect(dropMarkClass({ ...drag, slot: 4 }, 'g', 3, 4)).toBe(' is-drop-after')
    expect(dropMarkClass({ ...drag, slot: 1 }, 'g', 0, 4)).toBe('')
    expect(dropMarkClass({ ...drag, slot: 2 }, 'g', 2, 4)).toBe('')
  })

  test('marks the slot in the group the pointer is over, and nothing in the others', () => {
    const drag = { id: 'b', index: 1, group: 'g', target: 'h', slot: 0 }
    expect(dropMarkClass(drag, 'g', 1, 4)).toBe(' is-dragging')
    expect(dropMarkClass(drag, 'g', 0, 4)).toBe('')
    expect(dropMarkClass(drag, 'h', 0, 2)).toBe(' is-drop-before')
    expect(dropMarkClass({ ...drag, slot: 2 }, 'h', 1, 2)).toBe(' is-drop-after')
    // The slots beside the held row's own index mean nothing in another group.
    expect(dropMarkClass({ ...drag, slot: 1 }, 'h', 1, 3)).toBe(' is-drop-before')
  })
})

describe('dropTargetAt', () => {
  const row = (top) => ({ top, height: 40 })
  const layout = [
    { id: 'today', bottom: 140, headerBottom: 40, rows: [row(40), row(80)] },
    { id: 'tomorrow', bottom: 220, headerBottom: 180, rows: [row(180)] },
    { id: 'later', bottom: 260, headerBottom: 240, rows: [] },
  ]
  test('finds the group under the pointer and the slot in it', () => {
    expect(dropTargetAt(layout, 50)).toEqual({ groupId: 'today', slot: 0, header: false })
    expect(dropTargetAt(layout, 115)).toEqual({ groupId: 'today', slot: 2, header: false })
    expect(dropTargetAt(layout, 200)).toEqual({ groupId: 'tomorrow', slot: 1, header: false })
  })
  test('a header drops at the top of its group, and a group with no rows takes slot 0', () => {
    expect(dropTargetAt(layout, 150)).toEqual({ groupId: 'tomorrow', slot: 0, header: true })
    expect(dropTargetAt(layout, 250)).toEqual({ groupId: 'later', slot: 0, header: false })
  })
  test('above the first group and below the last land in them', () => {
    expect(dropTargetAt(layout, -10).groupId).toBe('today')
    expect(dropTargetAt(layout, 900).groupId).toBe('later')
  })
  test('confined to one group, other groups are never the target', () => {
    expect(dropTargetAt(layout, 200, 'today')).toEqual({ groupId: 'today', slot: 2, header: false })
    expect(dropTargetAt(layout, 200, 'missing')).toBeNull()
  })
})

describe('planInsert', () => {
  test('a task dropped between two rows of another group takes the midpoint', () => {
    expect(planInsert([task('x', 10), task('y', 20)], 'a', 1)).toEqual({ updates: [{ id: 'a', position: 15 }], order: ['x', 'a', 'y'], index: 1 })
  })
  test('the top, the bottom, and an empty group', () => {
    expect(planInsert([task('x', 10)], 'a', 0).updates).toEqual([{ id: 'a', position: 9 }])
    expect(planInsert([task('x', 10)], 'a', 5).updates).toEqual([{ id: 'a', position: 11 }])
    expect(planInsert([], 'a', 0).updates).toEqual([{ id: 'a', position: 0 }])
  })
  test('numbers the group again when the gap is used up', () => {
    const plan = planInsert([task('x', 1), task('y', 1)], 'a', 1)
    expect(plan.order).toEqual(['x', 'a', 'y'])
    expect(plan.updates).toEqual([{ id: 'x', position: 1 }, { id: 'a', position: 2 }, { id: 'y', position: 3 }])
  })
})

describe('positionAfter', () => {
  const t = (id, position) => ({ id, position })

  test('goes after the last of the group and before the next task in the shared order', () => {
    const peers = [t('a', 1), t('b', 3)]
    const all = [...peers, t('x', 2), t('y', 7), t('z', 9)]
    expect(positionAfter(peers, all)).toBe(5)
  })

  test('goes one past the last when nothing comes after it', () => {
    expect(positionAfter([t('a', -4), t('b', -2)], [t('a', -4), t('b', -2), t('x', -9)])).toBe(-1)
  })

  test('leaves an empty group to the store', () => {
    expect(positionAfter([], [t('x', 1)])).toBeUndefined()
  })
})
