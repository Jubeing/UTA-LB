/**
 * Broker Registry — maps type strings to broker classes.
 *
 * Each broker self-registers via static configSchema + configFields + fromConfig.
 * Adding a new broker: import it here and add one entry to the registry.
 */

import type { z } from 'zod'
import type { IBroker, BrokerConfigField } from './types.js'
import type { AccountConfig } from '../../../core/config.js'
import { LongbridgeBroker } from './longbridge/LongbridgeBroker.js'

// ==================== Subtitle field descriptor ====================

export interface SubtitleField {
  field: string
  /** Text to show when boolean field is true */
  label?: string
  /** Text to show when boolean field is false (omitted = don't show) */
  falseLabel?: string
  /** Prefix before the value (e.g. "TWS ") */
  prefix?: string
}

// ==================== Registry entry ====================

export interface BrokerRegistryEntry {
  /** Zod schema for validating brokerConfig fields */
  configSchema: z.ZodType
  /** UI field descriptors for dynamic form rendering */
  configFields: BrokerConfigField[]
  /** Construct a broker instance from AccountConfig */
  fromConfig: (config: AccountConfig) => IBroker
  /** Display name */
  name: string
  /** Short description */
  description: string
  /** Badge text (2-3 chars) */
  badge: string
  /** Tailwind badge color class */
  badgeColor: string
  /** Fields to show in account card subtitle */
  subtitleFields: SubtitleField[]
  /** Guard category — determines which guard types are available */
  guardCategory: 'crypto' | 'securities'
}

// ==================== Registry ====================

export const BROKER_REGISTRY: Record<string, BrokerRegistryEntry> = {
  longbridge: {
    configSchema: LongbridgeBroker.configSchema,
    configFields: LongbridgeBroker.configFields,
    fromConfig: LongbridgeBroker.fromConfig,
    name: 'Longbridge (HK/US/SG)',
    description: 'Longbridge — Hong Kong, US, and Singapore equities. Commission-free trading with integrated market data. Supports HK warrants, CBBCs, US options, and more.',
    badge: 'LB',
    badgeColor: 'text-blue-400',
    subtitleFields: [
      { field: 'paper', label: 'Paper Trading', falseLabel: 'Live Trading' },
    ],
    guardCategory: 'securities',
  },
}
