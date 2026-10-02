import { useRef, useState } from 'react'
import { Plus, Filter, ArrowUpDown, Layers, Columns3, Check } from 'lucide-react'
import { Menu, Popover, useRovingFocus } from './Menu'
import { SOURCE_LABELS } from './TaskRow'
import { SORT_FIELDS, GROUP_MODES, STATE_FILTER_OPTIONS, NO_PROJECT, UNASSIGNED, activeFilterCount } from './viewState'
import { COLUMN_DEFS } from './columnsState'

const PRIORITY_FILTER_OPTIONS = [
  { id: 'urgent', label: 'Urgent' },
  { id: 'high', label: 'High' },
  { id: 'medium', label: 'Medium' },
  { id: 'low', label: 'Low' },
  { id: 'none', label: 'No priority' },
]

const toolbarBtnStyle = (active) => ({
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  height: 44,
  padding: '0 14px',
  borderRadius: 8,
  border: '1px solid var(--bd-strong)',
  background: active ? 'var(--bg-hover)' : 'var(--raised)',
  boxShadow: 'var(--shadow-btn)',
  color: 'var(--t1)',
  fontSize: 14,
  flexShrink: 0,
  whiteSpace: 'nowrap',
})

// One checkbox-style row inside the Filter popover. Renders as a button
// (not a native checkbox) so the whole label is a 44px click target and the
// checked state reads the same as the rest of the app's controls.
function FilterOption({ label, checked, onToggle }) {
  return (
    <button
      type="button"
      className="hover-surface"
      role="menuitemcheckbox"
      aria-checked={checked}
      data-menu-item
      onClick={onToggle}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        width: '100%',
        minHeight: 44,
        padding: '0 14px',
        background: 'transparent',
        border: 'none',
        textAlign: 'left',
        font: 'inherit',
        fontSize: 14,
        color: 'var(--t1)',
        cursor: 'pointer',
      }}
    >
      <span
        aria-hidden="true"
        style={{
          width: 16,
          height: 16,
          flexShrink: 0,
          borderRadius: 4,
          border: `1.5px solid ${checked ? 'var(--blue)' : 'var(--t2)'}`,
          background: checked ? 'var(--blue)' : 'transparent',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        {checked && <Check size={12} strokeWidth={3} style={{ color: 'var(--on-accent)' }} />}
      </span>
      <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{label}</span>
    </button>
  )
}

function FilterGroup({ title, options, selected, onToggle }) {
  if (options.length === 0) return null
  return (
    <div style={{ padding: '4px 0' }}>
      <div style={{ padding: '6px 14px 2px', fontSize: 12, color: 'var(--t2)' }}>{title}</div>
      {options.map((opt) => (
        <FilterOption key={opt.id} label={opt.label} checked={selected.includes(opt.id)} onToggle={() => onToggle(opt.id)} />
      ))}
    </div>
  )
}

