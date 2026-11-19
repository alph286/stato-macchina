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

declare module 'claude-code' {
  interface PluginState {
    'stato-macchina': { snap: Shaped<Snapshot | null> }
  }
}
