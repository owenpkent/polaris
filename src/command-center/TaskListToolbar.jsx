import { useRef, useState } from 'react'
import { Plus, Filter, ArrowUpDown, ArrowUp, ArrowDown, Layers, Columns3, Check, ChevronDown, ChevronRight, X } from 'lucide-react'
import { Menu, Popover } from './Menu'
import { SOURCE_LABELS } from './TaskRow'
import {
  SORT_FIELDS,
  GROUP_MODES,
  STATE_FILTER_OPTIONS,
  NO_PROJECT,
  UNASSIGNED,
  DEFAULT_GROUP,
  activeFilterCount,
  isDefaultSort,
} from './viewState'
import { COLUMN_DEFS } from './columnsState'

const PRIORITY_FILTER_OPTIONS = [
  { id: 'urgent', label: 'Urgent' },
  { id: 'high', label: 'High' },
  { id: 'medium', label: 'Medium' },
  { id: 'low', label: 'Low' },
  { id: 'none', label: 'No priority' },
]

// The long filter groups, each a row in the Filter popover that opens to its list.
const LONG_FILTER_KEYS = ['projectIds', 'goalIds', 'sources', 'assignees']

// The look is .toolbar-btn (index.css); is-active marks a setting in effect.
const toolbarBtnClass = (active) => (active ? 'toolbar-btn is-active' : 'toolbar-btn')

// Where focus goes when a popover opens, and where it goes back to after its Clear or Reset
// (which is disabled once there is nothing left to clear, and a disabled button drops focus).
const FIRST = '[data-pop-first]'
function focusFirstIn(el) {
  el?.closest('[data-popover]')?.querySelector(FIRST)?.focus()
}

// One choice in a long filter list (Project, Goal, Source, Assignee) inside the Filter popover.
// A button with the checkbox role rather than a native checkbox, so the whole label is a 44px
// click target and the checked state reads the same as the rest of the app's controls.
function FilterOption({ label, checked, onToggle }) {
  return (
    <button
      type="button"
      className="hover-surface filter-option"
      role="checkbox"
      aria-checked={checked}
      onClick={onToggle}
    >
      <span aria-hidden="true" className={checked ? 'filter-box is-checked' : 'filter-box'}>
        {checked && <Check size={12} strokeWidth={3} />}
      </span>
      {/* A long name (a project, an assignee) wraps onto more lines: a popover shows every word. */}
      <span style={{ minWidth: 0, overflowWrap: 'anywhere' }}>{label}</span>
    </button>
  )
}

// A short filter group (Readiness, Priority) as a row of toggle chips, like Asana's quick filters.
function FilterChips({ title, options, selected, onToggle, first = false }) {
  return (
    <div role="group" aria-label={title} className="view-pop-group">
      <div className="view-pop-label" aria-hidden="true">{title}</div>
      <div className="sheet-chips">
        {options.map((opt, i) => {
          const on = selected.includes(opt.id)
          return (
            <button
              key={opt.id}
              type="button"
              className="sheet-chip filter-chip"
              aria-pressed={on}
              data-pop-first={first && i === 0 ? '' : undefined}
              onClick={() => onToggle(opt.id)}
            >
              {on && <Check size={14} strokeWidth={3} aria-hidden="true" />}
              {opt.label}
            </button>
          )
        })}
      </div>
    </div>
  )
}

// A long filter group (Project, Goal, Source, Assignee) as one row that says how much is chosen
// and opens to its list, so the popover stays short enough to scan.
function FilterSection({ title, options, selected, expanded, onExpand, onToggle }) {
  if (options.length === 0) return null
  const chosen = options.filter((o) => selected.includes(o.id)).length
  const summary = chosen === 0 ? 'Any' : `${chosen} selected`
  const Chevron = expanded ? ChevronDown : ChevronRight
  return (
    <div className="filter-section">
      <button
        type="button"
        className="hover-surface filter-section-toggle"
        aria-expanded={expanded}
        aria-label={`${title}, ${summary.toLowerCase()}`}
        onClick={onExpand}
      >
        <Chevron size={16} aria-hidden="true" style={{ flexShrink: 0 }} />
        <span className="filter-section-name">{title}</span>
        <span className={chosen > 0 ? 'filter-section-summary is-set' : 'filter-section-summary'}>{summary}</span>
      </button>
      {expanded && (
        <div role="group" aria-label={title}>
          {options.map((opt) => (
            <FilterOption key={opt.id} label={opt.label} checked={selected.includes(opt.id)} onToggle={() => onToggle(opt.id)} />
          ))}
        </div>
      )}
    </div>
  )
}

