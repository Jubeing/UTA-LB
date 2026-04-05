/**
 * LongbridgeBroker — IBroker adapter for LongBridge OpenAPI.
 * Supports HK (SEHK), US (NASDAQ/NYSE), SG (SGX) equities.
 * Token auto-refresh every 90 days via HMAC-SHA256.
 */

import { z } from 'zod'
import Decimal from 'decimal.js'
import {
  BrokerError,
  type IBroker,
  type AccountCapabilities,
  type AccountInfo,
  type Position,
  type PlaceOrderResult,
  type OpenOrder,
  type Quote,
  type MarketClock,
  type BrokerConfigField,
  type TpSlParams,
} from '../types.js'
import {
  Contract,
  ContractDescription,
  ContractDetails,
  Order,
  OrderState,
} from '@traderalice/ibkr'
import { refreshAccessToken, isTokenExpiringSoon } from './longbridge-auth.js'
import { makeContract, resolveSymbol, makeContractDetails, mapAction, mapStatus } from './longbridge-contracts.js'
import type { LongPortAccountAsset, LongPortPosition, LongPortOrder, LongPortQuote, LongPortSubmitOrderResponse, LongPortOrderDetail } from './longbridge-types.js'

const UNSET_DOUBLE = 0
const UNSET_DECIMAL = new Decimal(0)

// ==================== Schema & Fields ====================

export const LongbridgeBrokerConfigSchema = z.object({
  appKey: z.string().optional(),
  appSecret: z.string().optional(),
  // OAuth2 refresh_token — used to obtain new access tokens AND as the SDK access token
  accessToken: z.string().optional(),
  tokenExpiry: z.string().optional(),
  paper: z.boolean().default(true),
})

export type LongbridgeBrokerConfig = z.infer<typeof LongbridgeBrokerConfigSchema>

export const longbridgeConfigFields: BrokerConfigField[] = [
  { name: 'appKey', type: 'text', label: 'LONGBRIDGE_APP_KEY', required: true, sensitive: true, description: 'Longbridge App Key from developer portal.' },
  { name: 'appSecret', type: 'password', label: 'LONGBRIDGE_APP_SECRET', required: true, sensitive: true, description: 'Longbridge App Secret.' },
  { name: 'accessToken', type: 'password', label: 'LONGBRIDGE_ACCESS_TOKEN', required: true, sensitive: true, description: 'Longbridge Access Token (from developer portal or OAuth).' },
  { name: 'refreshToken', type: 'password', label: 'LONGBRIDGE_REFRESH_TOKEN', required: false, sensitive: true, description: 'OAuth2 Refresh Token (auto-refreshed monthly, or fill in manually from Longbridge developer portal).' },
  { name: 'paper', type: 'boolean', label: 'Paper Trading', default: true, sensitive: false, description: 'Route orders to paper/sandbox environment.' },
]

// ==================== SDK helpers ====================

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Sdk = any

async function getSDK(): Promise<Sdk> {
  return await import('longbridge') as Sdk
}

// ==================== Broker ====================

export class LongbridgeBroker implements IBroker {
  static configSchema = LongbridgeBrokerConfigSchema
  static configFields = longbridgeConfigFields

  static fromConfig(config: { id: string; label?: string; brokerConfig: Record<string, unknown> }): LongbridgeBroker {
    const bc = LongbridgeBrokerConfigSchema.parse(config.brokerConfig)
    return new LongbridgeBroker({
      id: config.id,
      label: config.label,
      appKey: bc.appKey ?? '',
      appSecret: bc.appSecret ?? '',
      accessToken: bc.accessToken ?? '',
      refreshToken: bc.refreshToken,
      tokenExpiry: bc.tokenExpiry,
      paper: bc.paper,
    })
  }

  readonly id: string
  readonly label: string
  private config: LongbridgeBrokerConfig
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private _tradeCtx: any = null
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private _quoteCtx: any = null

