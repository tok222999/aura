'use client'

import { CryptoIcon } from '@/components/crypto-icon'
import type { CapabilityOption } from '@/lib/config/capabilities'

export type NetworkRouteOption = CapabilityOption

type NetworkRouteSelectorProps = {
  title: string
  selectedId: string
  options: readonly NetworkRouteOption[]
  onSelect: (option: NetworkRouteOption) => void
  helper?: string
  disabled?: boolean
}

export function NetworkRouteSelector({ title, selectedId, options, onSelect, helper, disabled = false }: NetworkRouteSelectorProps) {
  const selected = options.find((option) => option.id === selectedId)

  return (
    <div className="aura-network-selector">
      <div className="aura-network-selector-head">
        <div>
          <div className="aura-network-selector-title">{title}</div>
          <div className="aura-network-selector-subtitle">Choose a network for this transfer</div>
        </div>
        <span className="aura-network-selector-count">{options.length} networks</span>
      </div>
      <div className="aura-network-option-grid" role="group" aria-label={title}>
        {options.map((option) => {
          const isSelected = option.id === selectedId
          const isLive = option.status === 'LIVE'
          return (
            <button
              key={option.id}
              type="button"
              disabled={disabled || !isLive}
              aria-disabled={disabled || !isLive}
              aria-pressed={isSelected}
              onClick={() => !disabled && isLive && onSelect(option)}
              className={`aura-network-option ${isSelected ? 'is-selected' : ''} ${!isLive ? 'is-planned' : ''} ${disabled ? 'is-disabled' : ''}`}
            >
              <CryptoIcon name={option.icon} size={22} />
              <span className="aura-network-option-copy">
                <span className="aura-network-option-name">{option.label}</span>
                <span className="aura-network-option-description">{option.description}</span>
              </span>
              <span className={`aura-network-option-status ${isLive ? 'is-live' : ''}`}>{isLive ? 'TESTNET' : 'PLANNED'}</span>
            </button>
          )
        })}
      </div>
      <div className="aura-network-selection" aria-live="polite">
        <span className="aura-network-selection-dot" />
        <span>Selected route</span>
        <strong>{selected?.label ?? 'Choose a network'}</strong>
        {helper ? <span className="aura-network-selection-helper">{helper}</span> : null}
      </div>
    </div>
  )
}
