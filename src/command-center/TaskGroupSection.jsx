import { ChevronDown, ChevronRight, Plus } from 'lucide-react'
import TaskRow from './TaskRow'
import InlineTaskInput from './InlineTaskInput'

// One collapsible group of the My Tasks list (Overdue, Today, Tomorrow, ...): a header row with
// the title and count, then its rows. The groups sit one after another inside the list's single
// panel (MyTasksTab), so a section has no surface of its own.
// `addRow`, when present, describes the trailing "Add task" row for this
// group ({ dueAt }); `inlineAdd`, when present, is this group's own active
// inline input ({ position: 'top' | 'bottom' }) -- already filtered to this
// group by the caller, so any other group's inline input has no effect here.
export default function TaskGroupSection({
  title,
  tasks,
  collapsed,
  onToggleCollapse,
  dueBounds,
  projectNameById,
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
        <div className="flush-last">
          {inlineAdd?.position === 'top' && (
            <InlineTaskInput gridTemplateColumns={gridTemplateColumns} onSubmit={onSubmitInlineAdd} onCancel={onCancelInlineAdd} />
          )}

          {tasks.map((task) => (
            <TaskRow
              key={task.id}
              task={task}
              projectName={projectNameById.get(task.projectId)}
              projectOptions={projectOptions}
              visibleColumns={visibleColumns}
              gridTemplateColumns={gridTemplateColumns}
              phone={phone}
              dueBounds={dueBounds}
              pending={pendingIds.has(task.id)}
              open={task.id === openTaskId}
              onToggleComplete={onToggleComplete}
              onOpen={onOpenTask}
              onQuickUpdate={onQuickUpdate}
            />
          ))}

          {inlineAdd?.position === 'bottom' && (
            <InlineTaskInput gridTemplateColumns={gridTemplateColumns} onSubmit={onSubmitInlineAdd} onCancel={onCancelInlineAdd} />
          )}

          {addRow && !inlineAdd && (
            <button type="button" className="mytasks-add-row" onClick={() => onOpenInlineAdd('bottom')}>
              <Plus size={16} aria-hidden="true" /> Add task
            </button>
          )}
        </div>
      )}
    </section>
  )
}
