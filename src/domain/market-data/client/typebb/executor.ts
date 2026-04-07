/**
 * SDK Executor Singleton
 *
 * Creates and caches a QueryExecutor instance from OpenTypeBB.
 * The executor can call any of the 114 fetcher models across 11 providers
 * without HTTP overhead.
 *
 * Workaround for OpenBB SDK bug: the Provider constructor prepends
 * "{provider.name}_" to credential field names (e.g., "api_key" ->
 * "federal_reserve_api_key"), but the FRED/EIA extractors still read
 * the original unprefixed names ("fred_api_key", "eia_api_key").
 * This wrapper patches credentials before filterCredentials runs so the
 * extractors find what they expect.
 */

import { createExecutor, type QueryExecutor } from '@traderalice/opentypebb'

let _executor: QueryExecutor | null = null

/**
 * OpenBB credential-patching executor wrapper.
 * Adds missing "unprefixed" credential keys that the SDK's
 * filterCredentials strips away but extractData still needs.
 */
function wrapExecutor(executor: QueryExecutor): QueryExecutor {
  // OpenBB SDK bug: the Provider constructor prepends "{name}_" to credential
  // field names (e.g. "api_key" -> "federal_reserve_api_key"), but FRED/EIA
  // extractors read the original unprefixed names (fred_api_key, eia_api_key).
  // filterCredentials only passes keys that match provider.credentials[], so
  // the prefixed key passes the filter but the extractor then can't find it.
  //
  // Two-part fix:
  //  1. Patch provider.credentials[] to declare the names extractors expect.
  //  2. Intercept execute() and copy the prefixed key value into the
  //     unprefixed key slot so filterCredentials finds it.
  try {
    const frProv = executor.getProvider('federal_reserve')
    if (frProv.credentials[0] === 'federal_reserve_api_key') {
      frProv.credentials[0] = 'fred_api_key'
    }
  } catch { /* provider not yet registered */ }
  try {
    const eiaProv = executor.getProvider('eia')
    if (eiaProv.credentials[0] === 'eia_eia_api_key') {
      eiaProv.credentials[0] = 'eia_api_key'
    }
  } catch { /* provider not yet registered */ }

  const origExecute = executor.execute.bind(executor)
  ;(executor as any).execute = async function (
    providerName: string,
    modelName: string,
    params: Record<string, unknown>,
    credentials: Record<string, string> | null,
  ) {
    const creds: Record<string, string> = credentials ? { ...credentials } : {}
    if (providerName === 'federal_reserve' && creds['federal_reserve_api_key'] && !creds['fred_api_key']) {
      creds['fred_api_key'] = creds['federal_reserve_api_key']
    }
    if (providerName === 'eia' && creds['eia_eia_api_key'] && !creds['eia_api_key']) {
      creds['eia_api_key'] = creds['eia_eia_api_key']
    }
    return origExecute(providerName, modelName, params, creds)
  }
  return executor
}

export function getSDKExecutor(): QueryExecutor {
  if (!_executor) _executor = wrapExecutor(createExecutor())
  return _executor
}
