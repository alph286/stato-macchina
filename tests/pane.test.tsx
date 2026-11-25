import { expect, test } from 'claude-code/testing'

const PANE = {
  plugin: 'stato-macchina',
  component: 'Pane',
  requestId: 'stato-macchina',
  props: { title: 'Stato', isFocused: false, bodyColumns: 34, placement: 'dock', scroll: { offset: 0, bodyRows: 20 }, view: {} },
} as const

const FILES: Record<string, string> = {
  '/etc/hostname': 'raspberrypi\n',
  '/proc/stat': 'cpu  100 0 100 800 0 0 0 0 0 0\ncpu0 1 0 1 8 0 0 0 0\ncpu1 1 0 1 8 0 0 0 0\n',
  '/proc/meminfo': 'MemTotal: 4000000 kB\nMemAvailable: 2000000 kB\nSwapTotal: 2000000 kB\nSwapFree: 1900000 kB\n',
  '/sys/class/thermal/thermal_zone0/temp': '62300\n',
  '/proc/loadavg': '1.8 1.1 0.6 3/268 1\n',
  '/proc/uptime': '720000.5 1\n',
}

test('il pannello mostra host, RAM, disco, GPU e temperatura', async ($, on) => {
  on('command.register', () => ({ value: { command: 'stato' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('clock.every', () => ({ value: { cancel: () => {} } } as any))
  on('clock.now', () => ({ value: 1 }))
  on('fs.read', (_, e: any) => ({ value: FILES[e.path] ?? '' }))
  on('process.run', (_, e: any) => {
    const a = e.argv.join(' ')
    const out = a.startsWith('df') ? '  size used\n 30000000000 15000000000\n'
      : a.includes('measure_clock') ? 'frequency(46)=500000992\n'
      : a.includes('get_mem') ? 'gpu=76M\n'
      : a.includes('get_throttled') ? 'throttled=0x0\n' : null
    return { value: out === null ? { exitCode: 1, stdout: '', stderr: '' } : { exitCode: 0, stdout: out, stderr: '' } } as any
  })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.command.run({ command: 'stato', args: '' } as any)

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /raspberrypi/ }))).toBeTruthy()
  expect((await ui.find({ type: 'Text', text: /1\.9\/3\.8 GiB/ }))).toBeTruthy()
  expect((await ui.find({ type: 'Text', text: /V3D 500 MHz/ }))).toBeTruthy()
  expect((await ui.find({ type: 'Text', text: /62°C/ }))).toBeTruthy()
  expect((await ui.find({ type: 'Text', text: /nessun throttling/ }))).toBeTruthy()
  await ui.unmount()
})

// Simulazione testuale: righe del pannello a diverse larghezze.
function flat(n: any): string {
  if (n == null || n === false) return ''
  if (typeof n === 'string' || typeof n === 'number') return String(n)
  if (Array.isArray(n)) return n.map(flat).join('')
  const kids = n.props?.children ?? n.children
  if (n.type === 'Box' && n.props?.flexDirection === 'column')
    return (Array.isArray(kids) ? kids : [kids]).map(flat).filter((x: string) => x !== '').join('\n')
  return flat(kids)
}
for (const w of [34, 48, 106]) {
  test(`simula a ${w} colonne`, async ($, on) => {
    on('command.register', () => ({ value: { command: 'stato' } }))
    on('ui.open', () => ({ value: { isPlaced: true } }))
    on('clock.every', () => ({ value: { cancel: () => {} } } as any))
    on('clock.now', () => ({ value: 1 }))
    on('fs.read', (_, e: any) => ({ value: FILES[e.path] ?? '' }))
    on('process.run', (_, e: any) => {
      const a = e.argv.join(' ')
      const out = a.startsWith('df') ? '  size used\n 30000000000 15000000000\n' : a.includes('measure_clock') ? 'frequency(46)=500000992\n' : a.includes('get_mem') ? 'gpu=76M\n' : a.includes('get_throttled') ? 'throttled=0x0\n' : null
      return { value: out === null ? { exitCode: 1, stdout: '', stderr: '' } : { exitCode: 0, stdout: out, stderr: '' } } as any
    })
    on('session.start', (_, e) => ({ cwd: e.cwd }))
    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
    const ui = await $.ui.mount({ ...PANE, props: { ...PANE.props, bodyColumns: w }, surface: 'terminal', viewport: { columns: w + 4, rows: 40 } } as any)
    const txt = flat(await ui.drawn())
    ;(globalThis as any).console.log(`\n=== ${w} colonne ===\n` + txt)
    for (const line of txt.split('\n')) expect(line.length <= w).toBe(true)
    await ui.unmount()
  })
}

for (const [nome, llm, atteso] of [
  ['senza richieste', null, /opus-5-5  cache —/],
  ['cache 1h ancora valida', { model: 'claude-opus-5-5', at: 1 - 13 * 60_000, ttl: '1h', input: 10, read: 980, write: 10 }, /opus-5-5  cache ● 47m\/1h  hit 98%/],
  ['cache 5m scaduta', { model: 'claude-sonnet-5-5', at: 1 - 6 * 60_000, ttl: '5m', input: 10, read: 0, write: 990 }, /sonnet-5-5  cache ✗ scaduta  hit 0%/],
] as const) {
  test(`riga modello e cache: ${nome}`, async ($, on) => {
    on('command.register', () => ({ value: { command: 'stato' } }))
    on('ui.open', () => ({ value: { isPlaced: true } }))
    on('clock.every', () => ({ value: { cancel: () => {} } } as any))
    on('clock.now', () => ({ value: 1 }))
    on('session.model', () => ({ value: 'claude-opus-5-5' }))
    on('state.get', ($, e: any, next: any) =>
      e.key === 'llm' && llm ? { value: { value: { shape: 'llm-1', value: llm }, version: 1 } } : next(e))
    on('fs.read', (_, e: any) => ({ value: FILES[e.path] ?? '' }))
    on('process.run', () => ({ value: { exitCode: 1, stdout: '', stderr: '' } } as any))
    on('session.start', (_, e) => ({ cwd: e.cwd }))
    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    const txt = flat(await ui.drawn())
    ;(globalThis as any).console.log(txt.split('\n').slice(-2).join('\n'))
    expect(txt).toMatch(atteso)
    await ui.unmount()
  })
}

