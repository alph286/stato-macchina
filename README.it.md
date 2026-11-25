# stato-macchina

[English](README.md) | Italiano

Una mod per [Claude Code](https://claude.com/claude-code) che apre un pannello
con lo stato della macchina su cui gira Claude Code: CPU, GPU, RAM, swap,
disco e temperatura, e sotto l'avanzamento dei lavori che Claude lancia in
background (download, compilazioni, agenti). Si aggiorna ogni 2 secondi.

```
raspberrypi  up 8g 6h 29m
CPU   ███░░░░░░░░░░░░░░░░░░░░░░░░░  15%
      4 core · load 1.83 1.19 0.68
      ▁▂▁▃▂▁▁▂▅▃▂▁
RAM   ███████████████░░░░░░░░░░░░░  52%
      2.0/3.7 GiB
Swap  ██░░░░░░░░░░░░░░░░░░░░░░░░░░   5%
      0.1/2.0 GiB
Disco ████████████████░░░░░░░░░░░░  56%
      / 14.9/27.9 GiB
GPU   V3D 500 MHz · mem 76M
Temp  █████████████████░░░░░░░░░░░ 62°C
      ✓ nessun throttling
──────────━━━━━━━◆─────────────────
opus-5-5  cache ● 47m/1h  hit 98%
...
─────────────━━━━━━━◆──────────────
Lavori  2 in corso
● Scarica modello Wan 14B   1m 10s
      ████████████░░░░░░░░░░░  54%
  8.0M/s
⚠ build lab                 6m 40s
  Compiling foo v0.1
  39K · fermo da 3m 00s
✓ pip install torch            42s
```

## Perché nasce

Uso Claude Code su un Raspberry Pi che fa da server di casa, e spesso lo
apro via SSH dal tablet o dal telefono. Mentre Claude lavora (compila,
scarica, lancia script) volevo vedere a colpo d'occhio se la macchina sta
soffrendo: CPU al massimo, RAM finita, disco pieno, temperatura alta o
throttling del Pi. Senza aprire un'altra sessione per lanciare `htop`, e
senza cambiare finestra, cosa scomoda su uno schermo piccolo.

Doveva quindi:

- stare dentro Claude Code, accanto alla conversazione;
- leggersi bene anche su un terminale stretto come Termux sul telefono:
  le barre si adattano alla larghezza del pannello e le righe non vanno
  mai a capo;
- non richiedere nient'altro da installare: legge `/proc`, `/sys` e `df`,
  e per la GPU usa quello che trova (`nvidia-smi` sui PC, `vcgencmd` sul
  Raspberry Pi).

## Installazione

In Claude Code:

```
/plugin install stato-macchina --marketplace alph286/stato-macchina
```

Conferma con `y` l'aggiunta del marketplace, poi scegli dove installarla
(per esempio per l'utente, valida in tutti i progetti).

Oppure da terminale:

```bash
claude plugin install stato-macchina --marketplace alph286/stato-macchina
```

## Uso

- Su un terminale largo almeno 144 colonne il pannello si apre da solo,
  agganciato a destra della conversazione.
- Su un terminale più stretto (tablet, telefono) aprilo con:

```
/stato
```

Le barre della macchina diventano gialle e rosse a soglie fisse: RAM e
disco a 80% e 90% (le soglie abituali di monitoraggio), temperatura a
70 °C e 80 °C (da 80 °C il firmware del Raspberry Pi rallenta la CPU),
swap a 25% e 50%, CPU e GPU a 65% e 85%. Le barre del contesto e dei
limiti d'uso sfumano dal verde (0%) al giallo (50%) al rosso (100%). Sono
larghe al massimo 30 caratteri e si accorciano nei pannelli più stretti.
La barra della temperatura va da 0 a 100 °C e mostra i gradi invece della
percentuale.

## Cosa mostra e da dove lo legge

| Voce | Fonte |
| --- | --- |
| Uso della CPU, core, load | `/proc/stat`, `/proc/loadavg` |
| Mini-grafico della CPU: una tacca per lettura (ogni 2 secondi), tante quante ne entrano nella barra (fino a 30, circa l'ultimo minuto) | `/proc/stat` |
| RAM e swap (lo swap solo se la macchina ne ha) | `/proc/meminfo` |
| Disco `/` | `df` |
| Temperatura | `/sys/class/thermal/thermal_zone0/temp`; su un Raspberry Pi che non l'ha, `vcgencmd measure_temp` |
| GPU | `nvidia-smi` se c'è (barra d'uso, memoria, temperatura), altrimenti `vcgencmd` (frequenza V3D, memoria GPU) |
| Throttling | `vcgencmd get_throttled` (solo Raspberry Pi) |
| Uptime | `/proc/uptime` |
| Modello e cache (sotto la riga animata) | l'ultima richiesta della conversazione principale: modello, tempo che resta alla cache del prompt (5m o 1h dall'ultima richiesta), quota di token in ingresso letti dalla cache. Prima della prima richiesta mostra il modello di `/model` e `cache —` |
| Costo (`Costo`) | il costo della sessione in dollari, come lo totalizza `/cost` (`$.session.usage().cost`), richieste dei subagenti e delle mod comprese. È una stima, non la bolletta: con l'abbonamento non è un addebito. Riparte da zero con `/clear` |
| Contesto (`Ctx`) | token in ingresso dell'ultima risposta, come nella status line (`$.session.usage()`). La barra va da 0 a 200k, la soglia a cui faccio `/clear` o `/compact` (o alla finestra del modello se è più piccola); a destra i token usati, sotto la finestra intera del modello. Subito dopo `/clear` o `/compact` mostra `—` fino alla risposta successiva. La soglia è `CTX_LIMIT` in `hooks/register.tsx` |
| Limiti d'uso (`5h`, `7g`) | le finestre di 5 ore e 7 giorni dell'abbonamento, con il tempo che manca al reset; non compaiono senza abbonamento o prima della prima risposta |
| Lavori (sotto la seconda riga animata, azzurra, che si muove solo mentre un lavoro è in corso) | vedi sotto |

### Lavori in background

Ogni lavoro ha una riga con lo stato (`●` in corso, `⚠` log fermo da più di
un minuto, `✓` finito, `✗` uscito con errore) e la durata. Sotto ci sono la
barra, se il log stampa una percentuale, e l'ultima riga del log oppure la
dimensione del file e la velocità con cui cresce. Un lavoro finito resta
visibile 2 minuti. Se i lavori sono più di 6, compare `+N altri`.

Da dove vengono:

- **Comandi Bash in background** (`run_in_background`, Ctrl+B, timeout) e
  **Monitor**: dalla cronologia della sessione (`$.session.messages`), che
  dà la descrizione del comando e il file di output del task in
  `<tmp>/claude-<uid>/<progetto>/<sessione>/tasks/`. L'esito viene dalla riga
  `[exited with code N]` con cui finisce quel file. Se il comando manda tutto
  in un suo log (`cmd > x.log 2>&1`), il pannello legge quel log.
- **Rete di sicurezza**: un file `.output` di quella cartella che cresce e che
  la cronologia non ha ancora nominato compare comunque, come `comando <id>`.
- **Comandi staccati** (`nohup`, `setsid`, `&` finale, `screen -dm`,
  `tmux new -d`): una riga per comando, che segue il log (`>`, `>>`, `tee`,
  `--log`, `wget -o`) o, se non c'è, il file scaricato (`curl -o/-O`,
  `wget -O`: solo dimensione e velocità). Le chiamate a `traccia` nello stesso
  comando non nascondono il resto. Finisce quando nessun processo tiene più aperto il file (controllato in
  `/proc` dopo 3 secondi senza scritture); sparisce dopo 15 minuti senza
  scritture se non si può controllare.