// The row above the My Tasks grid: Add task, plus Filter/Sort/Group/Columns
// dropdowns. Sort and Group share state with each column header's own menu
// (see ColumnHeader + MyTasksTab); Filter and Columns only live here.
export default function TaskListToolbar({
  onAddTask,
  projects,
  goals,
  goalsLoaded,
  tasks,
  view,
  onSetSort,
  onSetGroup,
  onToggleFilter,
  onClearFilters,
  hiddenColumns,
  onSetColumnHidden,
}) {
  const [openMenu, setOpenMenu] = useState(null) // 'filter' | 'sort' | 'group' | 'columns' | null
  const filterRef = useRef(null)
  const sortRef = useRef(null)
  const groupRef = useRef(null)
  const columnsRef = useRef(null)
  const filterListRef = useRef(null)
  const filterKeyDown = useRovingFocus(filterListRef)

  const close = () => setOpenMenu(null)
  const toggle = (name) => setOpenMenu((m) => (m === name ? null : name))

  const projectOptions = [
    ...[...projects].sort((a, b) => a.name.localeCompare(b.name)).map((p) => ({ id: p.id, label: p.name })),
    { id: NO_PROJECT, label: 'No project' },
  ]
  const sourceOptions = [...new Set(tasks.map((t) => t.sourceType || 'manual'))]
    .map((id) => ({ id, label: SOURCE_LABELS[id] || id }))
    .sort((a, b) => a.label.localeCompare(b.label))

  // Unassigned first, then every name in the list. A chosen name no task carries any more stays
  // listed, checked, so the filter that hides everything can still be switched off.
  const assigneeNames = new Set(tasks.map((t) => t.assignee).filter(Boolean))
  for (const id of view.filters.assignees) if (id !== UNASSIGNED) assigneeNames.add(id)
  const assigneeOptions = [
    { id: UNASSIGNED, label: 'Unassigned' },
    ...[...assigneeNames].sort((a, b) => a.localeCompare(b)).map((id) => ({ id, label: id })),
  ]

  // Open goals in the Goals view's order. A chosen goal that is not among them stays listed,
  // checked, so the filter that hides every task can still be switched off where it was set:
  // one that is no longer open, or any chosen goal while the goals have not loaded.
  const goalOptions = goals.map((g) => ({ id: g.id, label: g.title }))
  for (const id of view.filters.goalIds) {
    if (!goals.some((g) => g.id === id)) goalOptions.push({ id, label: goalsLoaded ? 'Closed or removed goal' : 'Goal not loaded' })
  }

  const filterCount = activeFilterCount(view.filters)

  const sortItems = SORT_FIELDS.flatMap((f) => [
    {
      key: `${f.id}-asc`,
      label: `${f.label} (ascending)`,
      checked: view.sort.field === f.id && view.sort.dir === 'asc',
      onSelect: () => onSetSort(f.id, 'asc'),
    },
    {
      key: `${f.id}-desc`,
      label: `${f.label} (descending)`,
      checked: view.sort.field === f.id && view.sort.dir === 'desc',
      onSelect: () => onSetSort(f.id, 'desc'),
    },
  ])

  const groupItems = GROUP_MODES.map((g) => ({
    key: g.id,
    label: g.label,
    checked: view.group === g.id,
    onSelect: () => onSetGroup(g.id),
  }))

  const columnItems = COLUMN_DEFS.filter((c) => c.canHide).map((c) => ({
    key: c.id,
    label: c.label,
    checked: !hiddenColumns[c.id],
    keepOpen: true,
    onSelect: () => onSetColumnHidden(c.id, !hiddenColumns[c.id]),
  }))

  return (
    <div className="mytasks-toolbar" role="toolbar" aria-label="Tasks">
      <button
        type="button"
        className="btn btn-primary mytasks-toolbar-add"
        onClick={onAddTask}
        style={{ flexShrink: 0 }}
      >
        <Plus size={18} aria-hidden="true" /> Add task
      </button>

      <div className="mytasks-toolbar-actions">
        <button
          type="button"
          className="hover-surface"
          ref={filterRef}
          aria-haspopup="menu"
          aria-expanded={openMenu === 'filter'}
          onClick={() => toggle('filter')}
          style={toolbarBtnStyle(filterCount > 0)}
        >
          <Filter size={16} aria-hidden="true" /> Filter{filterCount > 0 ? ` (${filterCount})` : ''}
        </button>
        <Popover anchorRef={filterRef} open={openMenu === 'filter'} onClose={close} minWidth={260}>
          <div ref={filterListRef} onKeyDown={filterKeyDown} style={{ padding: '6px 0' }}>
            {/* Ready and Blocked are the server's built-in views of the same names (viewState.js). */}
            <FilterGroup title="Readiness" options={STATE_FILTER_OPTIONS} selected={view.filters.states || []} onToggle={(id) => onToggleFilter('states', id)} />
            <div role="separator" style={{ height: 1, background: 'var(--bd)', margin: '4px 0' }} />
            <FilterGroup title="Project" options={projectOptions} selected={view.filters.projectIds} onToggle={(id) => onToggleFilter('projectIds', id)} />
            <div role="separator" style={{ height: 1, background: 'var(--bd)', margin: '4px 0' }} />
            {goalOptions.length > 0 && (
              <>
                <FilterGroup title="Goal" options={goalOptions} selected={view.filters.goalIds} onToggle={(id) => onToggleFilter('goalIds', id)} />
                <div role="separator" style={{ height: 1, background: 'var(--bd)', margin: '4px 0' }} />
              </>
            )}
            <FilterGroup title="Priority" options={PRIORITY_FILTER_OPTIONS} selected={view.filters.priorities} onToggle={(id) => onToggleFilter('priorities', id)} />
            <div role="separator" style={{ height: 1, background: 'var(--bd)', margin: '4px 0' }} />
            <FilterGroup title="Source" options={sourceOptions} selected={view.filters.sources} onToggle={(id) => onToggleFilter('sources', id)} />
            <div role="separator" style={{ height: 1, background: 'var(--bd)', margin: '4px 0' }} />
            <FilterGroup title="Assignee" options={assigneeOptions} selected={view.filters.assignees} onToggle={(id) => onToggleFilter('assignees', id)} />
            <div role="separator" style={{ height: 1, background: 'var(--bd)', margin: '4px 0' }} />
            <button
              type="button"
              className="hover-surface"
              data-menu-item
              onClick={onClearFilters}
              style={{
                display: 'flex',
                alignItems: 'center',
                width: '100%',
                minHeight: 44,
                padding: '0 14px',
                background: 'transparent',
                border: 'none',
                textAlign: 'left',
                font: 'inherit',
                fontSize: 14,
                color: 'var(--t1)',
                cursor: 'pointer',
              }}
            >
              Clear filters
            </button>
          </div>
        </Popover>

        <button type="button" className="hover-surface" ref={sortRef} aria-haspopup="menu" aria-expanded={openMenu === 'sort'} onClick={() => toggle('sort')} style={toolbarBtnStyle(false)}>
          <ArrowUpDown size={16} aria-hidden="true" /> Sort
        </button>
        <Menu anchorRef={sortRef} open={openMenu === 'sort'} onClose={close} items={sortItems} label="Sort tasks" minWidth={220} />

        <button type="button" className="hover-surface" ref={groupRef} aria-haspopup="menu" aria-expanded={openMenu === 'group'} onClick={() => toggle('group')} style={toolbarBtnStyle(false)}>
          <Layers size={16} aria-hidden="true" /> Group
        </button>
        <Menu anchorRef={groupRef} open={openMenu === 'group'} onClose={close} items={groupItems} label="Group tasks" minWidth={180} />

        <span className="mytasks-toolbar-columns">
          <button type="button" className="hover-surface" ref={columnsRef} aria-haspopup="menu" aria-expanded={openMenu === 'columns'} onClick={() => toggle('columns')} style={toolbarBtnStyle(false)}>
            <Columns3 size={16} aria-hidden="true" /> Columns
          </button>
          <Menu anchorRef={columnsRef} open={openMenu === 'columns'} onClose={close} items={columnItems} label="Show or hide columns" minWidth={200} />
        </span>
      </div>
    </div>
  )
}
