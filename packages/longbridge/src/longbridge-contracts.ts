/**
 * Longbridge contract helpers — symbol ↔ IBKR Contract mapping.
 */

import { Contract, ContractDetails } from '@traderalice/ibkr'

export function makeContract(symbol: string): Contract {
  const c = new Contract()
  c.symbol = symbol.replace(/\.(US|HK|SG)$/, '')
  c.localSymbol = symbol
  if (symbol.endsWith('.HK')) {
    c.exchange = 'SEHK'; c.currency = 'HKD'; c.secType = 'STK'
  } else if (symbol.endsWith('.SG')) {
    c.exchange = 'SGX'; c.currency = 'SGD'; c.secType = 'STK'
  } else {
    c.exchange = 'SMART'; c.currency = 'USD'; c.secType = 'STK'
  }
  return c
}

export function resolveSymbol(contract: Contract): string {
  if (!contract) return ''
  if (contract.localSymbol && /\.(US|HK|SG)$/.test(contract.localSymbol)) return contract.localSymbol
  const sym = contract.symbol ?? ''
  const ex = (contract.exchange ?? '').toUpperCase()
  const cur = (contract.currency ?? '').toUpperCase()
  if (ex === 'SEHK' || cur === 'HKD') return `${sym}.HK`
  if (ex === 'SGX' || cur === 'SGD') return `${sym}.SI`
  return `${sym}.US`
}

export function makeContractDetails(symbol: string): ContractDetails {
  const d = new ContractDetails()
  d.contract = makeContract(symbol)
  d.validExchanges = 'SMART,NYSE,NASDAQ,ARCA,SEHK,SGX'
  d.orderTypes = 'MKT,LO,MO,STOP,STOP_LIMIT,TSLP'
  d.stockType = 'COMMON'
  return d
}

export function mapAction(action: string): 'BUY' | 'SELL' {
  // Longbridge returns 'Buy'/'Sell', IBKR uses 'BUY'/'SELL'
  if (action === 'BUY' || action === 'Buy') return 'BUY'
  return 'SELL'
}

export function mapStatus(status: string): string {
  const m: Record<string, string> = {
    Filled: 'Filled', Cancelled: 'Cancelled', Submitted: 'Submitted',
    PartialFilled: 'PartiallyFilled', Rejected: 'Rejected', Expired: 'Expired',
  }
  return m[status] ?? status
}