  constructor(config: {
    id: string; label?: string
    appKey: string; appSecret: string; accessToken: string; refreshToken?: string
    tokenExpiry?: string; paper?: boolean
  }) {
    this.id = config.id
    this.label = config.label ?? 'Longbridge'
    this.config = {
      appKey: config.appKey,
      appSecret: config.appSecret,
      accessToken: config.accessToken,
      tokenExpiry: config.tokenExpiry,
      paper: config.paper ?? true,
    }
  }

  private get auth() {
    return { appKey: this.config.appKey ?? '', appSecret: this.config.appSecret ?? '', accessToken: this.config.accessToken ?? '', refreshToken: this.config.refreshToken }
  }

  private async getTradeCtx() {
    if (this._tradeCtx) return this._tradeCtx
    const sdk = await getSDK()
    const token = this.config.accessToken || ''
    const cfg = sdk.Config.fromApikey(this.config.appKey!, this.config.appSecret!, token, { language: sdk.Language.ZH_CN })
    this._tradeCtx = sdk.TradeContext.new(cfg)
    return this._tradeCtx
  }

  private async getQuoteCtx() {
    if (this._quoteCtx) return this._quoteCtx
    const sdk = await getSDK()
    const token = this.config.accessToken || ''
    const cfg = sdk.Config.fromApikey(this.config.appKey!, this.config.appSecret!, token, { language: sdk.Language.ZH_CN })
    this._quoteCtx = sdk.QuoteContext.new(cfg)
    return this._quoteCtx
  }

  /**
   * Refresh access token using the stored refresh token.
   * Called automatically when token is expiring (within 7 days).
   * Returns { accessToken, refreshToken, expiredAt }.
   */
  async refreshToken(): Promise<{ accessToken: string; refreshToken: string; expiredAt: string }> {
    if (!this.config.refreshToken) throw new BrokerError('CONFIG', 'No refresh token — please re-authorize Longbridge.')
    const result = await refreshAccessToken({
      appKey: this.config.appKey ?? '',
      appSecret: this.config.appSecret,
      refreshToken: this.config.refreshToken,
    })
    this.config.accessToken = result.accessToken
    this.config.refreshToken = result.refreshToken
    this.config.tokenExpiry = result.expiresAt
    return result
  }

  async init(): Promise<void> {
    if (!this.config.appKey || !this.config.appSecret || !this.config.accessToken) {
      throw new BrokerError('CONFIG', 'Missing Longbridge credentials (appKey, appSecret, or accessToken).')
    }
    // Auto-refresh if token is expiring within 7 days
    if (this.config.refreshToken && this.config.tokenExpiry && isTokenExpiringSoon(this.config.tokenExpiry, 7)) {
      try { await this.refreshToken() } catch { /* try with current token anyway */ }
    }
    try {
      const ctx = await this.getTradeCtx()
      const assets = (await ctx.accountBalance()) as LongPortAccountAsset[]
      const total = assets.reduce((s, a) => s + Number(a.netAssets?.toString?.() ?? 0), 0)
      console.log(`LongbridgeBroker[${this.id}]: connected (accounts=${assets.length}, net_assets≈$${total.toFixed(2)})`)
    } catch (err) {
      if (err instanceof BrokerError) throw err
      const msg = err instanceof Error ? err.message : String(err)
      if (/401|unauthorized|invalid.*token/i.test(msg)) throw new BrokerError('AUTH', `Longbridge auth failed: ${msg}`)
      throw BrokerError.from(err)
    }
  }

  async close(): Promise<void> { this._tradeCtx = null; this._quoteCtx = null }

  async searchContracts(pattern: string): Promise<ContractDescription[]> {
    if (!pattern) return []
    try {
      const desc = new ContractDescription()
      desc.contract = makeContract(pattern.toUpperCase())
      return [desc]
    } catch { return [] }
  }

  async getContractDetails(query: Contract): Promise<ContractDetails | null> {
    const sym = resolveSymbol(query)
    return sym ? makeContractDetails(sym) : null
  }

