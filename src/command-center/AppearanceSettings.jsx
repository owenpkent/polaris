import { THEME_CHOICES } from '../theme'
import { DENSITY_CHOICES } from '../density'

const LABELS = { system: 'Match the system', light: 'Light', dark: 'Dark' }
const DENSITY_LABELS = {
  comfortable: 'Comfortable: taller rows, every control a 44px target',
  compact: 'Compact: shorter rows, more tasks on screen',
}
const LEGEND = { fontSize: '0.85rem', color: 'var(--t2)', fontWeight: 500, marginBottom: '0.4rem' }

// The same choice as the top bar's Theme menu, laid out where someone looking for it in
// Settings expects it. App owns the state and passes it to both, so they never disagree.
// Task rows (src/density.js) is kept on this device only, like the theme.
export default function AppearanceSettings({ theme = 'system', onThemeChange, density = 'comfortable', onDensityChange }) {
  return (
    <section className="card" aria-labelledby="cc-appearance-heading">
      <div className="section-header" id="cc-appearance-heading">Appearance</div>
      <fieldset style={{ border: 'none', margin: 0, padding: 0 }}>
        <legend style={LEGEND}>Theme</legend>
        {THEME_CHOICES.map((id) => (
          <label key={id} className="settings-choice">
            <input
              type="radio"
              name="cc-theme"
              value={id}
              checked={theme === id}
              onChange={() => onThemeChange?.(id)}
            />
            {LABELS[id]}
          </label>
        ))}
      </fieldset>
      <fieldset style={{ border: 'none', margin: '1rem 0 0', padding: 0 }}>
        <legend style={LEGEND}>Task rows</legend>
        {DENSITY_CHOICES.map((id) => (
          <label key={id} className="settings-choice">
            <input
              type="radio"
              name="cc-density"
              value={id}
              checked={density === id}
              onChange={() => onDensityChange?.(id)}
            />
            {DENSITY_LABELS[id]}
          </label>
        ))}
      </fieldset>
    </section>
  )
}
