# stato-macchina

[English](README.md) | Italiano

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
──────────━━━━━━━◆─────────────────
opus-5-5  cache ● 47m/1h  hit 98%
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

Le barre sono verdi sotto il 65%, gialle dal 65% e rosse dall'85%. Sono
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
| Contesto (`Ctx`) | token in ingresso dell'ultima risposta, come nella status line (`$.session.usage()`). La barra va da 0 a 200k, la soglia a cui faccio `/clear` o `/compact` (o alla finestra del modello se è più piccola); a destra i token usati, sotto la finestra intera del modello. Subito dopo `/clear` o `/compact` mostra `—` fino alla risposta successiva. La soglia è `CTX_LIMIT` in `hooks/register.tsx` |
| Limiti d'uso (`5h`, `7g`) | le finestre di 5 ore e 7 giorni dell'abbonamento, con il tempo che manca al reset; non compaiono senza abbonamento o prima della prima risposta |

Funziona su Linux (anche WSL). Le voci che la macchina non ha, per esempio
la GPU senza `nvidia-smi` né `vcgencmd`, semplicemente non compaiono.

## Sviluppo

```bash
claude plugin validate .
claude plugin test .
```

I test simulano i dati e disegnano il pannello a 34, 48 e 106 colonne,
controllando che nessuna riga superi la larghezza del pannello.

## Licenza

MIT
