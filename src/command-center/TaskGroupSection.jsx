import { ChevronDown, ChevronRight, Plus } from 'lucide-react'
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
  // The Add task row's own template: on a phone it keeps a column for its date button, which a
  // task row no longer has. Without one the button becomes an implicit auto column and shrinks.
  inlineGridTemplate = gridTemplateColumns,
  phone,
  pendingIds,
  openTaskId,
  onToggleComplete,
  onOpenTask,
  onQuickUpdate,
  onAddSubtask,
  addRow,
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
        <span className="mytasks-section-count">{tasks.length}</span>
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
                onAddSubtask={onAddSubtask}
                api={api}
                handleColumn={handleColumn}
                reorder={reorder}
                rowClass={rowClass}
              />
            )}
          </ReorderableRows>

          {inlineAdd && (
            <InlineTaskInput key={inlineAdd.seq} gridTemplateColumns={inlineGridTemplate} dueColumn={visibleColumns.some((c) => c.id === 'due')} phone={phone} handleColumn={handleColumn} onSubmit={onSubmitInlineAdd} onCancel={onCancelInlineAdd} defaultDueAt={inlineAdd.dueAt ?? null} api={api} />
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
