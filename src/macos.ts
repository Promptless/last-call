import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { capture, processIdentity } from './process.js';
import { Store } from './store.js';
import { errorMessage } from './files.js';

export const SERVICE_LABEL = 'io.lastcall.scheduler';
const xml = (value: string): string => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;');
export function servicePlist(home: string, entry: string, path: string, env: NodeJS.ProcessEnv = process.env): string {
  const args = [process.execPath, entry, '--home', home, '_daemon'];
  const environment = { PATH: path, CODEX_HOME: env.CODEX_HOME ?? join(homedir(), '.codex'), CLAUDE_CONFIG_DIR: env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude') };
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>
<key>Label</key><string>${SERVICE_LABEL}</string>
<key>ProgramArguments</key><array>${args.map(arg => `<string>${xml(arg)}</string>`).join('')}</array>
<key>EnvironmentVariables</key><dict>${Object.entries(environment).map(([key, value]) => `<key>${key}</key><string>${xml(value)}</string>`).join('')}</dict>
<key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ThrottleInterval</key><integer>30</integer>
<key>StandardOutPath</key><string>${xml(join(home, 'service.log'))}</string>
<key>StandardErrorPath</key><string>${xml(join(home, 'service.log'))}</string>
</dict></plist>\n`;
}
export function requireMac(): void { if (process.platform !== 'darwin') throw new Error('Background service and setup require macOS.'); }
export function assertServiceHome(path: string, home: string): void {
  const output = execFileSync('/usr/bin/plutil', ['-extract', 'ProgramArguments', 'json', '-o', '-', '--', path], { encoding: 'utf8' });
  const args = z.array(z.string()).parse(JSON.parse(output));
  const index = args.indexOf('--home');
  if (index < 0 || args[index + 1] !== home) throw new Error('The service belongs to another Last Call home');
}
export async function enableService(home: string, entry: string): Promise<void> {
  requireMac();
  const path = join(homedir(), 'Library', 'LaunchAgents', `${SERVICE_LABEL}.plist`);
  if (existsSync(path)) assertServiceHome(path, home);
  const domain = `gui/${process.getuid!()}`;
  await disableService(home);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, servicePlist(home, entry, process.env.PATH ?? '/usr/bin:/bin'), { mode: 0o600 });
  const result = await capture('/bin/launchctl', ['bootstrap', domain, path]);
  if (result.code) throw new Error(`launchd could not load Last Call: ${result.stderr.trim()}`);
  const check = await capture('/bin/launchctl', ['print', `${domain}/${SERVICE_LABEL}`]);
  if (check.code) throw new Error('launchd did not retain the Last Call service');
}
export async function disableService(home: string): Promise<void> {
  requireMac();
  const path = join(homedir(), 'Library', 'LaunchAgents', `${SERVICE_LABEL}.plist`);
  if (!existsSync(path)) return;
  assertServiceHome(path, home);
  const domain = `gui/${process.getuid!()}/${SERVICE_LABEL}`;
  const loaded = await capture('/bin/launchctl', ['print', domain]);
  if (!loaded.code) {
    const result = await capture('/bin/launchctl', ['bootout', domain]);
    if (result.code) throw new Error(`Could not stop Last Call service: ${result.stderr.trim()}`);
  }
  rmSync(path);
}
export async function notify(title: string, message: string): Promise<void> {
  if (process.platform !== 'darwin') return;
  // Pass content as argv, never interpolate agent output into AppleScript source.
  const script = 'on run argv\ndisplay notification (item 2 of argv) with title (item 1 of argv)\nend run';
  const result = await capture('/usr/bin/osascript', ['-e', script, title, message], { timeout: 5000 });
  if (result.code) throw new Error(`Desktop notification failed: ${result.stderr.trim()}`);
}
export class KeepAwake {
  private child?: ChildProcess;
  async update(enabled: boolean, sprintActive: boolean): Promise<void> {
    let keep = enabled && sprintActive && process.platform === 'darwin';
    if (keep) { const result = await capture('/usr/bin/pmset', ['-g', 'batt']); keep = result.code === 0 && result.stdout.includes('AC Power'); }
    if (keep && !this.child) {
      this.child = spawn('/usr/bin/caffeinate', ['-i', '-w', String(process.pid)], { stdio: 'ignore' });
      this.child.on('error', error => { process.stderr.write(`Keep-awake failed: ${errorMessage(error)}\n`); this.child = undefined; });
      this.child.on('exit', () => { this.child = undefined; });
    }
    if (!keep) this.stop();
  }
  stop(): void { this.child?.kill(); this.child = undefined; }
}

export interface Lease { pid: number; identity: string }
export function acquireLease(store: Store): Lease {
  return store.transaction(() => {
    const old = store.get<Lease>('setting', 'lease');
    if (old && processIdentity(old.pid) === old.identity) throw new Error(`Scheduler already running as PID ${old.pid}`);
    const identity = processIdentity(process.pid);
    if (!identity) throw new Error('Cannot establish scheduler process identity');
    const lease = { pid: process.pid, identity }; store.put('setting', 'lease', lease); return lease;
  });
}

/** Install a pinned upstream release into Last Call's private dependency directory. */
export async function installCodexBar(home: string): Promise<string> {
  requireMac();
  const tag = 'v0.60.1';
  const arch = process.arch === 'arm64' ? 'arm64' : process.arch === 'x64' ? 'x86_64' : undefined;
  if (!arch) throw new Error(`Unsupported architecture: ${process.arch}`);
  const filename = `CodexBarCLI-${tag}-macos-${arch}.tar.gz`;
  const digest = arch === 'arm64' ? 'fe6ba88d297bf1d6b574cd083448f652120126f67220d5a4b6dcc50404e7c4c9' : 'b9abad659e8ca69d44d4444b6258ce7ae0e3e2f15f7ab516f3b4a5e2c1c3e54c';
  const directory = join(home, 'deps', `codexbar-${tag}`);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const response = await fetch(`https://github.com/steipete/CodexBar/releases/download/${tag}/${filename}`, { signal: AbortSignal.timeout(60_000) });
  if (!response.ok) throw new Error(`CodexBar download failed: HTTP ${response.status}`);
  const content = Buffer.from(await response.arrayBuffer());
  if (createHash('sha256').update(content).digest('hex') !== digest) throw new Error('CodexBar download checksum mismatch');
  const archive = join(directory, filename); writeFileSync(archive, content, { mode: 0o600 });
  const extraction = await capture('/usr/bin/tar', ['-xzf', archive, '-C', directory], { timeout: 30_000 });
  if (extraction.code) throw new Error(`CodexBar extraction failed: ${extraction.stderr}`);
  const binary = join(directory, 'CodexBarCLI');
  chmodSync(binary, 0o700);
  copyFileSync(new URL('../licenses/CodexBar-MIT.txt', import.meta.url), join(directory, 'LICENSE'));
  const version = await capture(binary, ['--version']);
  if (version.code) throw new Error('Downloaded CodexBar could not run');
  rmSync(archive);
  return binary;
}
