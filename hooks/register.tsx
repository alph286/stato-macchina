import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Snapshot } from '../types'

const PANE = 'stato-macchina'
const snap = atom({ plugin: 'stato-macchina', key: 'snap' } as const, null, {
  shape: 'snap-1',
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
    void $.ui.open({ id: PANE, title: 'Stato', columns: 34 })
    return next(e)
  })

  on('command.run', { command: 'stato' }, async $ => {
    await $.ui.open({ id: PANE, title: 'Stato', columns: 34 })
    return { text: 'Pannello stato aperto.' }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const s = await read($, snap)
    if (!s) return <Text dimColor>Raccolgo i dati…</Text>
    // Larghezza del corpo del pannello (non del terminale intero).
    const cols = Math.max(20, e.props.bodyColumns ?? 34)
    // etichetta 6 + barra + " 100%" 5
    const barW = Math.max(6, Math.min(30, cols - 11))
    const color = (p: number) => (p >= 85 ? 'error' : p >= 65 ? 'warning' : 'success')
    const Bar = ({ label, p, info, right }: { label: string; p: number; info?: string; right?: string }) => {
      const n = Math.round((Math.min(100, Math.max(0, p)) / 100) * barW)
      return (
        <Box flexDirection="column">
          <Box>
            <Text bold>{label.padEnd(6)}</Text>
            <Text color={color(p)}>{'█'.repeat(n)}</Text>
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
    return (
      <Box flexDirection="column">
        <Text bold color="claude">{s.host}  <Text dimColor>up {s.uptime}</Text></Text>
        <Bar label="CPU" p={s.cpu} info={`${s.cores} core · load ${s.load}`} />
        <Text color="suggestion">{'      ' + spark}</Text>
        <Bar label="RAM" p={pct(s.memUsed, s.memTotal)} info={`${fmtG(s.memUsed)}/${fmtG(s.memTotal)} GiB`} />
        {s.swapTotal > 0 && <Bar label="Swap" p={pct(s.swapUsed, s.swapTotal)} info={`${fmtG(s.swapUsed)}/${fmtG(s.swapTotal)} GiB`} />}
        <Bar label="Disco" p={pct(s.diskUsed, s.diskTotal)} info={`/ ${fmtG(s.diskUsed)}/${fmtG(s.diskTotal)} GiB`} />
        {s.gpuPct !== null
          ? <Bar label="GPU" p={s.gpuPct} info={s.gpu ?? ''} />
          : s.gpu && <Text><Text bold>{'GPU   '}</Text><Text>{s.gpu}</Text></Text>}
        {s.tempC !== null && <Bar label="Temp" p={tp} right={`${Math.round(tp)}°C`} />}
        {s.throttled && (
          <Text color={thOk ? 'success' : 'error'}>{thOk ? '      ✓ nessun throttling' : `      ✗ throttled ${s.throttled}`}</Text>
        )}
      </Box>
    )
  })
}