- **`traccia`**: ogni altro file, con `traccia <file> "descrizione"` (e
  `traccia --fine <file>` alla fine). Lo script è in `bin/` della mod, quindi
  è nel `PATH` dei comandi di Claude; scrive in
  `~/.local/state/stato-macchina/traccia/<sessione>.tsv`.
- **Agenti**: `$.agent.list()`, con la loro ultima frase di avanzamento.

La mod aggiunge al prompt di sistema una breve istruzione che dice a Claude
di usare `traccia` per i log che il pannello non vede da solo e di preferire
opzioni che stampano l'avanzamento (`curl --progress-bar`,
`wget --progress=dot:mega`, `rsync --info=progress2`).

La percentuale si legge da `NN%` (curl `--progress-bar`, wget, rsync, pip,
git, apt), dal misuratore di default di curl, da tqdm (`45/100 [`), da
`3 of 12` / `3 di 12` e da `to-chk=` di rsync.

Funziona su Linux (anche WSL). Le voci che la macchina non ha, per esempio
la GPU senza `nvidia-smi` né `vcgencmd`, semplicemente non compaiono.

## Sviluppo

```bash
claude plugin validate .
claude plugin test .
```

I test simulano i dati e disegnano il pannello a 34, 48 e 106 colonne,
controllando che nessuna riga superi la larghezza del pannello. I test dei
lavori (`tests/lavori.test.tsx`) leggono l'avanzamento da output veri di curl,
wget, rsync e git (`tests/campioni.ts`).

## Licenza

MIT
