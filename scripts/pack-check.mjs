#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const tarballName = `${manifest.name}-${manifest.version}.tgz`
const dir = mkdtempSync(join(tmpdir(), 'auxiliary-runtime-pack-'))
const pnpmCli = process.env.npm_execpath

if (!pnpmCli) throw new Error('pack-check must run through pnpm so the exact package-manager entrypoint is known')

try {
  execFileSync(process.execPath, [pnpmCli, 'pack', '--pack-destination', dir], { cwd: root, stdio: 'inherit' })
  const tgz = join(dir, tarballName)
  const listing = execFileSync('tar', ['-tzf', tgz], { encoding: 'utf8' })
  const entries = listing.trim().split('\n').filter(Boolean)
  const allowed = [
    /^package\/package\.json$/,
    /^package\/LICENSE$/,
    /^package\/README\.md$/,
    /^package\/cordis\.patch\.yml$/,
    /^package\/lib\/.+\.js$/,
    /^package\/lib\/.+\.d\.ts$/,
  ]
  const unexpected = entries.filter((entry) => !allowed.some((pattern) => pattern.test(entry)))
  if (unexpected.length > 0) {
    throw new Error(`packed unexpected paths:\n${unexpected.join('\n')}`)
  }
  if (listing.includes('workspace:')) {
    throw new Error('packed tarball contains workspace: protocol')
  }
  const pkgJson = execFileSync('tar', ['-xzf', tgz, '-O', 'package/package.json'], { encoding: 'utf8' })
  if (pkgJson.includes('workspace:')) {
    throw new Error('packed package.json contains workspace:')
  }
  if (!pkgJson.includes(`"version": "${manifest.version}"`)) {
    throw new Error(`packed package.json is not ${manifest.version}`)
  }
  if (!pkgJson.includes('"name": "dsh-plugin-auxiliary-runtime"')) {
    throw new Error('packed package.json is not dsh-plugin-auxiliary-runtime')
  }
  const patch = execFileSync('tar', ['-xzf', tgz, '-O', 'package/cordis.patch.yml'], { encoding: 'utf8' })
  if (!patch.includes('id: auxiliary-runtime') || !patch.includes('name: dsh-plugin-auxiliary-runtime')) {
    throw new Error('packed bundle patch does not insert only auxiliary-runtime')
  }
  if (/(^|\n)\s*-\s*id:\s*(?!auxiliary-runtime\b)/.test(patch.replace(/name:.*/g, ''))) {
    const ids = [...patch.matchAll(/id:\s*(\S+)/g)].map((match) => match[1])
    if (ids.some((id) => id !== 'auxiliary-runtime')) {
      throw new Error(`packed bundle patch inserts unexpected ids: ${ids.join(', ')}`)
    }
  }
  console.log(`pack-check ok (${entries.length} entries)`)
} finally {
  rmSync(dir, { recursive: true, force: true })
}
