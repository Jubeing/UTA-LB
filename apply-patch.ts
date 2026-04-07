/**
 * UTA-LB patch installer for OpenAlice.
 *
 * Run from the UTA-LB root directory:
 *   export OPENALICE_ROOT=/path/to/OpenAlice
 *   node apply-patch.ts
 *
 * This script:
 *  1. Copies broker source files to OpenAlice's src/domain/trading/brokers/longbridge/
 *  2. Patches OpenAlice's broker registry (registry.ts)
 *  3. Patches OpenAlice's broker index (index.ts)
 *  4. Installs longbridge as a root dependency in OpenAlice (for tsup external resolution)
 *  5. Copies UI customizations (PortfolioPage with Chinese stock names, Position.description type)
 *  6. Applies EIA API fixes (credential field name, sort param format, value type)
 */

import { readFileSync, writeFileSync, existsSync, cpSync, mkdirSync, readdirSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const UTA_LB_ROOT = __dirname

// ==================== Helpers ====================

function copyDir(src: string, dest: string): void {
  if (!existsSync(dest)) mkdirSync(dest, { recursive: true })
  for (const f of readdirSync(src)) {
    if (f === 'node_modules' || f === 'dist') continue
    cpSync(resolve(src, f), resolve(dest, f), { force: true, recursive: true })
  }
  console.log(`  ✓ ${src.split('/').slice(-2).join('/')} → ${dest.split('/').slice(-2).join('/')}`)
}

function patchFile(filePath: string, find: string, replace: string): void {
  let content = readFileSync(filePath, 'utf8')
  if (!content.includes(find)) {
    console.error(`⚠  Could not find patch marker in ${filePath}`)
    return
  }
  content = content.replace(find, replace)
  writeFileSync(filePath, content)
  console.log(`  ✓ Patched ${filePath.split('/').slice(-1)[0]}`)
}

// ==================== Main ====================

const OPENALICE_ROOT = process.env.OPENALICE_ROOT
if (!OPENALICE_ROOT) {
  console.error('❌ Missing OPENALICE_ROOT env var.')
  console.error('   export OPENALICE_ROOT=/path/to/OpenAlice')
  process.exit(1)
}

if (!existsSync(resolve(OPENALICE_ROOT, 'src/domain/trading/brokers'))) {
  console.error(`❌ OpenAlice source not found at ${OPENALICE_ROOT}`)
  process.exit(1)
}

console.log(`\n📦 Installing UTA-LB into OpenAlice at ${OPENALICE_ROOT}\n`)

// Step 1: Copy broker source files → src/domain/trading/brokers/longbridge/
console.log('🔧 Copying broker source to src/domain/trading/brokers/longbridge/...')
const brokerDest = resolve(OPENALICE_ROOT, 'src/domain/trading/brokers/longbridge')
copyDir(resolve(UTA_LB_ROOT, 'src/domain/trading/brokers/longbridge'), brokerDest)

// Step 2: Copy broker infrastructure files (types, registry, factory, index)
console.log('\n🔧 Copying broker infrastructure files...')
const infraFiles = ['types.ts', 'registry.ts', 'factory.ts', 'index.ts']
for (const f of infraFiles) {
  const src = resolve(UTA_LB_ROOT, 'src/domain/trading/brokers', f)
  const dest = resolve(OPENALICE_ROOT, 'src/domain/trading/brokers', f)
  if (!existsSync(src)) continue
  const srcContent = readFileSync(src, 'utf8')
  const destExists = existsSync(dest)
  if (!destExists || srcContent !== readFileSync(dest, 'utf8')) {
    cpSync(src, dest, { force: true })
    console.log(`  ✓ ${f} updated`)
  } else {
    console.log(`  ✓ ${f} already current`)
  }
}

// Step 3: Patch registry.ts — add LongbridgeBroker import + registry entry
console.log('\n🔧 Patching registry.ts...')
const registryPath = resolve(OPENALICE_ROOT, 'src/domain/trading/brokers/registry.ts')
{
  const content = readFileSync(registryPath, 'utf8')
  if (!content.includes("'longbridge'")) {
    // Add import
    const importMarker = "import { IbkrBroker } from './ibkr/IbkrBroker.js'"
    const importReplace = "import { IbkrBroker } from './ibkr/IbkrBroker.js'\nimport { LongbridgeBroker } from './longbridge/LongbridgeBroker.js'"
    patchFile(registryPath, importMarker, importReplace)

    // Add registry entry
    const insertAfter = "export const BROKER_REGISTRY: Record<string, BrokerRegistryEntry> = {"
    const entry = `  longbridge: {
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
`
    let content2 = readFileSync(registryPath, 'utf8')
    content2 = content2.replace(insertAfter, entry + insertAfter)
    writeFileSync(registryPath, content2)
    console.log('  ✓ longbridge registry entry added')
  } else {
    console.log('  ✓ registry already contains longbridge')
  }
}

// Step 4: Patch index.ts — add Longbridge exports
console.log('\n🔧 Patching index.ts...')
const indexPath = resolve(OPENALICE_ROOT, 'src/domain/trading/brokers/index.ts')
{
  const content = readFileSync(indexPath, 'utf8')
  if (!content.includes("'./longbridge/LongbridgeBroker.js'")) {
    const marker = "// IBKR\nexport { IbkrBroker } from './ibkr/index.js'"
    const replace = `// Longbridge\nexport { LongbridgeBroker } from './longbridge/LongbridgeBroker.js'\nexport { longbridgeConfigFields } from './longbridge/LongbridgeBroker.js'\n\n// IBKR\nexport { IbkrBroker } from './ibkr/index.js'`
    patchFile(indexPath, marker, replace)
  } else {
    console.log('  ✓ index.ts already exports longbridge')
  }
}

// Step 5: Add longbridge to package.json dependencies
console.log('\n🔧 Adding longbridge to package.json dependencies...')
{
  const pkgPath = resolve(OPENALICE_ROOT, 'package.json')
  const content = readFileSync(pkgPath, 'utf8')
  if (!content.includes('"longbridge"')) {
    patchFile(pkgPath,
      '"decimal.js": "workspace:*"',
      '"decimal.js": "workspace:*",\n    "longbridge": "^4.0.0"'
    )
    console.log('  ✓ longbridge dependency added')
  } else {
    console.log('  ✓ longbridge already in dependencies')
  }
}

// Step 6: Add tsup external for longbridge (so it's not bundled)
console.log('\n🔧 Configuring tsup external for longbridge...')
const tsupPath = resolve(OPENALICE_ROOT, 'tsup.config.ts')
if (!existsSync(tsupPath)) {
  writeFileSync(tsupPath, `import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/main.ts'],
  format: ['esm'],
  dts: true,
  splitting: false,
  sourcemap: true,
  external: ['longbridge'],
})
`)
  console.log('  ✓ tsup.config.ts created with longbridge as external')
} else {
  const content = readFileSync(tsupPath, 'utf8')
  if (!content.includes('longbridge')) {
    patchFile(tsupPath, 'external: []', 'external: [\'longbridge\']')
  } else {
    console.log('  ✓ tsup already configured with longbridge external')
  }
}

// Step 7: Copy UI customizations (PortfolioPage with Chinese stock names, Position.description type)
console.log('\n🔧 Copying UI customizations...')
{
  const uiSrc = resolve(UTA_LB_ROOT, 'ui-pages')
  const uiDest = resolve(OPENALICE_ROOT, 'ui/src')
  for (const f of ['PortfolioPage.tsx', 'types.ts']) {
    const src = resolve(uiSrc, f)
    const dest = resolve(uiDest, f)
    if (existsSync(src)) {
      cpSync(src, dest, { force: true })
      console.log(`  ✓ ${f} → ui/src/`)
    }
  }
}

// Step 8: Apply EIA API fixes
console.log('\n🔧 Applying EIA API fixes...')

// Fix 8a: Fix market-data.json apiUrl (6900 → 6901)
const marketDataConfigPath = resolve(OPENALICE_ROOT, 'data/config/market-data.json')
if (existsSync(marketDataConfigPath)) {
  const configContent = readFileSync(marketDataConfigPath, 'utf8')
  if (configContent.includes('"apiUrl": "http://localhost:6900"')) {
    const newContent = configContent.replace('"apiUrl": "http://localhost:6900"', '"apiUrl": "http://localhost:6901"')
    writeFileSync(marketDataConfigPath, newContent)
    console.log('  ✓ market-data.json: apiUrl 6900 → 6901')
  } else {
    console.log('  ✓ market-data.json: apiUrl already correct')
  }
}

// Fix 8b: Fix EIA credential field name in dist/main.js
const mainJsPath = resolve(OPENALICE_ROOT, 'dist/main.js')
if (existsSync(mainJsPath)) {
  const mainContent = readFileSync(mainJsPath, 'utf8')
  
  // Fix TEST_ENDPOINTS credField: "eia_eia_api_key" → "eia_api_key"
  if (mainContent.includes('credField: "eia_eia_api_key"')) {
    const newContent = mainContent.replace(/credField: "eia_eia_api_key"/g, 'credField: "eia_api_key"')
    writeFileSync(mainJsPath, newContent)
    console.log('  ✓ dist/main.js: EIA credField fixed')
  } else {
    console.log('  ✓ dist/main.js: EIA credField already correct')
  }
  
  // Fix credential map eia: "eia_eia_api_key" → "eia_api_key"
  const mapContent = readFileSync(mainJsPath, 'utf8')
  if (mapContent.includes('eia: "eia_eia_api_key"')) {
    const newContent = mapContent.replace(/eia: "eia_eia_api_key"/g, 'eia: "eia_api_key"')
    writeFileSync(mainJsPath, newContent)
    console.log('  ✓ dist/main.js: credential map fixed')
  } else {
    console.log('  ✓ dist/main.js: credential map already correct')
  }
}

// Fix 8c: Fix EIA API sort parameter format and value type in opentypebb chunk
const opentypebbChunkPath = resolve(OPENALICE_ROOT, 'packages/opentypebb/dist/chunk-USYUVOJM.js')
if (existsSync(opentypebbChunkPath)) {
  const chunkContent = readFileSync(opentypebbChunkPath, 'utf8')
  let modified = false
  
  // Fix sort parameter: JSON.stringify format → proper URL params format
  if (chunkContent.includes('sort: JSON.stringify([{ column: "period", direction: "desc" }])')) {
    const newContent = chunkContent
      .replace(/sort: JSON\.stringify\(\[\{ column: "period", direction: "desc" \}\]\)/g, 
               '"sort[0][column]": "period", "sort[0][direction]": "desc"')
    writeFileSync(opentypebbChunkPath, newContent)
    console.log('  ✓ opentypebb chunk: EIA sort parameter format fixed')
    modified = true
  } else {
    console.log('  ✓ opentypebb chunk: sort parameter already correct')
  }
  
  // Fix Zod schema: value type should accept string (EIA API v2 returns strings)
  // ShortTermEnergyOutlookDataSchema uses z216
  if (chunkContent.includes('value: z216.number().nullable().default(null)')) {
    const newContent = readFileSync(opentypebbChunkPath, 'utf8')
      .replace(/value: z216\.number\(\)\.nullable\(\)\.default\(null\)/g, 
               'value: z216.union([z216.string(), z216.number()]).nullable().default(null)')
    writeFileSync(opentypebbChunkPath, newContent)
    console.log('  ✓ opentypebb chunk: ShortTermEnergyOutlook value type fixed')
    modified = true
  } else {
    console.log('  ✓ opentypebb chunk: ShortTermEnergyOutlook value type already correct')
  }
  
  // PetroleumStatusReportDataSchema uses z215
  if (chunkContent.includes('value: z215.number().nullable().default(null)')) {
    const newContent = readFileSync(opentypebbChunkPath, 'utf8')
      .replace(/value: z215\.number\(\)\.nullable\(\)\.default\(null\)/g, 
               'value: z215.union([z215.string(), z215.number()]).nullable().default(null)')
    writeFileSync(opentypebbChunkPath, newContent)
    console.log('  ✓ opentypebb chunk: PetroleumStatusReport value type fixed')
    modified = true
  } else {
    console.log('  ✓ opentypebb chunk: PetroleumStatusReport value type already correct')
  }
}

console.log('\n✅ UTA-LB patch applied successfully!\n')
console.log('Next steps:')
console.log('  1. cd $OPENALICE_ROOT')
console.log('  2. pnpm install')
console.log('  3. pnpm build')
console.log('  4. sudo systemctl restart openalice')
console.log('\n🎉 All done!')
