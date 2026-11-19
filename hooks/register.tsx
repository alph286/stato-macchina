import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Llm, Snapshot } from '../types'

const PANE = 'stato-macchina'
const snap = atom({ plugin: 'stato-macchina', key: 'snap' } as const, null, {
  shape: 'snap-1',
})

const llm = atom({ plugin: 'stato-macchina', key: 'llm' } as const, null as Llm | null, {
  shape: 'llm-1',
})

const GiB = 1024 ** 3
const fmtG = (b: number) => (b / GiB).toFixed(1)
const pct = (u: number, t: number) => (t > 0 ? (u / t) * 100 : 0)
const SPARK = '▁▂▃▄▅▆▇█'

let prev: { idle: number; total: number } | null = null
let hist: number[] = []
let hasVc: boolean | null = null
let hasNv: boolean | null = null
let host = ''

// Divisore animato: una cometa che scorre su una riga di celle (Raster),
// ridipinta con $.ui.blit senza ridisegnare il pannello.
const DIV_KEY = 'divisore'
let divCols = 0
let divT = 0
const BASE = 0x3a3a3a
const HEAD = 0xffd2b0
const TAIL = 0xd97757
const lerp = (a: number, b: number, k: number) => {
  const c = (sh: number) => Math.round(((a >> sh) & 255) * (1 - k) + ((b >> sh) & 255) * k) << sh
  return c(16) | c(8) | c(0)
}
function divFrame(cols: number, t: number): string {
  const w = new Uint32Array(cols * 3)
  const len = Math.max(4, Math.round(cols / 3))
  const span = cols + len
  const head = t % span
  for (let x = 0; x < cols; x++) {
    const d = head - x // distanza dalla testa, verso la coda
    let ch = 0x2500 // ─
    let fg = BASE
    if (d >= 0 && d < len) {
      const k = 1 - d / len
      ch = d === 0 ? 0x25c6 /* ◆ */ : 0x2501 // ━
      fg = d === 0 ? HEAD : lerp(BASE, TAIL, k * k)
    }
    w[x * 3] = ch
    w[x * 3 + 1] = fg
    w[x * 3 + 2] = 0x01000000
  }
  return b64(new Uint8Array(w.buffer))
}
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
function b64(b: Uint8Array): string {
  let o = ''
  for (let i = 0; i < b.length; i += 3) {
    const n = ((b[i] ?? 0) << 16) | ((b[i + 1] ?? 0) << 8) | (b[i + 2] ?? 0)
    o += B64[(n >> 18) & 63]! + B64[(n >> 12) & 63]!
      + (i + 1 < b.length ? B64[(n >> 6) & 63]! : '=') + (i + 2 < b.length ? B64[n & 63]! : '=')
  }
  return o
}

