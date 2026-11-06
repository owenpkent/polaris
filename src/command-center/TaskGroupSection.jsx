import { Check, ChevronDown, ChevronRight, Plus } from 'lucide-react'
import { TaskTree } from './TaskRow'
import InlineTaskInput from './InlineTaskInput'
import ReorderableRows, { useReorderScope } from './ReorderableRows'

// One collapsible group of the My Tasks list (Overdue, Today, Tomorrow, ...): a header row with
// the title and count, then its rows. The groups sit one after another inside the list's single
// panel (MyTasksTab), so a section has no surface of its own.
// `addRow`, when present, describes the trailing "Add task" row for this
// group ({ dueAt }), which turns into the inline input where it is, so nothing
// moves under the pointer; `inlineAdd`, when present, is this group's own active
// inline input -- already filtered to this group by the caller, so any other
// group's inline input has no effect here. It stays at the end of the group, with the tasks
// added from it in `tasks` just above it (heldIds in MyTasksTab.jsx).
// `progress` ({ done }), given to the Today group only, turns its count into "n left", adds
// "m done" once something due today is finished, and shows "All clear" when nothing
// is left (the Zeigarnik and goal-gradient cues; the numbers come from MyTasksTab).
// `subtasksByParent` (indexSubtasks in TaskRow.jsx) gives each row its subtask count.
// `reorderable` (the manual sort) gives each row a handle, and a move calls `onReorder` with the
// plan from reorder.js; `handleColumn` keeps the inline add row's cells in step with the rows.
export default function TaskGroupSection({
  groupId,
  title,
  tasks,
  collapsed,
  onToggleCollapse,
  dueBounds,
  projectNameById,
  subtasksByParent,
  projectOptions,
  visibleColumns,
  gridTemplateColumns,
  phone,
  pendingIds,
  openTaskId,
  onToggleComplete,
  onOpenTask,
  onQuickUpdate,
  addRow,
  progress = null,
  inlineAdd,
  onOpenInlineAdd,
  onSubmitInlineAdd,
  onCancelInlineAdd,
  api,
  handleColumn = false,
  reorderable = false,
  onReorder,
}) {
  // While a row is dragged, a collapsed or empty group has no rows to mark, so its header shows
  // the drop (a drop on it goes to the top of the group).
  const scope = useReorderScope()
  const dropHere = scope?.drag?.target === groupId && (collapsed || tasks.length === 0)
  const headerClass = ['mytasks-section-header', collapsed && 'is-collapsed', dropHere && 'is-drop-target'].filter(Boolean).join(' ')
  return (
    <section className="mytasks-section" data-reorder-group={groupId}>
      <div className={headerClass} data-reorder-header>
        <button
          type="button"
          onClick={onToggleCollapse}
          aria-expanded={!collapsed}
          aria-label={collapsed ? `Expand ${title}` : `Collapse ${title}`}
          className="icon-btn"
          style={{ color: 'var(--t2)' }}
        >
          {collapsed ? <ChevronRight size={16} aria-hidden="true" /> : <ChevronDown size={16} aria-hidden="true" />}
        </button>
        <span className="mytasks-section-title">{title}</span>
        {progress ? <TodayProgress left={tasks.length} done={progress.done} /> : <span className="mytasks-section-count">{tasks.length}</span>}
      </div>

      {!collapsed && (
        <div>
          <ReorderableRows groupId={groupId} tasks={tasks} enabled={reorderable} onReorder={onReorder}>
            {(task, reorder, rowClass) => (
              <TaskTree
                key={task.id}
                task={task}
                subtasksByParent={subtasksByParent}
                projectNameById={projectNameById}
                projectOptions={projectOptions}
                visibleColumns={visibleColumns}
                gridTemplateColumns={gridTemplateColumns}
                phone={phone}
                dueBounds={dueBounds}
                pendingIds={pendingIds}
                openTaskId={openTaskId}
                onToggleComplete={onToggleComplete}
                onOpen={onOpenTask}
                onQuickUpdate={onQuickUpdate}
                api={api}
                handleColumn={handleColumn}
                reorder={reorder}
                rowClass={rowClass}
              />
            )}
          </ReorderableRows>

          {inlineAdd && (
            <InlineTaskInput key={inlineAdd.seq} gridTemplateColumns={gridTemplateColumns} dueColumn={visibleColumns.some((c) => c.id === 'due')} phone={phone} handleColumn={handleColumn} onSubmit={onSubmitInlineAdd} onCancel={onCancelInlineAdd} defaultDueAt={inlineAdd.dueAt ?? null} api={api} />
          )}

          {addRow && !inlineAdd && (
            <button type="button" className="mytasks-add-row" onClick={onOpenInlineAdd}>
              <Plus size={16} aria-hidden="true" /> Add task
            </button>
          )}
        </div>
      )}
    </section>
  )
}

// The Today header's count: "n left", then "m done" once any is done, or "All clear" with a quiet
// check when nothing is left. Numbers only, no bar (the owner's choice).
export function TodayProgress({ left, done }) {
  const clear = left === 0
  return (
    <>
      <span className="mytasks-section-count">{clear ? 0 : `${left} left`}</span>
      {clear && (
        <span className="mytasks-all-clear">
          <Check size={14} aria-hidden="true" /> All clear
        </span>
      )}
      {done > 0 && <span className="mytasks-section-count">{done} done</span>}
    </>
  )
}
