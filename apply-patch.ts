/**
 * UTA-LB patch installer for OpenAlice.
 *
 * Run from the UTA-LB root directory:
 *   export OPENALICE_ROOT=/path/to/OpenAlice
 *   node apply-patch.ts
 *
 * This script:
 *   1. Copies broker source files to OpenAlice's src/domain/trading/brokers/longbridge/
 *   2. Patches OpenAlice's broker registry (registry.ts)
 *   3. Patches OpenAlice's broker index (index.ts)
 *   4. Installs longbridge as a root dependency in OpenAlice (for tsup external resolution)
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
  console.log(`✓ Patched ${filePath.split('/').slice(-1)[0]}`)
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
    // Add after "decimal.js"
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
  writeFileSync(tsupPath, `import { defineConfig } from 'tsup'\n\nexport default defineConfig({\n  entry: ['src/main.ts'],\n  format: ['esm'],\n  dts: true,\n  splitting: false,\n  sourcemap: true,\n  external: ['longbridge'],\n})\n`)
  console.log('  ✓ tsup.config.ts created with longbridge as external')
} else {
  const content = readFileSync(tsupPath, 'utf8')
  if (!content.includes('longbridge')) {
    patchFile(tsupPath, 'external: []', 'external: [\'longbridge\']')
  } else {
    console.log('  ✓ tsup already configured with longbridge external')
  }
}

console.log('\n✅ UTA-LB patch applied successfully!\n')
console.log('Next steps:')
console.log('  1. cd $OPENALICE_ROOT')
console.log('  2. pnpm install')
console.log('  3. pnpm build')
console.log('  4. sudo systemctl restart openalice')
console.log('\n🎉 All done!')