// "claude-opus-5-5" -> "opus-5-5"; toglie anche il suffisso data.
const shortModel = (m: string) => m.replace(/^claude-/, '').replace(/-\d{8}$/, '').replace(/\[.*\]$/, '')
const fmtLeft = (ms: number) => (ms >= 60_000 ? `${Math.floor(ms / 60_000)}m` : `${Math.ceil(ms / 1000)}s`)
// 142000 -> "142k", 1000000 -> "1M"
const fmtK = (n: number) =>
  n >= 1_000_000 ? `${+(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n)
// Tempo che manca a un reset: "3g 4h", "2h 15m", "40m".
const fmtIn = (ms: number) => {
  const m = Math.max(0, Math.round(ms / 60_000))
  const d = Math.floor(m / 1440), h = Math.floor((m % 1440) / 60), mm = m % 60
  return d > 0 ? `${d}g ${h}h` : h > 0 ? `${h}h ${mm}m` : `${mm}m`
}
// Soglia a cui Alph fa /clear o /compact: la barra del contesto va da 0 a qui
// (o alla finestra del modello, se è più piccola).
const CTX_LIMIT = 200_000
// Soglie [giallo, rosso] delle barre della macchina.
// RAM e disco: 80/90%, le soglie abituali di monitoraggio (check_disk, dashboard Node Exporter).
// Temp: sul Raspberry Pi il firmware rallenta la CPU da 80 °C; giallo da 70 °C come preavviso.
// CPU e GPU: nessuno standard, picchi brevi sono normali; restano le vecchie 65/85.
// Swap: con la RAM piena il Pi rallenta molto già usando swap; giallo dal 25%, rosso dal 50%.
type Lim = [number, number]
const LIM: Record<'cpu' | 'ram' | 'swap' | 'disk' | 'temp', Lim> = {
  cpu: [65, 85], ram: [80, 90], swap: [25, 50], disk: [80, 90], temp: [70, 80],
}
const RL_LABEL: Record<string, string> = { five_hour: '5h', seven_day: '7g', spend_limit: 'Spesa' }

async function run($: EngineInterface, argv: string[]): Promise<string | null> {
  try {
    const r = await $.process.run(argv, { timeoutMs: 5000 })
    return r.exitCode === 0 ? String(r.stdout) : null
  } catch {
    return null
  }
}
async function readText($: EngineInterface, p: string): Promise<string | null> {
  try {
    return String(await $.fs.read(p))
  } catch {
    return null
  }
}

async function sample($: EngineInterface): Promise<void> {
  if (!host) host = ((await readText($, '/etc/hostname')) ?? '?').trim()
  // CPU
  const stat = (await readText($, '/proc/stat')) ?? ''
  const lines = stat.split('\n')
  const f = (lines[0] ?? '').trim().split(/\s+/).slice(1).map(Number)
  const idle = (f[3] ?? 0) + (f[4] ?? 0)
  const total = f.reduce((a, b) => a + b, 0)
  let cpu = 0
  if (prev && total > prev.total)
    cpu = 100 * (1 - (idle - prev.idle) / (total - prev.total))
  prev = { idle, total }
  hist = [...hist, cpu].slice(-60)
  const cores = lines.filter(l => /^cpu\d/.test(l)).length
  // RAM
  const mi = (await readText($, '/proc/meminfo')) ?? ''
  const kv = (k: string) => Number(new RegExp(`^${k}:\\s+(\\d+)`, 'm').exec(mi)?.[1] ?? 0) * 1024
  const memTotal = kv('MemTotal')
  const memUsed = memTotal - kv('MemAvailable')
  const swapTotal = kv('SwapTotal')
  const swapUsed = swapTotal - kv('SwapFree')
  // Disco
  const df = await run($, ['df', '-B1', '--output=size,used', '/'])
  const [dT, dU] = (df?.trim().split('\n')[1] ?? '0 0').trim().split(/\s+/).map(Number)
  // Temperatura
  const t = await readText($, '/sys/class/thermal/thermal_zone0/temp')
  let tempC: number | null = t ? Number(t) / 1000 : null
  // GPU
  let gpu: string | null = null
  let gpuPct: number | null = null
  let throttled: string | null = null
  if (hasNv !== false) {
    const nv = await run($, ['nvidia-smi', '--query-gpu=utilization.gpu,memory.used,memory.total,temperature.gpu,name', '--format=csv,noheader,nounits'])
    hasNv = nv !== null
    if (nv) {
      const [u, mu, mt, tg, name] = (nv.split('\n')[0] ?? '').split(',').map(s => s.trim())
      gpuPct = Number(u)
      gpu = `${name} ${mu}/${mt} MiB ${tg}°C`
    }
  }
  if (!gpu && hasVc !== false) {
    const clk = await run($, ['vcgencmd', 'measure_clock', 'v3d'])
    hasVc = clk !== null
    if (clk) {
      const mhz = Math.round(Number(clk.split('=')[1]) / 1e6)
      const mem = (await run($, ['vcgencmd', 'get_mem', 'gpu']))?.split('=')[1]?.trim() ?? '?'
      gpu = `V3D ${mhz} MHz · mem ${mem}`
      const th = (await run($, ['vcgencmd', 'get_throttled']))?.split('=')[1]?.trim() ?? null
      throttled = th
      if (tempC === null) {
        const vt = await run($, ['vcgencmd', 'measure_temp'])
        if (vt) tempC = Number(/([\d.]+)/.exec(vt)?.[1])
      }
    }
  }
  const loadavg = ((await readText($, '/proc/loadavg')) ?? '').split(' ').slice(0, 3).join(' ')
  const up = Number(((await readText($, '/proc/uptime')) ?? '0').split(' ')[0])
  const d = Math.floor(up / 86400), h = Math.floor((up % 86400) / 3600), m = Math.floor((up % 3600) / 60)
  const s: Snapshot = {
    host, cpu, cpuHist: hist, cores, load: loadavg,
    memUsed, memTotal, swapUsed, swapTotal,
    diskUsed: dU ?? 0, diskTotal: dT ?? 0,
    tempC, gpu, gpuPct, throttled,
    uptime: `${d}g ${h}h ${m}m`, at: await $.clock.now(),
  }
  await update($, snap, () => s)
}


export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'stato', description: 'Mostra il pannello stato macchina (CPU, GPU, RAM, disco)' })
    void sample($)
    $.clock.every(2000, () => sample($))
    $.clock.every(70, () => {
      if (divCols <= 0) return
      divT++
      void $.ui.blit({ requestId: PANE, key: DIV_KEY, cells: divFrame(divCols, divT), columns: divCols, rows: 1 })
    })
    void $.ui.open({ id: PANE, title: 'Stato', columns: 34 })
    return next(e)
  })

  on('command.run', { command: 'stato' }, async $ => {
    await $.ui.open({ id: PANE, title: 'Stato', columns: 34 })
    return { text: 'Pannello stato aperto.' }
  })

  // Ogni richiesta del thread principale: modello e token della cache.
  on('turn.step', async function* ($, e, next) {
    const at = await $.clock.now()
    const r = yield* next(e)
    const u = r?.usage
    if (!e.agentId && u) {
      const ttl: Llm['ttl'] = (u.ephemeral_1h_input_tokens ?? 0) > 0 ? '1h'
        : (u.ephemeral_5m_input_tokens ?? 0) > 0 ? '5m' : null
      await update($, llm, prev => ({
        model: u.model || e.model, at,
        // Una lettura rinnova la cache con la durata dell'ultima scrittura.
        ttl: ttl ?? prev?.ttl ?? null,
        input: u.input_tokens, read: u.cache_read_input_tokens, write: u.cache_creation_input_tokens,
      }))
    }
    return r
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const s = await read($, snap)
    if (!s) return <Text dimColor>Raccolgo i dati…</Text>
    // Larghezza del corpo del pannello (non del terminale intero).
    const cols = Math.max(20, e.props.bodyColumns ?? 34)
    // etichetta 6 + barra + " 100%" 5
    const barW = Math.max(6, Math.min(30, cols - 11))
    // Sfumatura continua verde → giallo (50%) → rosso (100%): tinta HSL da 120° a 0°.
    const color = (p: number) => {
      const hue = 120 * (1 - Math.min(100, Math.max(0, p)) / 100)
      const s = 0.75, l = 0.5
      const f = (k: number) => {
        const x = (k + hue / 30) % 12
        const v = l - s * Math.min(l, 1 - l) * Math.max(-1, Math.min(x - 3, 9 - x, 1))
        return Math.round(v * 255).toString(16).padStart(2, '0')
      }
      return `#${f(0)}${f(8)}${f(4)}`
    }
    // Soglie [giallo, rosso] delle barre della macchina; senza soglie la barra sfuma.
    const step = (p: number, [w, c]: Lim) => (p >= c ? 'error' : p >= w ? 'warning' : 'success')
    const Bar = ({ label, p, info, right, lim }: { label: string; p: number; info?: string; right?: string; lim?: Lim }) => {
      const n = Math.round((Math.min(100, Math.max(0, p)) / 100) * barW)
      return (
        <Box flexDirection="column">
          <Box>
            <Text bold>{label.padEnd(6)}</Text>
            <Text color={lim ? step(p, lim) : color(p)}>{'█'.repeat(n)}</Text>
            <Text dimColor>{'░'.repeat(barW - n)}</Text>
            <Text> {right ?? String(Math.round(p)).padStart(3) + '%'}</Text>
          </Box>
          {info && <Text dimColor wrap="truncate">{'      ' + info}</Text>}
        </Box>
      )
    }
    const spark = s.cpuHist.slice(-barW).map(v => SPARK[Math.min(7, Math.floor((v / 100) * 8))]).join('')
    const tp = s.tempC ?? 0
    const thOk = !s.throttled || s.throttled === '0x0'

    // Riga modello + cache
    const L = await read($, llm)
    let model = L?.model
    if (!model) {
      try { model = await $.session.model() } catch { model = '?' }
    }
    model = shortModel(model)
    let cacheTxt = '—'
    let cacheCol: 'success' | 'warning' | 'error' | undefined
    let hit = ''
    if (L) {
      const tot = L.input + L.read + L.write
      if (tot > 0) hit = `hit ${Math.round((100 * L.read) / tot)}%`
      if (L.ttl) {
        const ttlMs = L.ttl === '1h' ? 3_600_000 : 300_000
        const left = L.at + ttlMs - s.at
        if (left <= 0) { cacheTxt = '✗ scaduta'; cacheCol = 'error' }
        else { cacheTxt = `● ${fmtLeft(left)}/${L.ttl}`; cacheCol = left / ttlMs > 0.25 ? 'success' : 'warning' }
      } else if (tot > 0) cacheTxt = L.read > 0 ? '● letta' : '○ nessuna'
    }
    // Contesto e limiti d'uso, come li ha la status line (chiamata gratuita).
    let usage: Awaited<ReturnType<typeof $.session.usage>> | null = null
    try { usage = await $.session.usage() } catch { usage = null }
    const ctx = usage?.context
    // Costo della sessione come lo totalizza /cost: una stima, non la bolletta.
    const cost = usage?.cost
    const ctxMax = Math.min(CTX_LIMIT, ctx?.window || CTX_LIMIT)
    const ctxTok = ctx?.tokens
    const limits = (usage?.rateLimits ?? []).filter(r => RL_LABEL[r.kind])
    const terminal = e.surface === 'terminal'
    if (terminal) divCols = cols
    return (
      <Box flexDirection="column">
        <Text bold color="claude">{s.host}  <Text dimColor>up {s.uptime}</Text></Text>
        <Bar label="CPU" p={s.cpu} lim={LIM.cpu} info={`${s.cores} core · load ${s.load}`} />
        <Text color="suggestion">{'      ' + spark}</Text>
        <Bar label="RAM" p={pct(s.memUsed, s.memTotal)} lim={LIM.ram} info={`${fmtG(s.memUsed)}/${fmtG(s.memTotal)} GiB`} />
        {s.swapTotal > 0 && <Bar label="Swap" p={pct(s.swapUsed, s.swapTotal)} lim={LIM.swap} info={`${fmtG(s.swapUsed)}/${fmtG(s.swapTotal)} GiB`} />}
        <Bar label="Disco" p={pct(s.diskUsed, s.diskTotal)} lim={LIM.disk} info={`/ ${fmtG(s.diskUsed)}/${fmtG(s.diskTotal)} GiB`} />
        {s.gpuPct !== null
          ? <Bar label="GPU" p={s.gpuPct} lim={LIM.cpu} info={s.gpu ?? ''} />
          : s.gpu && <Text><Text bold>{'GPU   '}</Text><Text>{s.gpu}</Text></Text>}
        {s.tempC !== null && <Bar label="Temp" p={tp} lim={LIM.temp} right={`${Math.round(tp)}°C`} />}
        {s.throttled && (
          <Text color={thOk ? 'success' : 'error'}>{thOk ? '      ✓ nessun throttling' : `      ✗ throttled ${s.throttled}`}</Text>
        )}
        {e.surface === 'terminal'
          ? h($.ui.resolve(e).Raster, { key: DIV_KEY, columns: cols, rows: 1, cells: divFrame(cols, divT) })
          : <Text dimColor>{'─'.repeat(cols)}</Text>}
        <Text wrap="truncate">
          <Text bold color="claude">{model}</Text>
          <Text dimColor>  cache </Text>
          <Text color={cacheCol} dimColor={!cacheCol}>{cacheTxt}</Text>
          {hit && <Text dimColor>  {hit}</Text>}
        </Text>
        {cost && (
          <Text wrap="truncate">
            <Text bold>{'Costo '}</Text>
            <Text>~${cost.usd < 100 ? cost.usd.toFixed(2) : Math.round(cost.usd)}</Text>
            <Text dimColor>{'  stima sessione' + (cost.hasUnknownPrice ? ' (prezzo ignoto)' : '')}</Text>
          </Text>
        )}
        {ctx && (ctxTok !== undefined
          ? <Bar label="Ctx" p={pct(ctxTok, ctxMax)} right={fmtK(ctxTok).padStart(4)}
              info={`di ${fmtK(ctxMax)}` + (ctx.window > ctxMax ? ` · finestra ${fmtK(ctx.window)}` : '')} />
          : <Text wrap="truncate"><Text bold>{'Ctx   '}</Text><Text dimColor>— in attesa di una risposta</Text></Text>)}
        {limits.map(r => {
          const at = r.resetsAt ? Date.parse(r.resetsAt) : NaN
          return <Bar key={r.kind} label={RL_LABEL[r.kind]!} p={r.percentUsed}
            info={Number.isFinite(at) ? `reset tra ${fmtIn(at - s.at)}` : undefined} />
        })}
      </Box>
    )
  })
}