for (const [nome, usage, attesi] of [
  ['contesto 142k su finestra 1M e limiti', {
    startedAt: 0,
    context: { tokens: 142_000, window: 1_000_000, percent: 14 },
    rateLimits: [
      { kind: 'five_hour', percentUsed: 23.5, resetsAt: new Date(1 + (2 * 60 + 15) * 60_000).toISOString() },
      { kind: 'seven_day', percentUsed: 7, resetsAt: new Date(1 + (3 * 24 + 4) * 3_600_000).toISOString() },
    ],
    cost: { usd: 3.456 },
  }, [/Costo ~\$3\.46  stima sessione/, /Ctx   █+░+ 142k/, /di 200k · finestra 1M/, /5h    █+░+  24%/, /reset tra 2h 15m/, /7g    ██░+   7%/, /reset tra 3g 4h/]],
  ['contesto appena compattato', { startedAt: 0, context: { window: 200_000 }, rateLimits: [] },
    [/Ctx   — in attesa di una risposta/]],
] as const) {
  test(`contesto e limiti: ${nome}`, async ($, on) => {
    on('command.register', () => ({ value: { command: 'stato' } }))
    on('ui.open', () => ({ value: { isPlaced: true } }))
    on('clock.every', () => ({ value: { cancel: () => {} } } as any))
    on('clock.now', () => ({ value: 1 }))
    on('session.model', () => ({ value: 'claude-opus-5-5' }))
    on('session.usage', () => ({ value: usage } as any))
    on('fs.read', (_, e: any) => ({ value: FILES[e.path] ?? '' }))
    on('process.run', () => ({ value: { exitCode: 1, stdout: '', stderr: '' } } as any))
    on('session.start', (_, e) => ({ cwd: e.cwd }))
    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    const txt = flat(await ui.drawn())
    ;(globalThis as any).console.log(txt.split('\n').slice(-6).join('\n'))
    for (const a of attesi) expect(txt).toMatch(a)
    for (const line of txt.split('\n')) expect(line.length <= 34).toBe(true)
    await ui.unmount()
  })
}

test('sezione Lavori sotto i limiti, con barra, fermo ed esito', async ($, on) => {
  const now = 10_000_000
  const J = [
    { id: 'a1', kind: 'bash', name: 'Scarica modello Wan 14B', path: '/t/a1.output', pct: 54.3, text: '54 1.2G 54 640M 0 0 8.1M 0 0:02:31 0:01:10 0:01:21 8.2M', size: 1000, rate: 8_400_000, startedAt: now - 70_000, changedAt: now - 1000, done: null },
    { id: 'file:/p/b.log', kind: 'file', name: 'build lab', path: '/p/b.log', pct: null, text: 'Compiling foo v0.1', size: 40_000, rate: 0, startedAt: now - 400_000, changedAt: now - 180_000, done: null },
    { id: 'agent:x', kind: 'agent', name: 'Cerca driver', path: null, pct: null, text: 'Explore · 12k token', size: 0, rate: 0, startedAt: now - 30_000, changedAt: now, done: null },
    { id: 'b2', kind: 'bash', name: 'pip install torch', path: '/t/b2.output', pct: null, text: 'Successfully installed torch', size: 900, rate: 0, startedAt: now - 100_000, changedAt: now - 58_000, done: { code: 0, at: now - 58_000 } },
    { id: 'b3', kind: 'bash', name: 'make test', path: '/t/b3.output', pct: null, text: 'error: 2 failed', size: 900, rate: 0, startedAt: now - 50_000, changedAt: now - 5_000, done: { code: 2, at: now - 5_000 } },
  ]
  on('command.register', () => ({ value: { command: 'stato' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('clock.every', () => ({ value: { cancel: () => {} } } as any))
  on('clock.now', () => ({ value: now }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200_000 }, rateLimits: [{ kind: 'five_hour', percentUsed: 30, resetsAt: new Date(now + 3_600_000).toISOString() }] } } as any))
  on('state.get', ($, e: any, next: any) =>
    e.key === 'jobs' ? { value: { value: { shape: 'jobs-1', value: J }, version: 1 } } : next(e))
  on('fs.read', (_, e: any) => ({ value: FILES[e.path] ?? '' }))
  on('process.run', () => ({ value: { exitCode: 1, stdout: '', stderr: '' } } as any))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' } as any)
  const txt = flat(await ui.drawn())
  ;(globalThis as any).console.log('\n' + txt.split('\n').slice(-19).join('\n'))
  expect(txt).toMatch(/reset tra[^]*─{34}\nLavori  3 in corso/)
  expect(txt).toMatch(/● Scarica modello Wan 14B +1m 10s/)
  expect(txt).toMatch(/ +█+░+  54%/)
  expect(txt).toMatch(/8\.0M\/s/)
  expect(txt).toMatch(/⚠ build lab/)
  expect(txt).toMatch(/fermo da 3m 00s/)
  expect(txt).toMatch(/✓ pip install torch +42s/)
  expect(txt).toMatch(/✗ make test +45s/)
  expect(txt).toMatch(/uscita 2/)
  for (const line of txt.split('\n')) expect(line.length <= 34).toBe(true)
  await ui.unmount()
})
