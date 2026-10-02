import { ChevronDown, ChevronRight, Plus } from 'lucide-react'
import TaskRow from './TaskRow'
import InlineTaskInput from './InlineTaskInput'

// One collapsible group of the My Tasks list (Overdue, Today, Tomorrow, ...).
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
    <section className="surface" style={{ overflow: 'hidden' }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 4,
          minHeight: 52,
          borderBottom: collapsed ? 'none' : '1px solid var(--bd-surface)',
        }}
      >
        <button
          type="button"
          onClick={onToggleCollapse}
          aria-expanded={!collapsed}
          aria-label={collapsed ? `Expand ${title}` : `Collapse ${title}`}
          style={{
            width: 44,
            height: 44,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            background: 'transparent',
            border: 'none',
            borderRadius: 8,
            color: 'var(--t1)',
            flexShrink: 0,
          }}
        >
          {collapsed ? <ChevronRight size={18} aria-hidden="true" /> : <ChevronDown size={18} aria-hidden="true" />}
        </button>
        <span style={{ fontSize: 18, fontWeight: 700, color: 'var(--t1)' }}>{title}</span>
        <span style={{ fontSize: 13, color: 'var(--t3)', marginLeft: 6 }}>{tasks.length}</span>
      </div>

      {!collapsed && (
        <div className="flush-last">
          {inlineAdd?.position === 'top' && (
            <InlineTaskInput gridTemplateColumns={gridTemplateColumns} onSubmit={onSubmitInlineAdd} onCancel={onCancelInlineAdd} />
          )}

          {tasks.map((task, index) => (
            <TaskRow
              key={task.id}
              task={task}
              striped={index % 2 === 1}
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
            <button
              type="button"
              onClick={() => onOpenInlineAdd('bottom')}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                width: '100%',
                minHeight: 44,
                paddingLeft: 14,
                background: 'transparent',
                border: 'none',
                borderBottom: '1px solid var(--bd)',
                color: 'var(--t2)',
                textAlign: 'left',
                fontSize: 14,
              }}
            >
              <Plus size={16} aria-hidden="true" /> Add task
            </button>
          )}
        </div>
      )}
    </section>
  )
}