  async placeOrder(contract: Contract, order: Order, _tpsl?: TpSlParams): Promise<PlaceOrderResult> {
    try {
      const ctx = await this.getTradeCtx()
      const sym = resolveSymbol(contract)
      if (!sym) return { success: false, error: 'Cannot resolve contract symbol' }
      const sdk = await getSDK()
      const { Decimal: LBDecimal, OrderSide, TimeInForceType } = sdk
      const orderTypeMap: Record<string, number> = { MKT: sdk.OrderType.MO, LMT: sdk.OrderType.LO, STP: sdk.OrderType.LIT, 'STP LMT': sdk.OrderType.ELO }
      const lbOrderType = orderTypeMap[order.orderType] ?? sdk.OrderType.MO
      const lbSide = order.action === 'BUY' ? OrderSide.Buy : OrderSide.Sell
      const tifMap: Record<string, number> = { DAY: TimeInForceType.Day, GTC: TimeInForceType.GoodTilCanceled, GTD: TimeInForceType.GoodTilDate, IOC: TimeInForceType.IOC, FOK: TimeInForceType.FOK }
      const lbTif = tifMap[order.tif ?? 'DAY'] ?? TimeInForceType.Day
      const lmtPrice = order.lmtPrice !== UNSET_DOUBLE ? Number(order.lmtPrice) : undefined
      const resp = (await ctx.submitOrder({
        symbol: sym, orderType: lbOrderType, side: lbSide, timeInForce: lbTif,
        submittedPrice: lmtPrice != null ? new LBDecimal(String(lmtPrice)) : undefined,
        submittedQuantity: new LBDecimal(order.totalQuantity.toString()),
      })) as LongPortSubmitOrderResponse
      const orderState = new OrderState()
      orderState.status = resp.status === 'active' ? 'Submitted' : resp.status
      return { success: true, orderId: resp.orderId, orderState }
    } catch (err) { return { success: false, error: err instanceof Error ? err.message : String(err) } }
  }

  async modifyOrder(orderId: string, changes: Partial<Order>): Promise<PlaceOrderResult> {
    try {
      const ctx = await this.getTradeCtx()
      const sdk = await getSDK()
      const { Decimal: LBDecimal } = sdk
      const patch: Record<string, unknown> = {}
      if (changes.lmtPrice != null && changes.lmtPrice !== UNSET_DOUBLE) patch.submitted_price = new LBDecimal(String(changes.lmtPrice))
      if (changes.totalQuantity != null && !changes.totalQuantity.equals(UNSET_DECIMAL)) patch.submitted_quantity = new LBDecimal(changes.totalQuantity.toString())
      const resp = (await ctx.amendOrder(orderId, patch)) as LongPortSubmitOrderResponse
      const orderState = new OrderState()
      orderState.status = mapStatus(resp.status)
      return { success: true, orderId: resp.orderId, orderState }
    } catch (err) { return { success: false, error: err instanceof Error ? err.message : String(err) } }
  }

  async cancelOrder(orderId: string): Promise<PlaceOrderResult> {
    try {
      const ctx = await this.getTradeCtx()
      await ctx.cancelOrder(orderId)
      const orderState = new OrderState()
      orderState.status = 'Cancelled'
      return { success: true, orderId, orderState }
    } catch (err) { return { success: false, error: err instanceof Error ? err.message : String(err) } }
  }

  async closePosition(contract: Contract, quantity?: Decimal): Promise<PlaceOrderResult> {
    const sym = resolveSymbol(contract)
    if (!sym) return { success: false, error: 'Cannot resolve symbol' }
    try {
      const positions = await this.getPositions()
      const pos = positions.find(p => p.contract.symbol === (contract.symbol ?? ''))
      if (!pos) return { success: false, error: `No position for ${sym}` }
      const order = new Order()
      order.action = pos.side === 'long' ? 'SELL' : 'BUY'
      order.orderType = 'MKT'
      order.totalQuantity = quantity ?? pos.quantity
      order.tif = 'DAY'
      return this.placeOrder(contract, order)
    } catch (err) { return { success: false, error: err instanceof Error ? err.message : String(err) } }
  }

