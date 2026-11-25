// Lettura dell'avanzamento dai log e rilevamento dei file di log nei comandi.
// Funzioni pure: nessun accesso a $, così si provano da sole.

export type Progress = {
  /** Percentuale 0-100 trovata nell'ultima riga, o null. */
  pct: number | null
  /** Ultima riga leggibile del log (senza codici ANSI), già accorciata. */
  text: string
  /** Codice d'uscita se il log finisce con `[exited with code N]`. */
  exit: number | null
}

const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*(\x07|\x1b\\)|\x1b[()][A-Z0-9]/g

/** Legge la coda di un log e ne ricava percentuale, ultima riga ed eventuale esito. */
export function parseProgress(tail: string): Progress {
  const clean = tail.replace(ANSI, '').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '')
  let exit: number | null = null
  const ex = /\[exited with code (-?\d+)\]\s*$/.exec(clean)
  let body = clean
  if (ex) {
    exit = Number(ex[1])
    body = clean.slice(0, ex.index)
  }
  // Ogni \r riscrive la riga: conta solo l'ultimo pezzo di ciascuna riga.
  const lines = body
    .split('\n')
    .map(l => {
      const parts = l.split('\r').filter(p => p.trim() !== '')
      return (parts.at(-1) ?? '').trim()
    })
    .filter(l => l !== '')
  const last = lines.at(-1) ?? ''
  let pct: number | null = null
  // Cerca nell'ultima riga, poi nelle due precedenti (es. pip stampa la barra e poi una riga vuota di stato).
  for (const l of lines.slice(-3).reverse()) {
    pct = findPct(l)
    if (pct !== null) break
  }
  return { pct, text: last.replace(/\s+/g, ' ').slice(0, 200), exit }
}

