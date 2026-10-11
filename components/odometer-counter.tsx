'use client'

import React, { useEffect, useState, useRef } from 'react'

interface OdometerCounterProps {
  value: number
  prefix?: string
  suffix?: string
  decimals?: number
  durationMs?: number
  splitCents?: boolean
  className?: string
  centsClassName?: string
}

export function OdometerCounter({
  value,
  prefix = '$',
  suffix = '',
  decimals = 2,
  durationMs = 850,
  splitCents = true,
  className = '',
  centsClassName = '',
}: OdometerCounterProps) {
  const [displayValue, setDisplayValue] = useState<number>(value)
  const prevValueRef = useRef<number>(value)
  const animFrameRef = useRef<number | null>(null)

  useEffect(() => {
    const startValue = prevValueRef.current
    const targetValue = value
    const delta = targetValue - startValue

    if (Math.abs(delta) < 0.0001) {
      setDisplayValue(targetValue)
      return
    }

    const startTime = performance.now()

    const animate = (currentTime: number) => {
      const elapsed = currentTime - startTime
      const progress = Math.min(elapsed / durationMs, 1)

      // Quintic ease-out curve for tactile cryptographic lock-in feel
      const easeProgress = 1 - Math.pow(1 - progress, 4)
      const current = startValue + delta * easeProgress

      setDisplayValue(current)

      if (progress < 1) {
        animFrameRef.current = requestAnimationFrame(animate)
      } else {
        setDisplayValue(targetValue)
        prevValueRef.current = targetValue
      }
    }

    animFrameRef.current = requestAnimationFrame(animate)

    return () => {
      if (animFrameRef.current !== null) {
        cancelAnimationFrame(animFrameRef.current)
      }
    }
  }, [value, durationMs])

  const integerPart = Math.floor(displayValue).toLocaleString()
  const fractionPart = (displayValue % 1).toFixed(decimals).slice(2)

  if (splitCents) {
    return (
      <span className={className} aria-label={`${prefix}${displayValue.toFixed(decimals)}${suffix}`}>
        {prefix}
        {integerPart}
        <span className={centsClassName}>.{fractionPart}</span>
        {suffix}
      </span>
    )
  }

  return (
    <span className={className} aria-label={`${prefix}${displayValue.toFixed(decimals)}${suffix}`}>
      {prefix}
      {integerPart}.{fractionPart}
      {suffix}
    </span>
  )
}