  async getAccount(): Promise<AccountInfo> {
    try {
      const ctx = await this.getTradeCtx()
      // SDK may return the array directly or wrap it in { list: [...] }
      const rawBalances = (await ctx.accountBalance()) as any
      const balances: any[] = rawBalances.list ?? rawBalances

      // Fetch HKD→USD exchange rate for currency conversion
      let hkdToUsd = 1 / 7.78 // fallback rate
      try {
        const resp = await fetch('https://api.exchangerate-api.com/v4/latest/USD')
        const data = await resp.json() as { rates?: Record<string, number> }
        if (data.rates?.HKD) hkdToUsd = 1 / data.rates.HKD
      } catch { /* use fallback */ }

      let netLiq = 0, cash = 0, buyingPower = 0
      for (const b of balances) {
        const cur = b.currency ?? 'USD'
        // SDK converts net_assets → netAssets, total_cash → totalCash, buy_power → buyPower
        const net = Number(b.netAssets?.toString?.() ?? b.net_assets ?? 0)
        const tot = Number(b.totalCash?.toString?.() ?? b.total_cash ?? 0)
        const bp = Number(b.buyPower?.toString?.() ?? b.buy_power ?? 0)
        if (cur === 'USD' || cur === 'usd') {
          netLiq += net; cash += tot; buyingPower += bp
        } else if (cur === 'HKD' || cur === 'hkd') {
          netLiq += net * hkdToUsd; cash += tot * hkdToUsd; buyingPower += bp * hkdToUsd
        } else {
          netLiq += net; cash += tot; buyingPower += bp
        }
      }
      return { netLiquidation: netLiq, totalCashValue: cash, unrealizedPnL: 0, buyingPower }
    } catch (err) { throw BrokerError.from(err) }
  }

  async getPositions(): Promise<Position[]> {
    try {
      const ctx = await this.getTradeCtx()
      const resp = await ctx.stockPositions() as any
      const raw: any[] = []
      for (const ch of resp.list ?? []) {
        for (const p of ch.stock_info ?? []) {
          raw.push(p)
        }
      }

      // Batch-fetch quotes for all symbols to get real-time prices
      const symbols = raw.map((p: any) => p.symbol)
      const quoteMap = new Map<string, number>()
      if (symbols.length > 0) {
        try {
          const qctx = await this.getQuoteCtx()
          // Stocks use quote(), options use optionQuote()
          const stockSyms = symbols.filter((s: string) => !s.match(/[A-Z]{1,5}\d{6}[PC]\d+$/))
          const optSyms = symbols.filter((s: string) => s.match(/[A-Z]{1,5}\d{6}[PC]\d+$/))
          if (stockSyms.length > 0) {
            const quotes = await qctx.quote(stockSyms) as any[]
            for (const q of quotes ?? []) {
              quoteMap.set(q.symbol, Number(q.lastDone?.toString?.() ?? 0))
            }
          }
          if (optSyms.length > 0) {
            const optQuotes = await (qctx as any).optionQuote(optSyms) as any[]
            for (const q of optQuotes ?? []) {
              quoteMap.set(q.symbol, Number(q.lastDone?.toString?.() ?? 0))
            }
          }
        } catch { /* quote failed, prices stay 0 */ }
      }

      return raw.map((p: any) => {
        // SDK converts snake_case JSON → camelCase properties, numeric values → Decimal wrappers
        // but we use optional chaining + toString fallback for defensive access
        const qty = Number(p.quantity ?? p.quantity?.toString?.() ?? 0)
        const cost = Number(p.costPrice?.toString?.() ?? p.cost_price ?? 0)
        const marketPrice = quoteMap.get(p.symbol) ?? 0
        const marketValue = Math.abs(qty * marketPrice)
        const unrealizedPnL = (marketPrice - cost) * qty
        const currency = p.currency ?? 'USD'
        const contract = makeContract(p.symbol)
        ;(contract as any).description = p.symbolName ?? p.symbol_name ?? ''
        contract.currency = currency
        return {
          contract,
          side: qty >= 0 ? 'long' : 'short',
          quantity: new Decimal(String(qty)),
          avgCost: cost,
          marketPrice,
          marketValue,
          unrealizedPnL,
          realizedPnL: 0,
        }
      })
    } catch (err) { throw BrokerError.from(err) }
  }