// The title row of the Filter, Sort, and Group popovers: the name at the left and Clear or Reset
// at the right (Asana's layout), disabled while there is nothing to clear.
function PopHead({ title, action, onAction, disabled }) {
  return (
    <div className="view-pop-head">
      <div className="view-pop-title">{title}</div>
      <button
        type="button"
        className="view-pop-reset"
        disabled={disabled}
        onClick={(e) => {
          const el = e.currentTarget
          onAction()
          focusFirstIn(el)
        }}
      >
        {action}
      </button>
    </div>
  )
}

// A toolbar button and, while its setting is in effect, the button beside it that clears it,
// drawn together as one tinted chip (Asana's "Filters: 1" with its X). The wrapper is always
// rendered, so the button is never remounted: it keeps focus and stays its popover's anchor.
function ToolbarChip({ active, clearLabel, onClear, children }) {
  return (
    <span className={active ? 'toolbar-chip is-active' : 'toolbar-chip'}>
      {children}
      {active && (
        <button type="button" className="toolbar-chip-clear" aria-label={clearLabel} title={clearLabel} onClick={onClear}>
          <X size={16} aria-hidden="true" />
        </button>
      )}
    </span>
  )
}

// The row above the My Tasks grid: Add task, plus Filter/Sort/Group/Columns. Filter, Sort, and
// Group open popovers laid out as Asana's and name what is applied on their buttons, with an X
// beside each to clear it. Sort and Group share state with each column header's own menu (see
// ColumnHeader + MyTasksTab); Filter and Columns only live here.
export default function TaskListToolbar({
  onAddTask,
  projects,
  goals,
  goalsLoaded,
  tasks,
  view,
  onSetSort,
  onResetSort,
  onSetGroup,
  onToggleFilter,
  onClearFilters,
  hiddenColumns,
  onSetColumnHidden,
}) {
  const [openMenu, setOpenMenu] = useState(null) // 'filter' | 'sort' | 'group' | 'columns' | null
  // Which long filter groups are open in the Filter popover. Each opening starts with the groups
  // that have something chosen, so what is applied is in view.
  const [expanded, setExpanded] = useState(() => new Set())
  const filterRef = useRef(null)
  const sortRef = useRef(null)
  const groupRef = useRef(null)
  const columnsRef = useRef(null)

  const close = () => setOpenMenu(null)
  const toggle = (name) => {
    if (openMenu === name) {
      setOpenMenu(null)
      return
    }
    if (name === 'filter') setExpanded(new Set(LONG_FILTER_KEYS.filter((k) => (view.filters[k] || []).length > 0)))
    setOpenMenu(name)
  }
  const toggleSection = (key) => setExpanded((prev) => {
    const next = new Set(prev)
    if (next.has(key)) next.delete(key)
    else next.add(key)
    return next
  })

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
  const sortApplied = !isDefaultSort(view.sort)
  const sortField = SORT_FIELDS.find((f) => f.id === view.sort.field) || SORT_FIELDS[0]
  const SortIcon = !sortApplied ? ArrowUpDown : view.sort.dir === 'desc' ? ArrowDown : ArrowUp
  const groupApplied = view.group !== DEFAULT_GROUP
  const groupMode = GROUP_MODES.find((g) => g.id === view.group) || GROUP_MODES[0]

  // The X beside a chip clears its setting and leaves focus on the button, which stays.
  const clearAndFocus = (clear, ref) => () => {
    clear()
    ref.current?.focus()
  }

  const columnItems = COLUMN_DEFS.filter((c) => c.canHide).map((c) => ({
    key: c.id,
    label: c.label,
    checked: !hiddenColumns[c.id],
    keepOpen: true,
    onSelect: () => onSetColumnHidden(c.id, !hiddenColumns[c.id]),
  }))

  const filterSections = [
    { key: 'projectIds', title: 'Project', options: projectOptions },
    { key: 'goalIds', title: 'Goal', options: goalOptions },
    { key: 'sources', title: 'Source', options: sourceOptions },
    { key: 'assignees', title: 'Assignee', options: assigneeOptions },
  ]

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
        <ToolbarChip active={filterCount > 0} clearLabel="Clear filters" onClear={clearAndFocus(onClearFilters, filterRef)}>
          <button
            type="button"
            className={toolbarBtnClass(filterCount > 0)}
            ref={filterRef}
            aria-haspopup="dialog"
            aria-expanded={openMenu === 'filter'}
            onClick={() => toggle('filter')}
          >
            <Filter size={16} aria-hidden="true" /> {filterCount > 0 ? `Filter: ${filterCount}` : 'Filter'}
          </button>
        </ToolbarChip>
        <Popover anchorRef={filterRef} open={openMenu === 'filter'} onClose={close} minWidth={300} maxWidth={380} focusSelector={FIRST}>
          <div role="dialog" aria-label="Filter tasks" className="view-pop">
            <PopHead title="Filters" action="Clear" onAction={onClearFilters} disabled={filterCount === 0} />
            {/* Ready and Blocked are the server's built-in views of the same names (viewState.js). */}
            <FilterChips title="Readiness" options={STATE_FILTER_OPTIONS} selected={view.filters.states || []} onToggle={(id) => onToggleFilter('states', id)} first />
            <FilterChips title="Priority" options={PRIORITY_FILTER_OPTIONS} selected={view.filters.priorities} onToggle={(id) => onToggleFilter('priorities', id)} />
            <div className="view-pop-label view-pop-divided">All filters</div>
            {filterSections.map((section) => (
              <FilterSection
                key={section.key}
                title={section.title}
                options={section.options}
                selected={view.filters[section.key] || []}
                expanded={expanded.has(section.key)}
                onExpand={() => toggleSection(section.key)}
                onToggle={(id) => onToggleFilter(section.key, id)}
              />
            ))}
          </div>
        </Popover>

        <ToolbarChip active={sortApplied} clearLabel="Reset sort" onClear={clearAndFocus(onResetSort, sortRef)}>
          <button
            type="button"
            className={toolbarBtnClass(sortApplied)}
            ref={sortRef}
            aria-haspopup="dialog"
            aria-expanded={openMenu === 'sort'}
            // The arrow shows the direction; the name says it in words.
            aria-label={sortApplied ? `Sort: ${sortField.label}, ${view.sort.dir === 'desc' ? 'descending' : 'ascending'}` : undefined}
            onClick={() => toggle('sort')}
          >
            <SortIcon size={16} aria-hidden="true" /> {sortApplied ? `Sort: ${sortField.label}` : 'Sort'}
          </button>
        </ToolbarChip>
        <Popover anchorRef={sortRef} open={openMenu === 'sort'} onClose={close} minWidth={300} focusSelector={FIRST}>
          <div role="dialog" aria-label="Sort tasks" className="view-pop">
            <PopHead title="Sort" action="Reset" onAction={onResetSort} disabled={!sortApplied} />
            <div className="view-pop-row">
              <select aria-label="Sort by" data-pop-first="" value={view.sort.field} onChange={(e) => onSetSort(e.target.value, view.sort.dir)}>
                {SORT_FIELDS.map((f) => <option key={f.id} value={f.id}>{f.label}</option>)}
              </select>
              <select aria-label="Direction" value={view.sort.dir} onChange={(e) => onSetSort(view.sort.field, e.target.value)}>
                <option value="asc">Ascending</option>
                <option value="desc">Descending</option>
              </select>
            </div>
          </div>
        </Popover>

        <ToolbarChip active={groupApplied} clearLabel="Reset grouping" onClear={clearAndFocus(() => onSetGroup(DEFAULT_GROUP), groupRef)}>
          <button
            type="button"
            className={toolbarBtnClass(groupApplied)}
            ref={groupRef}
            aria-haspopup="dialog"
            aria-expanded={openMenu === 'group'}
            onClick={() => toggle('group')}
          >
            <Layers size={16} aria-hidden="true" /> {groupApplied ? `Group: ${groupMode.label}` : 'Group'}
          </button>
        </ToolbarChip>
        <Popover anchorRef={groupRef} open={openMenu === 'group'} onClose={close} minWidth={300} focusSelector={FIRST}>
          <div role="dialog" aria-label="Group tasks" className="view-pop">
            <PopHead title="Group" action="Reset" onAction={() => onSetGroup(DEFAULT_GROUP)} disabled={!groupApplied} />
            <div className="view-pop-row">
              <select aria-label="Group by" data-pop-first="" value={view.group} onChange={(e) => onSetGroup(e.target.value)}>
                {GROUP_MODES.map((g) => <option key={g.id} value={g.id}>{g.label}</option>)}
              </select>
            </div>
          </div>
        </Popover>

        <span className="mytasks-toolbar-columns">
          <button type="button" className={toolbarBtnClass(false)} ref={columnsRef} aria-haspopup="menu" aria-expanded={openMenu === 'columns'} onClick={() => toggle('columns')}>
            <Columns3 size={16} aria-hidden="true" /> Columns
          </button>
          <Menu anchorRef={columnsRef} open={openMenu === 'columns'} onClose={close} items={columnItems} label="Show or hide columns" minWidth={200} />
        </span>
      </div>
    </div>
  )
}
