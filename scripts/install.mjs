/**
 * Cross-platform installer: links this plugin's src/ directory into the
 * opencode plugins directory.
 *
 *   node scripts/install.mjs          install (or refresh) the link
 *   node scripts/install.mjs remove   remove the link
 *
 * Windows uses an NTFS junction (no admin rights needed); macOS/Linux use a
 * symlink. opencode resolves the link to its physical path, so the plugin's
 * imports are served from this project's node_modules — keep them installed
 * (npm install).
 */
import { existsSync, lstatSync, mkdirSync, rmSync, symlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = resolve(fileURLToPath(new URL('.', import.meta.url)), '..')
const srcDir = join(projectRoot, 'src')

const configRoot = process.env.XDG_CONFIG_HOME
  ? join(process.env.XDG_CONFIG_HOME, 'opencode')
  : join(homedir(), '.config', 'opencode')
const pluginsDir = join(configRoot, 'plugins')
const linkPath = join(pluginsDir, 'opencode-usage')

function removeExistingLink() {
  if (!existsSync(linkPath))
    return false
  const stat = lstatSync(linkPath)
  if (!stat.isSymbolicLink()) {
    // junctions and symlinks both report isSymbolicLink; anything else was
    // placed there by the user — never touch it
    throw new Error(`refusing to overwrite non-link path: ${linkPath}`)
  }
  rmSync(linkPath, { recursive: true })
  return true
}

if (process.argv.includes('remove')) {
  console.log(removeExistingLink() ? `removed ${linkPath}` : 'not installed — nothing to remove')
  process.exit(0)
}

if (!existsSync(srcDir)) {
  console.error(`src directory not found: ${srcDir}`)
  process.exit(1)
}
if (!existsSync(join(projectRoot, 'node_modules'))) {
  console.error('node_modules not found — run `npm install` in the project root first')
  process.exit(1)
}

const refreshed = removeExistingLink()
mkdirSync(pluginsDir, { recursive: true })
symlinkSync(srcDir, linkPath, process.platform === 'win32' ? 'junction' : 'dir')
console.log(`${refreshed ? 'refreshed' : 'linked'} ${linkPath} -> ${srcDir}`)
console.log('restart opencode (after node_modules changes: `opencode service restart`) and open a session to see the panel')
