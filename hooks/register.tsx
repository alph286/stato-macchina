import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Job, Llm, Snapshot } from '../types'
import { bgFromText, fmtB, fmtDur, isDetached, OPEN_FILES_CMD, openPaths, parseProgress, scanFiles } from './lavori'

const PANE = 'stato-macchina'
const snap = atom({ plugin: 'stato-macchina', key: 'snap' } as const, null, {
  shape: 'snap-1',
})

const llm = atom({ plugin: 'stato-macchina', key: 'llm' } as const, null as Llm | null, {
  shape: 'llm-1',
})

const jobs = atom({ plugin: 'stato-macchina', key: 'jobs' } as const, [] as Job[], {
  shape: 'jobs-1',
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
// Prima cometa: testa 0xffd2b0, coda 0xd97757 (i valori di default di divFrame).
// Seconda cometa, sopra i lavori in background: azzurra, si muove solo se c'è un lavoro in corso.
const DIV2_KEY = 'divisore-lavori'
const HEAD2 = 0xc8e0ff
const TAIL2 = 0x5f87d7
let div2T = 0
let jobsRunning = false
const lerp = (a: number, b: number, k: number) => {
  const c = (sh: number) => Math.round(((a >> sh) & 255) * (1 - k) + ((b >> sh) & 255) * k) << sh
  return c(16) | c(8) | c(0)
}
function divFrame(cols: number, t: number, HEAD = 0xffd2b0, TAIL = 0xd97757): string {
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

// ── Lavori in background ────────────────────────────────────────────────
// Fonti: (1) la cronologia della sessione, per i comandi Bash in background
// (anche Ctrl+B o timeout), i Monitor e i file di log dei comandi staccati;
// (2) la cartella tasks/ della sessione, come rete di sicurezza; (3) il
// registro di `traccia`; (4) $.agent.list() per gli agenti.

type Tracked = {
  kind: Job['kind']
  name: string
  path: string | null
  startedAt: number
  /** File di log trovati nel comando: letti se l'output del task resta vuoto. */
  files: string[]
  /** File scaricati dal comando: seguiti (solo dimensione) se nessun log esiste. */
  downloads?: string[]
  /** File seguito senza un task che dica quando finisce (nohup, traccia). */
  detached: boolean
  /** Comando staccato: finisce quando nessun processo tiene più aperti i suoi file. */
  holder?: boolean
  /** Giri consecutivi in cui nessun processo teneva aperto il file. */
  misses?: number
  seen: boolean
}
const tracked = new Map<string, Tracked>()
const toolUses = new Map<string, { tool: string; input: Record<string, unknown> }>()
const prevSize = new Map<string, { size: number; at: number }>()
let lastUuid: string | undefined
let tasksDir: string | null = null
let sid = ''
let home = ''
let cwd = ''
let traccePath = ''
let scanning = false
const DONE_KEEP = 120_000 // un lavoro finito resta visibile 2 minuti
const STALL = 60_000 // un log fermo da 1 minuto diventa giallo
const DETACHED_DROP = 15 * 60_000 // un file staccato fermo da 15 minuti sparisce
const HOLDER_IDLE = 3_000 // dopo 3 s senza scritture si controlla se un processo tiene aperto il file

function track(id: string, t: Omit<Tracked, 'seen'>) {
  if (!tracked.has(id)) tracked.set(id, { ...t, seen: false })
}

function onToolResult(use: { tool: string; input: Record<string, unknown> }, text: string, result: unknown, at: number) {
  const r = (result && typeof result === 'object' ? result : {}) as Record<string, unknown>
  const inp = use.input
  if (use.tool === 'Bash') {
    const cmd = String(inp.command ?? '')
    const name = String(inp.description ?? '') || cmd.slice(0, 60)
    const { logs: files, downloads } = scanFiles(cmd, cwd, home)
    const bg = typeof r.backgroundTaskId === 'string'
      ? { id: r.backgroundTaskId, path: bgFromText(text)?.path ?? null }
      : bgFromText(text)
    if (bg) {
      if (bg.path) tasksDir = bg.path.replace(/\/[^/]+$/, '')
      const path = bg.path ?? (tasksDir ? `${tasksDir}/${bg.id}.output` : null)
      track(bg.id, { kind: 'bash', name, path, startedAt: at, files, downloads, detached: false })
    } else if (isDetached(cmd)) {
      // Una riga per comando: si segue il primo log, gli altri file fanno da riserva.
      const [first, ...rest] = [...files, ...downloads]
      if (first) track(`file:${first}`, {
        kind: 'file', name, path: first, startedAt: at,
        files: rest.filter(f => files.includes(f)), downloads: rest.filter(f => downloads.includes(f)), detached: true, holder: true,
      })
    }
  } else if (use.tool === 'Monitor') {
    const id = typeof r.taskId === 'string' ? r.taskId : /task(?:\s+ID)?[:\s]+([A-Za-z0-9_-]+)/i.exec(text)?.[1]
    if (id) track(id, {
      kind: 'monitor', name: String(inp.description ?? 'Monitor'),
      path: tasksDir ? `${tasksDir}/${id}.output` : null, startedAt: at, files: [], detached: false,
    })
  }
}

async function readMessages($: EngineInterface, now: number) {
  let fresh: Awaited<ReturnType<typeof $.session.messages>>
  try {
    fresh = await $.session.messages(lastUuid ? { after: lastUuid } : { last: 400 })
  } catch { return }
  if ('deny' in fresh) { lastUuid = undefined; return }
  for (const m of fresh) {
    for (const u of m.toolUses ?? []) {
      toolUses.set(u.tool_use_id, { tool: u.tool, input: u.input })
      if (u.text !== undefined && !u.isError) onToolResult(u, u.text, u.result, now)
    }
    for (const r of m.toolResults ?? []) {
      const u = toolUses.get(r.tool_use_id)
      if (u && !r.isError) onToolResult(u, r.text ?? '', r.result, now)
    }
    if (m.uuid) lastUuid = m.uuid
  }
}

async function readTracce($: EngineInterface, now: number) {
  const txt = await readText($, traccePath)
  if (!txt) return
  for (const line of txt.split('\n')) {
    const [ts, op, path, ...rest] = line.split('\t')
    if (!path) continue
    const id = `file:${path}`
    if (op === 'fine') {
      const t = tracked.get(id)
      if (t) t.detached = false, (t as Tracked & { ended?: number }).ended = Number(ts) * 1000 || now
      continue
    }
    track(id, {
      kind: 'file', name: rest.join('\t') || path.replace(/^.*\//, ''), path,
      startedAt: Number(ts) * 1000 || now, files: [], detached: true,
    })
  }
}

async function statOf($: EngineInterface, p: string) {
  try {
    const s = await $.fs.stat(p)
    return s.kind === 'file' ? s : null
  } catch { return null }
}

async function tailOf($: EngineInterface, p: string, size: number): Promise<string> {
  const offset = Math.max(0, size - 4096)
  try {
    return String(await $.fs.read(p, { offset, length: size - offset }))
  } catch { return '' }
}

// Un download binario non ha righe da mostrare: basta dimensione e velocità.
const isBinary = (s: string) => {
  if (!s) return false
  let bad = 0
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    if (c === 0xfffd || (c < 32 && c !== 9 && c !== 10 && c !== 13 && c !== 27)) bad++
  }
  return bad / s.length > 0.1
}

async function scanJobs($: EngineInterface): Promise<void> {
  if (scanning) return
  scanning = true
  try {
    const now = await $.clock.now()
    if (!sid) {
      sid = (await $.session.id().catch(() => '')) || ''
      home = (await $.env.get('HOME')) ?? ''
      cwd = await $.session.cwd().catch(() => '')
      const state = (await $.env.get('XDG_STATE_HOME')) || `${home}/.local/state`
      traccePath = `${state}/stato-macchina/traccia/${sid}.tsv`
      // La cartella tasks/ della sessione: <tmp>/claude-<uid>/<progetto>/<sessione>/tasks
      const tmp = (await $.env.get('CLAUDE_CODE_TMPDIR')) || '/tmp'
      const uid = ((await run($, ['id', '-u'])) ?? '').trim()
      const root = `${tmp}/claude-${uid}`
      try {
        for (const d of await $.fs.list(root))
          if (d.kind === 'dir' && await $.fs.exists(`${root}/${d.name}/${sid}/tasks`)) {
            tasksDir = `${root}/${d.name}/${sid}/tasks`
            break
          }
      } catch { /* nessuna cartella: si ricava dal primo comando in background */ }
    }
    await readMessages($, now)
    if (traccePath) await readTracce($, now)
    // Rete di sicurezza: un .output in crescita che la cronologia non ha ancora nominato.
    if (tasksDir) {
      try {
        for (const f of await $.fs.list(tasksDir)) {
          const id = f.name.replace(/\.output$/, '')
          if (f.kind !== 'file' || id === f.name || tracked.has(id) || f.size === 0) continue
          if (now - f.mtimeMs > 10_000) continue
          track(id, { kind: 'bash', name: `comando ${id}`, path: `${tasksDir}/${id}`.concat('.output'), startedAt: now, files: [], detached: false })
        }
      } catch { /* cartella sparita */ }
    }

    const old = new Map((await read($, jobs)).map(j => [j.id, j]))
    const out: Job[] = []
    // File aperti dai processi: letti al massimo una volta per giro, solo se serve.
    let open: Set<string> | null | undefined
    for (const [id, t] of tracked) {
      const prev = old.get(id)
      const startedAt = prev?.startedAt ?? t.startedAt
      let path = t.path
      let st = path ? await statOf($, path) : null
      // Il task non scrive niente (cmd > log 2>&1): segui il suo file di log;
      // il file scaricato (solo dimensione e velocità) se nessun log esiste.
      for (const list of [t.files, t.downloads ?? []]) {
        if (!list.length || (st && st.size > 0)) continue
        for (const f of list) {
          const fs = await statOf($, f)
          if (fs && (!st || st.size === 0 || fs.mtimeMs > (st.mtimeMs ?? 0))) { st = fs; path = f }
        }
      }
      const ended = (t as Tracked & { ended?: number }).ended
      if (!st) {
        // File sparito o mai nato.
        if (prev?.done) { if (now - prev.done.at < DONE_KEEP) out.push(prev); else tracked.delete(id); continue }
        if (t.seen || ended) {
          out.push({ ...(prev ?? emptyJob(id, t, startedAt)), done: { code: prev?.done?.code ?? null, at: ended ?? now } })
          continue
        }
        // Mai visto: si aspetta il file fino a 30 s senza mostrarlo (dopo un
        // ricaricamento la cronologia rinomina anche task finiti da tempo).
        if (now - t.startedAt > 30_000) tracked.delete(id)
        else if (prev) out.push(prev)
        continue
      }
      t.seen = true
      const ps = prevSize.get(path!)
      const rate = ps && now > ps.at && st.size >= ps.size ? ((st.size - ps.size) * 1000) / (now - ps.at) : prev?.rate ?? 0
      prevSize.set(path!, { size: st.size, at: now })
      let pct = prev?.pct ?? null, text = prev?.text ?? '', exit: number | null = null
      if (!prev || st.size !== prev.size || !ps) {
        const tail = await tailOf($, path!, st.size)
        if (isBinary(tail)) { text = ''; pct = null }
        else ({ pct, text, exit } = parseProgress(tail))
        // L'esito sta nel file del task, anche quando si legge il log del comando.
        if (exit === null && path !== t.path && t.path) {
          const own = await statOf($, t.path)
          if (own && own.size > 0) exit = parseProgress(await tailOf($, t.path, own.size)).exit
        }
      } else if (path !== t.path && t.path) {
        const own = await statOf($, t.path)
        if (own && own.size > 0) exit = parseProgress(await tailOf($, t.path, own.size)).exit
      }
      const changedAt = Math.max(st.mtimeMs, prev?.changedAt ?? 0)
      let done = prev?.done ?? null
      // L'esito si data all'ultima scrittura del file: un task finito da tempo non ricompare.
      if (!done && exit !== null) done = { code: exit, at: Math.min(now, st.mtimeMs || now) }
      if (!done && ended) done = { code: null, at: ended }
      // Comando staccato fermo da qualche secondo: finito se nessun processo ha
      // più aperto i suoi file per due giri di fila (l'esito non si conosce).
      if (!done && t.holder && now - st.mtimeMs > HOLDER_IDLE) {
        if (open === undefined) {
          try {
            const r = await $.process.run(OPEN_FILES_CMD, { timeoutMs: 5000 })
            open = r.exitCode === 0 ? openPaths(String(r.stdout)) : null
          } catch { open = null }
        }
        if (open) {
          const mine = [t.path, ...t.files, ...(t.downloads ?? [])]
          t.misses = mine.some(f => f && open!.has(f)) ? 0 : (t.misses ?? 0) + 1
          if (t.misses >= 2) done = { code: null, at: Math.min(now, st.mtimeMs || now) }
        }
      }
      if (done && now - done.at > DONE_KEEP) { tracked.delete(id); continue }
      if (!done && t.detached && now - changedAt > DETACHED_DROP) { tracked.delete(id); continue }
      out.push({ id, kind: t.kind, name: t.name, path, pct, text, size: st.size, rate, startedAt, changedAt, done })
    }

    // Agenti: quelli in corso e quelli finiti da poco.
    try {
      for (const a of await $.agent.list()) {
        const id = `agent:${a.id}`
        const prev = old.get(id)
        const running = a.taskStatus === 'running' || a.taskStatus === 'pending'
        if (!running && !prev) continue
        let done = prev?.done ?? null
        if (!running && !done) done = { code: a.taskStatus === 'completed' ? 0 : 1, at: now }
        if (done && now - done.at > DONE_KEEP) continue
        const label = a.label && a.label !== a.description ? a.label.trim().split('\n').at(-1)! : ''
        out.push({
          id, kind: 'agent', name: a.description || a.type, path: null, pct: null,
          text: label || `${a.type} · ${Math.round(a.tokenCount / 1000)}k token`,
          size: 0, rate: 0, startedAt: a.startTime, changedAt: now, done,
        })
      }
    } catch { /* agenti non disponibili */ }

    jobsRunning = out.some(j => !j.done)
    const same = JSON.stringify(out.map(j => ({ ...j, rate: Math.round(j.rate) }))) ===
      JSON.stringify([...old.values()].map(j => ({ ...j, rate: Math.round(j.rate) })))
    if (!same) await update($, jobs, () => out)
  } finally {
    scanning = false
  }
}

function emptyJob(id: string, t: Tracked, startedAt: number): Job {
  return { id, kind: t.kind, name: t.name, path: t.path, pct: null, text: '', size: 0, rate: 0, startedAt, changedAt: startedAt, done: null }
}

const PROMPT_LAVORI = [
  'Pannello «Stato» (mod stato-macchina): mostra l\'avanzamento dei lavori in background leggendo i loro log.',
  '- I comandi Bash con run_in_background, i Monitor e gli agenti in background compaiono da soli.',
  '- Anche i comandi staccati (nohup, setsid, `&` finale, screen/tmux -d) che scrivono con >, >>, tee, -o, --log su un file.',
  '- Ogni altro log o file che cresce e che vuoi far vedere (log scritto da uno script, file copiato da un altro host, download avviato altrove): registralo con `traccia <file> "descrizione breve"` appena lo crei; `traccia --fine <file>` quando è finito.',
  '- Per avere una percentuale nel pannello, preferisci opzioni che stampano l\'avanzamento: curl --progress-bar, wget --progress=dot:mega, rsync --info=progress2, pip con la barra di default.',
].join('\n')


export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'stato', description: 'Mostra il pannello stato macchina (CPU, GPU, RAM, disco)' })
    void sample($)
    $.clock.every(2000, () => sample($))
    void scanJobs($).catch(() => {})
    $.clock.every(2000, () => scanJobs($).catch(() => {}))
    $.clock.every(70, () => {
      if (divCols <= 0) return
      divT++
      void $.ui.blit({ requestId: PANE, key: DIV_KEY, cells: divFrame(divCols, divT), columns: divCols, rows: 1 })
      if (jobsRunning) {
        div2T++
        void $.ui.blit({ requestId: PANE, key: DIV2_KEY, cells: divFrame(divCols, div2T, HEAD2, TAIL2), columns: divCols, rows: 1 })
      }
    })
    void $.ui.open({ id: PANE, title: 'Stato', columns: 34 })
    return next(e)
  })

  // Istruzione fissa per Claude: come far comparire i log nel pannello.
  on('prompt.compose', async ($, e, next) => {
    const r = await next(e)
    return { sections: [...r.sections, { id: 'stato-macchina:lavori', text: PROMPT_LAVORI, scope: 'session' as const }] }
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
    const Bar = ({ label, p, info, right, lim, col }: { label: string; p: number; info?: string; right?: string; lim?: Lim; col?: string }) => {
      const n = Math.round((Math.min(100, Math.max(0, p)) / 100) * barW)
      return (
        <Box flexDirection="column">
          <Box>
            <Text bold>{label.padEnd(6)}</Text>
            <Text color={col ?? (lim ? step(p, lim) : color(p))}>{'█'.repeat(n)}</Text>
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
    // Lavori: prima quelli in corso (i più recenti in alto), poi i finiti; al massimo 6.
    const J = [...(await read($, jobs))].sort((a, b) =>
      (a.done ? 1 : 0) - (b.done ? 1 : 0) || b.startedAt - a.startedAt)
    const shown = J.slice(0, 6)
    const anyRunning = J.some(j => !j.done)
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
        {terminal && anyRunning
          ? h($.ui.resolve(e).Raster, { key: DIV2_KEY, columns: cols, rows: 1, cells: divFrame(cols, div2T, HEAD2, TAIL2) })
          : <Text dimColor>{'─'.repeat(cols)}</Text>}
        {J.length === 0
          ? <Text wrap="truncate"><Text bold>{'Lavori'}</Text><Text dimColor>  nessuno in background</Text></Text>
          : <Text wrap="truncate"><Text bold>{'Lavori'}</Text><Text dimColor>{`  ${J.filter(j => !j.done).length} in corso`}</Text></Text>}
        {shown.map(j => {
          const end = j.done?.at ?? s.at
          const dur = fmtDur(end - j.startedAt)
          const stalled = !j.done && j.kind !== 'agent' && j.size > 0 && s.at - j.changedAt > STALL
          const icon = j.done ? (j.done.code === 0 || j.done.code === null ? '✓' : '✗') : stalled ? '⚠' : '●'
          const icCol = j.done ? (j.done.code === 0 || j.done.code === null ? 'success' : 'error') : stalled ? 'warning' : 'suggestion'
          const nameW = Math.max(4, cols - 3 - dur.length)
          const name = j.name.length > nameW ? j.name.slice(0, nameW - 1) + '…' : j.name.padEnd(nameW)
          const bits: string[] = []
          if (j.done && j.done.code !== null && j.done.code !== 0) bits.push(`uscita ${j.done.code}`)
          if (j.kind === 'file' || (j.pct === null && !j.text && j.size > 0)) bits.push(fmtB(j.size))
          if (!j.done && j.rate > 0) bits.push(`${fmtB(j.rate)}/s`)
          if (stalled) bits.push(`fermo da ${fmtDur(s.at - j.changedAt)}`)
          // Con la barra, la riga grezza serve solo se dice qualcosa a parole (non il misuratore di curl o wget).
          const words = j.pct === null || /\p{L}{3}/u.test(j.text)
          const info = [words ? j.text : '', bits.join(' · ')].filter(Boolean)
            .map(t => (t.length > cols - 2 ? t.slice(0, cols - 3) + '…' : t))
          return (
            <Box key={j.id} flexDirection="column">
              <Text wrap="truncate">
                <Text color={icCol}>{icon + ' '}</Text>
                <Text bold={!j.done} dimColor={!!j.done}>{name}</Text>
                <Text dimColor>{' ' + dur}</Text>
              </Text>
              {j.pct !== null && !j.done && <Bar label="" p={j.pct} col="suggestion" right={`${String(Math.floor(j.pct)).padStart(3)}%`} />}
              {info.map((t, i) => <Text key={String(i)} dimColor wrap="truncate">{'  ' + t}</Text>)}
            </Box>
          )
        })}
        {J.length > shown.length && <Text dimColor>{`  +${J.length - shown.length} altri`}</Text>}
      </Box>
    )
  })
}
