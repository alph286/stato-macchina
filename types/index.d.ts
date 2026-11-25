export type Snapshot = {
  host: string
  cpu: number
  cpuHist: number[]
  cores: number
  load: string
  memUsed: number
  memTotal: number
  swapUsed: number
  swapTotal: number
  diskUsed: number
  diskTotal: number
  tempC: number | null
  gpu: string | null
  gpuPct: number | null
  throttled: string | null
  uptime: string
  at: number
}

/** Ultima richiesta del thread principale: modello e uso della cache. */
export type Llm = {
  model: string
  at: number
  ttl: '5m' | '1h' | null
  input: number
  read: number
  write: number
}

/** Un lavoro in background seguito dal pannello: comando, agente o file di log. */
export type Job = {
  /** Chiave: id del task, `agent:<id>` o `file:<percorso>`. */
  id: string
  kind: 'bash' | 'agent' | 'monitor' | 'file'
  /** Descrizione leggibile (description del comando, dell'agente o di traccia). */
  name: string
  /** File letto per l'avanzamento, se c'è. */
  path: string | null
  pct: number | null
  text: string
  /** Byte del file e velocità di crescita (byte/s) all'ultimo giro. */
  size: number
  rate: number
  startedAt: number
  /** Ultima volta che il log è cambiato. */
  changedAt: number
  /** Finito: codice d'uscita (null se non noto) e quando. */
  done: { code: number | null; at: number } | null
}

declare module 'claude-code' {
  interface PluginState {
    'stato-macchina': {
      snap: Shaped<Snapshot | null>
      llm: Shaped<Llm | null>
      jobs: Shaped<Job[]>
    }
  }
}
