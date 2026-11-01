import { ChevronDown, ChevronRight, Plus } from 'lucide-react'
import { TaskTree } from './TaskRow'
import InlineTaskInput from './InlineTaskInput'
import ReorderableRows from './ReorderableRows'

// One collapsible group of the My Tasks list (Overdue, Today, Tomorrow, ...): a header row with
// the title and count, then its rows. The groups sit one after another inside the list's single
// panel (MyTasksTab), so a section has no surface of its own.
// `addRow`, when present, describes the trailing "Add task" row for this
// group ({ dueAt }), which opens the inline input at the top of the group, as
// Asana's does; `inlineAdd`, when present, is this group's own active
// inline input ({ position: 'top' | 'bottom' }) -- already filtered to this
// group by the caller, so any other group's inline input has no effect here.
// `subtasksByParent` (indexSubtasks in TaskRow.jsx) gives each row its subtask count.
// `reorderable` (the manual sort) gives each row a handle, and a move calls `onReorder` with the
// plan from reorder.js; `handleColumn` keeps the inline add row's cells in step with the rows.
export default function TaskGroupSection({
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
  inlineAdd,
  onOpenInlineAdd,
  onSubmitInlineAdd,
  onCancelInlineAdd,
  api,
  handleColumn = false,
  reorderable = false,
  onReorder,
}) {
  return (
    <section className="mytasks-section">
      <div className={collapsed ? 'mytasks-section-header is-collapsed' : 'mytasks-section-header'}>
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
          {inlineAdd?.position === 'top' && (
            <InlineTaskInput key={inlineAdd.seq} gridTemplateColumns={gridTemplateColumns} handleColumn={handleColumn} onSubmit={onSubmitInlineAdd} onCancel={onCancelInlineAdd} defaultDueAt={inlineAdd.dueAt ?? null} api={api} />
          )}

          <ReorderableRows tasks={tasks} enabled={reorderable} onReorder={onReorder}>
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

          {inlineAdd?.position === 'bottom' && (
            <InlineTaskInput key={inlineAdd.seq} gridTemplateColumns={gridTemplateColumns} onSubmit={onSubmitInlineAdd} onCancel={onCancelInlineAdd} defaultDueAt={inlineAdd.dueAt ?? null} api={api} />
          )}

          {addRow && !inlineAdd && (
            <button type="button" className="mytasks-add-row" onClick={() => onOpenInlineAdd('top')}>
              <Plus size={16} aria-hidden="true" /> Add task
            </button>
          )}
        </div>
      )}
    </section>
  )
}
