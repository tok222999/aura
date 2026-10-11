/**
 * Stable entry point for integrations that want AURA's payment-policy
 * decision without importing an internal utility path.
 *
 * This is intentionally a small local module for the hackathon. A published
 * package still needs semantic versioning, a generated schema, and its own
 * compatibility test suite before external consumers should depend on it.
 */
export { calculatePrivacyRiskSnapshot } from '@/lib/utils/privacy-risk'
export type {
  PrivacyBufferMode,
  PrivacyRiskSnapshot,
  AuraTransaction,
} from '@/lib/types/aura'

export const PRIVACY_CHECK_SCHEMA_VERSION = 'aura-privacy-risk-v1' as const
