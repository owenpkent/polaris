import SettingsForm from './SettingsForm'

export default function NotConnected() {
  return (
    <div style={{ display: 'flex', justifyContent: 'center', paddingTop: '3rem' }}>
      <div style={{ width: '100%', maxWidth: 420 }}>
        <SettingsForm />
      </div>
    </div>
  )
}
