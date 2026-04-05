/**
 * UTA-LB patch installer for OpenAlice.
 *
 * Run from the UTA-LB root directory:
 *   export OPENALICE_ROOT=/path/to/OpenAlice
 *   node apply-patch.ts
 *
 * This script:
 *   1. Copies broker source files to OpenAlice's src/domain/trading/brokers/longbridge/
 *   2. Patches OpenAlice's broker registry (src/domain/trading/brokers/registry.ts)
 *   3. Patches OpenAlice's broker index   (src/domain/trading/brokers/index.ts)
 *   4. Copies the packages/longbridge/ workspace package to OpenAlice's packages/
 */

import { readFileSync, writeFileSync, existsSync, cpSync, mkdirSync, readdirSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'
import { execSync } from 'child_process'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const UTA_LB_ROOT = __dirname

interface Patch {
  find: string
  replace: string
}

function patchFile(filePath: string, patches: Patch[]): void {
  let content = readFileSync(filePath, 'utf8')
  for (const { find, replace } of patches) {
    if (!content.includes(find)) {
      console.error(`⚠  Could not find patch marker in ${filePath}:`)
      console.error(`   ${find}`)
    } else {
      content = content.replace(find, replace)
    }
  }
  writeFileSync(filePath, content)
  console.log(`✓ Patched ${filePath}`)
}

function copyPackage(src: string, dest: string): void {
  if (resolve(src) === resolve(dest)) {
    console.log(`  ✓ already in place — skipping`)
    return
  }
  if (!existsSync(dest)) mkdirSync(dest, { recursive: true })
  const files = readdirSync(src).filter(f => f !== 'node_modules' && f !== 'dist')
  for (const f of files) {
    cpSync(resolve(src, f), resolve(dest, f), { force: true, recursive: true })
  }
  console.log(`  ✓ ${src.split('/').slice(-2).join('/')} → ${dest.split('/').slice(-2).join('/')}`)
}

// ---- Main ----

const OPENALICE_ROOT = process.env.OPENALICE_ROOT
if (!OPENALICE_ROOT) {
  console.error('❌ Missing OPENALICE_ROOT env var.')
  console.error('   export OPENALICE_ROOT=/path/to/OpenAlice')
  process.exit(1)
}

if (!existsSync(resolve(OPENALICE_ROOT, 'src/domain/trading/brokers'))) {
  console.error(`❌ OpenAlice source not found at ${OPENALICE_ROOT}`)
  console.error('   Please check that OPENALICE_ROOT points to a valid OpenAlice installation.')
  process.exit(1)
}

console.log(`\n📦 Installing UTA-LB into OpenAlice at ${OPENALICE_ROOT}\n`)

// Step 1: Copy broker source files
console.log('🔧 Copying broker source files to src/domain/trading/brokers/longbridge/...')
const brokerSrcDir = resolve(OPENALICE_ROOT, 'src/domain/trading/brokers/longbridge')
const brokerPkgSrc = resolve(UTA_LB_ROOT, 'packages/longbridge/src')
if (!existsSync(brokerSrcDir)) mkdirSync(brokerSrcDir, { recursive: true })
for (const f of ['index.ts', 'longbridge-auth.ts', 'LongbridgeBroker.ts', 'longbridge-contracts.ts', 'longbridge-types.ts']) {
  const srcFile = resolve(brokerPkgSrc, f)
  const destFile = resolve(brokerSrcDir, f)
  if (existsSync(srcFile)) {
    cpSync(srcFile, destFile, { force: true })
  }
}
console.log('  ✓ broker source files copied')

// Step 2: Copy workspace package
console.log('\n🔧 Copying workspace package to packages/longbridge/...')
const destPkg = resolve(OPENALICE_ROOT, 'packages/longbridge')
copyPackage(resolve(UTA_LB_ROOT, 'packages/longbridge'), destPkg)

// Step 3: Copy broker infrastructure files (types, registry, factory, index)
console.log('\n🔧 Patching broker infrastructure...')
const infraFiles = {
  'types.ts': resolve(OPENALICE_ROOT, 'src/domain/trading/brokers/types.ts'),
  'registry.ts': resolve(OPENALICE_ROOT, 'src/domain/trading/brokers/registry.ts'),
  'factory.ts': resolve(OPENALICE_ROOT, 'src/domain/trading/brokers/factory.ts'),
  'index.ts': resolve(OPENALICE_ROOT, 'src/domain/trading/brokers/index.ts'),
}
for (const [name, path] of Object.entries(infraFiles)) {
  const srcFile = resolve(UTA_LB_ROOT, 'src/domain/trading/brokers', name)
  if (existsSync(srcFile) && existsSync(path)) {
    const srcContent = readFileSync(srcFile, 'utf8')
    const destContent = readFileSync(path, 'utf8')
    if (srcContent !== destContent) {
      cpSync(srcFile, path, { force: true })
      console.log(`  ✓ ${name} updated`)
    } else {
      console.log(`  ✓ ${name} already current`)
    }
  }
}

// Step 4: Patch registry
console.log('\n🔧 Patching broker registry...')
const registryPath = resolve(OPENALICE_ROOT, 'src/domain/trading/brokers/registry.ts')
if (existsSync(registryPath)) {
  const registryContent = readFileSync(registryPath, 'utf8')
  if (!registryContent.includes("'longbridge'")) {
    patchFile(registryPath, [
      {
        find: `import { LongbridgeBroker } from './longbridge/LongbridgeBroker.js'`,
        replace: `import { LongbridgeBroker } from './longbridge/LongbridgeBroker.js'`,
      },
    ])
    let content = readFileSync(registryPath, 'utf8')
    const insertAfter = `export const BROKER_REGISTRY: Record<string, BrokerRegistryEntry> = {`
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
    content = content.replace(insertAfter, entry + insertAfter)
    writeFileSync(registryPath, content)
    console.log('  ✓ registry.ts patched')
  } else {
    console.log('  ✓ registry.ts already contains longbridge')
  }
}

// Step 5: Patch broker index
console.log('\n🔧 Patching broker index...')
const indexPath = resolve(OPENALICE_ROOT, 'src/domain/trading/brokers/index.ts')
if (existsSync(indexPath)) {
  const indexContent = readFileSync(indexPath, 'utf8')
  if (!indexContent.includes("'./longbridge'") && !indexContent.includes('@traderalice/longbridge')) {
    patchFile(indexPath, [
      {
        find: `// Longbridge`,
        replace: `// Longbridge\nexport { LongbridgeBroker } from './longbridge/LongbridgeBroker.js'\nexport { longbridgeConfigFields } from './longbridge/LongbridgeBroker.js'`,
      },
    ])
  } else {
    console.log('  ✓ index.ts already contains longbridge export')
  }
}

console.log('\n✅ UTA-LB patch applied successfully!\n')
console.log('Next steps:')
console.log('  1. cd $OPENALICE_ROOT')
console.log('  2. pnpm install')
console.log('  3. pnpm build')
console.log('  4. sudo systemctl restart openalice')
console.log('\n🎉 All done!')
