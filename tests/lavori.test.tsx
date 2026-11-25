import { expect, test } from 'claude-code/testing'

import { bgFromText, detectFiles, isDetached, openPaths, parseProgress, scanFiles } from '../hooks/lavori'
import { CAMPIONI } from './campioni'

// Percentuale attesa da ogni campione reale (null = nessuna percentuale da trovare).
const ATTESI: Record<string, number | null> = {
  'curl-meta': 45,
  'curl-fine': 100,
  'curlbar-fine': 100,
  'rsync-fine': 100,
  'git-meta': 53,
  'git-fine': 100,
  'wget-meta': 44,
  'wget-fine': 100,
  'wgetdot-fine': 100,
}
for (const [nome, pct] of Object.entries(ATTESI)) {
  test(`avanzamento da ${nome}`, () => {
    const p = parseProgress(CAMPIONI[nome]!)
    expect(p.pct === null ? null : Math.floor(p.pct)).toBe(pct)
    expect(p.text.length > 0).toBe(true)
  })
}

test('altri formati: tqdm, pip, apt, "x of y", rsync to-chk, ffmpeg', () => {
  expect(parseProgress(' 45%|████▌     | 45/100 [00:10<00:12, 4.50it/s]').pct).toBe(45)
  expect(parseProgress('train:  12/48 [00:03<00:09]').pct).toBe(25)
  expect(parseProgress('   ━━━━━━━━━━╸━━━━━━━━━━ 61.2/120.4 MB 3.1 MB/s eta 0:00:20').pct).toBe(null)
  expect(parseProgress('Progress: [ 37%] [#########.................]').pct).toBe(37)
  expect(parseProgress('Downloading file 3 of 12').pct).toBe(25)
  expect(parseProgress('  1,234,567  12%  1.2MB/s  0:00:10 (xfr#3, to-chk=30/40)').pct).toBe(12)
  const ff = parseProgress('frame=  240 fps= 30 q=28.0 size=  1024kB time=00:00:08.00 bitrate=1048.6kbits/s speed=1.0x')
  expect(ff.pct).toBe(null)
  expect(ff.text).toMatch(/time=00:00:08/)
})

test('esito, \\r e codici ANSI', () => {
  const p = parseProgress('\x1b[32m 10%\x1b[0m\r 50%\r 90%\nfine\n\n[exited with code 0]\n')
  expect(p.exit).toBe(0)
  expect(p.text).toBe('fine')
  expect(p.pct).toBe(90)
  expect(parseProgress('boom\n[exited with code 127]\n').exit).toBe(127)
  expect(parseProgress('\n[killed]\n').exit).toBe(137)
  expect(parseProgress('\r33%\r66%').text).toBe('66%')
})

test('comandi staccati', () => {
  expect(isDetached('nohup ./train.sh > train.log 2>&1 &')).toBe(true)
  expect(isDetached('setsid make > b.log')).toBe(true)
  expect(isDetached('./x.sh > log &')).toBe(true)
  expect(isDetached('tmux new -s a -d "make"')).toBe(true)
  expect(isDetached('make && make test')).toBe(false)
  expect(isDetached('ls > out.txt')).toBe(false)
})

test('file aperti dai processi', () => {
  const s = openPaths('/dev/null\n/home/a/train.log\npipe:[123]\nsocket:[9]\n/tmp/x.log (deleted)\n\n')
  expect([...s].sort()).toEqual(['/dev/null', '/home/a/train.log'])
})

test('file di log e download nel comando', () => {
  const home = '/home/u', cwd = '/p'
  expect(detectFiles('nohup ./t.sh > t.log 2>&1 &', cwd, home)).toEqual(['/p/t.log'])
  expect(detectFiles('make 2>&1 | tee -a ~/b.log', cwd, home)).toEqual(['/home/u/b.log'])
  expect(detectFiles('cd /data && wget -O img.iso https://x/y.iso -o wget.log', cwd, home)).toEqual(['/data/wget.log', '/data/img.iso'])
  // traccia nello stesso comando: si ignorano solo i suoi argomenti
  expect(detectFiles('nohup wget -O a.dat https://x/a > w.log 2>&1 &\n~/bin/traccia /p/x.txt "desc" > /dev/null', cwd, home)).toEqual(['/p/w.log', '/p/a.dat'])
  expect(detectFiles('traccia out.log "prova"', cwd, home)).toEqual([])
  // log e file scaricati separati: il log di wget (-o) non è un download, quello di curl (-o) sì
  expect(scanFiles('nohup wget -O a.dat https://x/a > w.log 2>&1 &', cwd, home)).toEqual({ logs: ['/p/w.log'], downloads: ['/p/a.dat'] })
  expect(scanFiles('wget -o w.log https://x/a', cwd, home)).toEqual({ logs: ['/p/w.log'], downloads: [] })
  expect(scanFiles('curl -L -o b.iso https://x/b', cwd, home)).toEqual({ logs: [], downloads: ['/p/b.iso'] })
  // variabili assegnate nel comando e cd in mezzo
  expect(scanFiles('S=/t/prova; cd $S && rm -f *.dat && nohup wget -O w.dat https://x > w.log 2>&1 &\nS=/q; ./x.sh > ${S}/b.log', cwd, home))
    .toEqual({ logs: ['/t/prova/w.log', '/q/b.log'], downloads: ['/t/prova/w.dat'] })
  expect(detectFiles('make > a.log; cd sub && make > b.log', cwd, home)).toEqual(['/p/a.log', '/p/sub/b.log'])
  expect(detectFiles('cmd > $UNKNOWN/x.log', cwd, home)).toEqual([])
  expect(detectFiles('curl -L --output "/tmp/a b.bin" https://x', cwd, home)).toEqual(['/tmp/a b.bin'])
  expect(detectFiles('python train.py --log-file=runs/r1.log', cwd, home)).toEqual(['/p/runs/r1.log'])
  expect(detectFiles('cmd > /dev/null 2>&1', cwd, home)).toEqual([])
  expect(detectFiles('echo $X > "$F"', cwd, home)).toEqual([])
  expect(detectFiles('a >> ../log/x.log', cwd, home)).toEqual(['/log/x.log'])
})

test('id e percorso dal risultato di un comando in background', () => {
  expect(bgFromText('Command running in background with ID: be7d4hv93. Output is being written to: /tmp/claude-1000/p/s/tasks/be7d4hv93.output. You will be notified')).toEqual({
    id: 'be7d4hv93', path: '/tmp/claude-1000/p/s/tasks/be7d4hv93.output',
  })
  expect(bgFromText('ok')).toBe(null)
})
