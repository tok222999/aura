interface AuraLogoProps {
  height?: number
  className?: string
  iconOnly?: boolean
  accentColor?: string
}

export function AuraLogo({
  height = 40,
  className,
  iconOnly = false,
  accentColor = 'var(--violet, #6b55df)',
}: AuraLogoProps) {
  const iconSize = height
  const fontSize = Math.round(height * 0.54)
  const gap = Math.round(height * 0.28)

  if (iconOnly) {
    return (
      <svg
        width={iconSize}
        height={iconSize}
        viewBox="0 0 44 44"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        className={className}
        style={{ display: 'inline-block', verticalAlign: 'middle' }}
      >
        <rect x="4" y="4" width="38" height="38" rx="10" fill={accentColor} />
        <rect x="0" y="0" width="38" height="38" rx="10" fill="#0e121b" />
        <path d="M10 18L24 13.5" stroke="#FFFFFF" strokeWidth="2.8" strokeLinecap="round" />
        <path d="M10 24.5L29 18.5" stroke="#FFFFFF" strokeWidth="2.8" strokeLinecap="round" />
        <path d="M10 31L24 26.5" stroke="#FFFFFF" strokeWidth="2.8" strokeLinecap="round" />
      </svg>
    )
  }

  return (
    <span
      className={className}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: `${gap}px`,
        verticalAlign: 'middle',
      }}
    >
      <svg
        width={iconSize}
        height={iconSize}
        viewBox="0 0 44 44"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        style={{ display: 'block', flexShrink: 0 }}
      >
        {/* Aura Violet offset shadow */}
        <rect x="4" y="4" width="38" height="38" rx="10" fill={accentColor} />
        {/* Dark front tile */}
        <rect x="0" y="0" width="38" height="38" rx="10" fill="#0e121b" />
        {/* Slanted white bars */}
        <path d="M10 18L24 13.5" stroke="#FFFFFF" strokeWidth="2.8" strokeLinecap="round" />
        <path d="M10 24.5L29 18.5" stroke="#FFFFFF" strokeWidth="2.8" strokeLinecap="round" />
        <path d="M10 31L24 26.5" stroke="#FFFFFF" strokeWidth="2.8" strokeLinecap="round" />
      </svg>
      <span
        style={{
          fontFamily: 'var(--font-display)',
          fontSize: `${fontSize}px`,
          fontWeight: 800,
          letterSpacing: '0.24em',
          color: '#0e121b',
          lineHeight: 1,
        }}
      >
        AURA
      </span>
    </span>
  )
}

export default AuraLogo
