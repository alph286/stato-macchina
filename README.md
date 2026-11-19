# stato-macchina

Una mod per [Claude Code](https://claude.com/claude-code) che apre un pannello
con lo stato della macchina su cui gira Claude Code: CPU, GPU, RAM, swap,
disco e temperatura. Si aggiorna ogni 2 secondi.

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
(per l'utente, per tutti i progetti).

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

Le barre sono verdi fino al 65%, gialle fino all'85% e rosse oltre.

## Cosa mostra e da dove lo legge

| Voce | Fonte |
| --- | --- |
| CPU, core, load, mini-grafico degli ultimi 2 minuti | `/proc/stat`, `/proc/loadavg` |
| RAM e swap | `/proc/meminfo` |
| Disco `/` | `df` |
| Temperatura | `/sys/class/thermal/thermal_zone0/temp` (o `vcgencmd measure_temp`) |
| GPU | `nvidia-smi` se c'è (uso, memoria, temperatura), altrimenti `vcgencmd` (frequenza V3D, memoria GPU) |
| Throttling | `vcgencmd get_throttled` (solo Raspberry Pi) |
| Uptime | `/proc/uptime` |

Funziona su Linux (anche WSL). Le voci che la macchina non ha, per esempio
la GPU senza `nvidia-smi` né `vcgencmd`, semplicemente non compaiono.

## Sviluppo

```bash
claude plugin validate .
claude plugin test .
```

I test simulano i dati e disegnano il pannello a 34, 48 e 106 colonne,
controllando che nessuna riga superi la larghezza.

## Licenza

MIT
