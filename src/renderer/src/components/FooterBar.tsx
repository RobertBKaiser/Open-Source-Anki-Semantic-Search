import React from 'react'

type FooterBarProps = {
  left?: React.ReactNode
  right?: React.ReactNode
}

export function FooterBar({ left, right }: FooterBarProps): React.JSX.Element {
  return (
    <div className="h-10 border-t bg-background/70 backdrop-blur supports-[backdrop-filter]:bg-background/50 px-3 flex items-center justify-between text-xs text-muted-foreground">
      <div className="truncate">{left}</div>
      <div className="truncate">{right}</div>
    </div>
  )
}