function findPct(l: string): number | null {
  // NN% o NN.N% (curl, wget, rsync, pip, git, apt, docker…): l'ultima occorrenza valida.
  const all = [...l.matchAll(/(\d{1,3}(?:[.,]\d+)?)\s?%/g)]
  for (const m of all.reverse()) {
    const v = Number(m[1]!.replace(',', '.'))
    if (v >= 0 && v <= 100) return v
  }
  // Misuratore di default di curl, senza %: "  45 28.6M   45 12.9M    0     0  15.0M      0  0:00:01 …"
  const cu = /^(\d{1,3})\s+\d+(?:\.\d+)?[kMGTP]?\s+\d{1,3}\s+\d+(?:\.\d+)?[kMGTP]?\s+\d/.exec(l)
  if (cu && Number(cu[1]) <= 100) return Number(cu[1])
  // tqdm: " 45/100 [00:10<00:12"
  const tq = /(\d+)\/(\d+)\s*\[/.exec(l)
  if (tq) return frac(tq[1]!, tq[2]!)
  // "12 of 40", "file 3 di 10"
  const of = /\b(\d+)\s+(?:of|di)\s+(\d+)\b/i.exec(l)
  if (of) return frac(of[1]!, of[2]!)
  // rsync --info=progress2 senza % non esiste; "(xfr#3, to-chk=12/40)"
  const chk = /to-chk=(\d+)\/(\d+)/.exec(l)
  if (chk) return frac(String(Number(chk[2]) - Number(chk[1])), chk[2]!)
  return null
}

function frac(a: string, b: string): number | null {
  const x = Number(a), y = Number(b)
  return y > 0 && x >= 0 && x <= y ? (100 * x) / y : null
}

/** Il comando gira staccato dal turno (nohup, setsid, & finale, screen/tmux -d)? */
export function isDetached(cmd: string): boolean {
  return /(^|[;&|(]\s*)(nohup|setsid)\b/.test(cmd)
    || /(^|[^&])&\s*(disown\b.*)?$/.test(cmd.trim())
    || /\bscreen\s+-d?m/.test(cmd) || /\btmux\s+new(-session)?\b.*\s-d\b/.test(cmd)
}

/**
 * I file che il comando scrive: `logs` (redirezioni, tee, --log/--log-file,
 * -o/-a/--output-file di wget) e `downloads` (-o/-O/--output di curl,
 * -O/--output-document di wget, aria2c, yt-dlp). Percorsi assoluti, risolti
 * rispetto a `cwd` (e a un eventuale `cd X &&` iniziale). Le chiamate a
 * `traccia` si tolgono: registrano già i loro file.
 */
export function scanFiles(cmd: string, cwd: string, home: string): { logs: string[]; downloads: string[] } {
  cmd = cmd.replace(/(^|[;&|\n]\s*)(?:\S*\/)?traccia\b[^;&|\n]*/g, '$1')
  let base = cwd
  const cd = /^\s*cd\s+("[^"]+"|'[^']+'|[^\s;&|]+)\s*(&&|;)/.exec(cmd)
  if (cd) base = resolve(unq(cd[1]!), cwd, home) ?? cwd
  const tok = `("[^"]+"|'[^']+'|[^\\s;&|<>()]+)`
  const logPats = [
    new RegExp(`(?:^|[^<>&0-9])(?:[12]|&)?>>?\\s*${tok}`, 'g'), // > f, >> f, 2> f, &> f
    new RegExp(`\\btee\\s+(?:-a\\s+|--append\\s+)?${tok}`, 'g'),
    new RegExp(`\\s--?log(?:-?file)?(?:=|\\s+)${tok}`, 'g'),
  ]
  const dlPats: RegExp[] = []
  if (/\bwget\b/.test(cmd)) {
    logPats.push(new RegExp(`\\s(?:-o|-a|--output-file(?:=|\\s+)|--append-output(?:=|\\s+))\\s*${tok}`, 'g'))
    dlPats.push(new RegExp(`\\s(?:-O|--output-document(?:=|\\s+))\\s*${tok}`, 'g'))
  } else if (/\b(?:curl|aria2c|yt-dlp)\b/.test(cmd))
    dlPats.push(new RegExp(`\\s(?:-o|-O|--output(?:=|\\s+))\\s*${tok}`, 'g'))
  const seen: string[] = []
  const collect = (pats: RegExp[]) => {
    const found: string[] = []
    for (const re of pats)
      for (const m of cmd.matchAll(re)) {
        const raw = unq(m[1]!)
        if (/^&|^\/dev\/|^-$|[$*?`]/.test(raw) || raw === '') continue
        const p = resolve(raw, base, home)
        if (p && !seen.includes(p)) { seen.push(p); found.push(p) }
      }
    return found
  }
  const logs = collect(logPats)
  return { logs, downloads: collect(dlPats) }
}

/** Tutti i file del comando: prima i log, poi i file scaricati. */
export function detectFiles(cmd: string, cwd: string, home: string): string[] {
  const { logs, downloads } = scanFiles(cmd, cwd, home)
  return [...logs, ...downloads]
}

const unq = (s: string) => s.replace(/^(["'])(.*)\1$/, '$2')

function resolve(p: string, cwd: string, home: string): string | null {
  if (p.startsWith('~/')) p = home + p.slice(1)
  else if (p.startsWith('$HOME/')) p = home + p.slice(5)
  else if (!p.startsWith('/')) p = `${cwd.replace(/\/$/, '')}/${p}`
  const out: string[] = []
  for (const s of p.split('/')) {
    if (s === '' || s === '.') continue
    if (s === '..') out.pop()
    else out.push(s)
  }
  return '/' + out.join('/')
}

/** "Command running in background with ID: x. Output is being written to: /p/x.output" */
export function bgFromText(text: string): { id: string; path: string | null } | null {
  const id = /with ID:\s*([A-Za-z0-9_-]+)/.exec(text)?.[1]
  if (!id) return null
  const path = /written to:\s*(\S+?\.output)/.exec(text)?.[1] ?? null
  return { id, path }
}

// 1536 -> "1.5K", 3_400_000 -> "3.2M"
export const fmtB = (n: number) => {
  const u = ['B', 'K', 'M', 'G', 'T']
  let i = 0
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++ }
  return `${i === 0 ? n : n < 10 ? n.toFixed(1) : Math.round(n)}${u[i]}`
}
// Durata: "42s", "3m 10s", "1h 05m"
export const fmtDur = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`
}