  async getOrders(_ids: string[]): Promise<OpenOrder[]> {
    try {
      const ctx = await this.getTradeCtx()
      const today = (await ctx.todayOrders()) as LongPortOrder[]
      return today.map(o => this.mapOpenOrder(o))
    } catch (err) { throw BrokerError.from(err) }
  }

  async getOrder(orderId: string): Promise<OpenOrder | null> {
    try {
      const ctx = await this.getTradeCtx()
      const detail = await ctx.orderDetail(orderId) as LongPortOrderDetail
      return this.mapOpenOrderFromDetail(detail)
    } catch { return null }
  }

  async getQuote(contract: Contract): Promise<Quote> {
    const sym = resolveSymbol(contract)
    if (!sym) throw new BrokerError('EXCHANGE', 'Cannot resolve contract symbol')
    try {
      const ctx = await this.getQuoteCtx()
      const quotes = (await ctx.quote([sym])) as LongPortQuote[]
      const q = quotes[0]
      const last = Number(q.lastPrice?.toString?.() ?? 0)
      return { contract: makeContract(sym), last, bid: last * 0.999, ask: last * 1.001, volume: q.volume ?? 0, high: Number(q.high?.toString?.() ?? 0) || undefined, low: Number(q.low?.toString?.() ?? 0) || undefined, timestamp: new Date(Number(q.timestamp ?? Date.now())) }
    } catch (err) { throw BrokerError.from(err) }
  }

  getCapabilities(): AccountCapabilities {
    return { supportedSecTypes: ['STK'], supportedOrderTypes: ['MKT', 'LMT', 'STP', 'STP LMT'] }
  }

  async getMarketClock(): Promise<MarketClock> {
    const now = new Date(), totalMins = now.getUTCHours() * 60 + now.getUTCMinutes()
    const isWeekday = now.getUTCDay() >= 1 && now.getUTCDay() <= 5
    const isOpen = isWeekday && totalMins >= 870 && totalMins < 1260
    if (isOpen) return { isOpen: true, nextClose: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 21, 0)), timestamp: now }
    if (totalMins < 870) return { isOpen: false, nextOpen: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 14, 30)), timestamp: now }
    return { isOpen: false, nextOpen: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + (now.getUTCDay() === 5 ? 3 : 1), 14, 30)), timestamp: now }
  }

  getNativeKey(contract: Contract): string { return resolveSymbol(contract) }
  resolveNativeKey(nativeKey: string): Contract { return makeContract(nativeKey) }

  private mapOpenOrder(o: LongPortOrder): OpenOrder {
    const contract = makeContract(o.symbol)
    const order = new Order()
    order.action = mapAction(o.side)
    order.totalQuantity = new Decimal(o.submittedQuantity ?? 0)
    order.orderType = o.orderType === 'MO' ? 'MKT' : o.orderType === 'LO' ? 'LMT' : o.orderType
    order.tif = o.timeInForce
    order.orderId = 0
    const orderState = new OrderState()
    orderState.status = mapStatus(o.status)
    return { contract, order, orderState, avgFillPrice: Number(o.avgPrice?.toString?.() ?? 0) || undefined }
  }

  private mapOpenOrderFromDetail(d: LongPortOrderDetail): OpenOrder {
    const contract = makeContract(d.symbol)
    const order = new Order()
    order.action = mapAction(d.side)
    order.totalQuantity = new Decimal(d.submittedQuantity ?? 0)
    order.orderType = d.orderType === 'MO' ? 'MKT' : d.orderType === 'LO' ? 'LMT' : d.orderType
    order.tif = d.timeInForce
    order.orderId = 0
    const orderState = new OrderState()
    orderState.status = mapStatus(d.status)
    return { contract, order, orderState, avgFillPrice: Number(d.avgPrice?.toString?.() ?? 0) || undefined }
  }
}
