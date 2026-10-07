import { THEME_CHOICES } from '../theme'

const LABELS = { system: 'Match the system', light: 'Light', dark: 'Dark' }

// The same choice as the top bar's Theme menu, laid out where someone looking for it in
// Settings expects it. App owns the state and passes it to both, so they never disagree.
export default function AppearanceSettings({ theme = 'system', onThemeChange }) {
  return (
    <section className="card" aria-labelledby="cc-appearance-heading">
      <div className="section-header" id="cc-appearance-heading">Appearance</div>
      <fieldset style={{ border: 'none', margin: 0, padding: 0 }}>
        <legend style={{ fontSize: '0.85rem', color: 'var(--t2)', fontWeight: 500, marginBottom: '0.4rem' }}>Theme</legend>
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
    </section>
  )
}
