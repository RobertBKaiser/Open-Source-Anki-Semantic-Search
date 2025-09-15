import React from 'react'
import React from 'react'

type MetaPillProps = {
  children: React.ReactNode
  title?: string
  tooltip?: string
  className?: string
  variant?: 'default' | 'sky'
  mono?: boolean
  // Optional inline action button (e.g., open in Anki)
  actionIcon?: React.ReactNode
  onAction?: () => void
  actionTitle?: string
  actionAriaLabel?: string
}

export function MetaPill({ children, title, tooltip, className, variant = 'default', mono = false, actionIcon, onAction, actionTitle, actionAriaLabel }: MetaPillProps): React.JSX.Element {

  const base = 'relative inline-flex items-center gap-1.5 h-7 px-2 rounded-md border text-[12px] min-w-0 max-w-full overflow-hidden cursor-default'
  const theme = variant === 'sky'
    ? 'bg-sky-100 text-sky-800 dark:bg-sky-900/30 dark:text-sky-300 border-sky-200/70 dark:border-sky-800/50'
    : 'bg-zinc-100 dark:bg-zinc-800 border-zinc-200/70 dark:border-zinc-700/60'

  const [hover, setHover] = React.useState(false)

  return (
    <span
      className={[base, theme, mono ? 'font-mono' : '', className || ''].join(' ')}
      aria-label={title}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
    >
      <span className="truncate">{children}</span>
      {tooltip && hover && (
        <div className="pointer-events-none absolute left-0 -top-2 -translate-y-full z-50 rounded bg-black/85 text-white px-2 py-1 text-[11px] shadow-lg whitespace-pre">
          {tooltip}
        </div>
      )}
      {actionIcon && typeof onAction === 'function' && (
        <button
          className="shrink-0 inline-flex items-center justify-center w-5 h-5 rounded hover:bg-black/5 dark:hover:bg-white/10"
          aria-label={actionAriaLabel || 'Action'}
          title={actionTitle}
          onClick={(e) => { e.stopPropagation(); try { onAction() } catch {} }}
        >
          {actionIcon}
        </button>
      )}
    </span>
  )
}

export default MetaPill


