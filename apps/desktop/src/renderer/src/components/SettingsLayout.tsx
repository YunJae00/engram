import type { ReactNode } from 'react'

// Settings read as a few titled cards of rows: what a row is on the left,
// one line under it when it needs one, and its control on the right.
export function SettingsGroup({ title, label, note, children, testId }: { title?: ReactNode; label?: string; note?: ReactNode; children: ReactNode; testId?: string }) {
  return <section className="settings-section" aria-label={label ?? (typeof title === 'string' ? title : undefined)} data-testid={testId}>
    {title && <h3 className="settings-section-title">{title}</h3>}
    <div className="settings-card">{children}</div>
    {note && <p className="settings-section-note">{note}</p>}
  </section>
}

export function SettingsItem({ icon, title, description, htmlFor, children, testId, below }: {
  icon?: ReactNode
  title: ReactNode
  description?: ReactNode
  htmlFor?: string
  children?: ReactNode
  testId?: string
  // Something that opens under the row, such as a form.
  below?: ReactNode
}) {
  const Title = htmlFor ? 'label' : 'span'
  return <div className="settings-item" data-testid={testId}>
    <div className="settings-item-row">
      {icon && <span className="settings-item-icon" aria-hidden>{icon}</span>}
      <span className="settings-item-text">
        <Title className="settings-item-title" htmlFor={htmlFor}>{title}</Title>
        {description && <small className="settings-item-description">{description}</small>}
      </span>
      {children && <span className="settings-item-control">{children}</span>}
    </div>
    {below && <div className="settings-item-below">{below}</div>}
  </div>
}

// Keys shown the way a keyboard prints them.
export function Keys({ keys }: { keys: readonly string[] }) {
  return <span className="settings-keys">{keys.map((key) => <kbd key={key}>{key}</kbd>)}</span>
}
