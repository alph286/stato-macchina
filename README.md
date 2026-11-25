# stato-macchina

English | [Italiano](README.it.md)

A [Claude Code](https://claude.com/claude-code) mod that opens a panel with
the status of the machine Claude Code is running on: CPU, GPU, RAM, swap,
disk and temperature, and below them the progress of the jobs Claude runs in
the background (downloads, builds, agents). It refreshes every 2 seconds.

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

The panel's labels are in Italian (`Disco` = disk, `up 8g` = up 8 days,
`nessun throttling` = no throttling, `Lavori … in corso` = jobs … running,
`fermo da` = stalled for).

## Why it exists

I run Claude Code on a Raspberry Pi that works as a home server, and I
often reach it over SSH from a tablet or a phone. While Claude is working
(building, downloading, running scripts) I wanted to see at a glance
whether the machine is struggling: CPU maxed out, RAM full, disk full, high
temperature or the Pi throttling. Without opening a second session just to
run `htop`, and without switching windows, which is awkward on a small
screen.

So it had to:

- live inside Claude Code, next to the conversation;
- stay readable on a narrow terminal such as Termux on a phone: the bars
  fit the panel's width and lines never wrap;
- need nothing else installed: it reads `/proc`, `/sys` and `df`, and for
  the GPU it uses whatever it finds (`nvidia-smi` on PCs, `vcgencmd` on the
  Raspberry Pi).

## Install

In Claude Code:

```
/plugin install stato-macchina --marketplace alph286/stato-macchina
```

Answer `y` to add the marketplace, then pick the scope (for example user,
for all your projects).

Or from a shell:

```bash
claude plugin install stato-macchina --marketplace alph286/stato-macchina
```

## Usage

- On a terminal at least 144 columns wide the panel opens by itself,
  docked to the right of the conversation.
- On a narrower terminal (tablet, phone) open it with:

```
/stato
```

Machine bars turn yellow and red at fixed thresholds: RAM and disk at
80% and 90% (usual monitoring thresholds), temperature at 70 °C and 80 °C
(the Raspberry Pi firmware throttles from 80 °C), swap at 25% and 50%,
CPU and GPU at 65% and 85%. Context and usage-limit bars shift gradually
from green (0%) through yellow (50%) to red (100%). They are at
most 30 characters wide and shrink to fit narrower panels. The
temperature bar spans 0 to 100 °C and shows degrees instead of a
percentage.

## What it shows and where it reads it

| Item | Source |
| --- | --- |
| CPU usage, cores, load average | `/proc/stat`, `/proc/loadavg` |
| CPU sparkline: one bar per 2-second sample, as many as fit the bar width (up to 30, about the last minute) | `/proc/stat` |
| RAM and swap (swap only if the machine has some) | `/proc/meminfo` |
| Disk `/` | `df` |
| Temperature | `/sys/class/thermal/thermal_zone0/temp`; on a Raspberry Pi without it, `vcgencmd measure_temp` |
| GPU | `nvidia-smi` if present (usage bar, memory, temperature), otherwise `vcgencmd` (V3D clock, GPU memory) |
| Throttling | `vcgencmd get_throttled` (Raspberry Pi only) |
| Uptime | `/proc/uptime` |
| Model and cache (below the animated line) | the main conversation's last request: model, time left on the prompt cache (5m or 1h from the last request), share of input tokens read from cache. Before the first request it shows the `/model` model and `cache —` |
| Cost (`Costo`) | the session's cost in dollars, as `/cost` totals it (`$.session.usage().cost`), subagent and mod requests included. An estimate, not the bill: on a subscription it is not a charge. Starts over after `/clear` |
| Context (`Ctx`) | input tokens of the last response, as in the status line (`$.session.usage()`). The bar runs from 0 to 200k, the point where I `/clear` or `/compact` (or to the model's window if smaller); the right side shows tokens used, the line below the model's full window. Right after `/clear` or `/compact` it shows `—` until the next response. The threshold is `CTX_LIMIT` in `hooks/register.tsx` |
| Usage limits (`5h`, `7g`) | the subscription's 5-hour and 7-day windows, with time left until reset; hidden without a subscription or before the first response |
| Jobs (`Lavori`, below a second, blue animated line that moves only while a job runs) | see below |

### Background jobs

Each job has a line with its state (`●` running, `⚠` log idle for over a
minute, `✓` done, `✗` exited with an error) and how long it has run. Below
it: a bar when the log prints a percentage, and the log's last line or the
file's size and growth rate. A finished job stays for 2 minutes. Past 6
jobs, `+N altri` (N more) appears.

Where they come from:

- **Background Bash commands** (`run_in_background`, Ctrl+B, timeout) and
  **Monitor**: the session history (`$.session.messages`) gives the command's
  description and its task output file under
  `<tmp>/claude-<uid>/<project>/<session>/tasks/`. The exit status comes from
  the `[exited with code N]` line that file ends with. When the command sends
  everything to a log of its own (`cmd > x.log 2>&1`), the panel reads that log.
- **Safety net**: a growing `.output` file in that folder that the history has
  not named yet shows up anyway, as `comando <id>`.
- **Detached commands** (`nohup`, `setsid`, trailing `&`, `screen -dm`,
  `tmux new -d`): one row per command, following its log (`>`, `>>`, `tee`,
  `--log`, `wget -o`) or, when there is none, the downloaded file (`curl -o/-O`,
  `wget -O`: size and speed only). A `traccia` call in the same command does
  not hide the rest. Marked done when no process holds the file open any more (checked in
  `/proc` after 3 seconds without writes); dropped after 15 minutes without
  writes if that check is not possible.
- **`traccia`**: any other file, with `traccia <file> "description"` (and
  `traccia --fine <file>` when done). The script is in the mod's `bin/`, so it
  is on the `PATH` of Claude's commands; it writes to
  `~/.local/state/stato-macchina/traccia/<session>.tsv`.
- **Agents**: `$.agent.list()`, with their latest progress line.

The mod adds a short instruction to the system prompt telling Claude to use
`traccia` for logs the panel cannot see by itself, and to prefer flags that
print progress (`curl --progress-bar`, `wget --progress=dot:mega`,
`rsync --info=progress2`).

The percentage is read from `NN%` (curl `--progress-bar`, wget, rsync, pip,
git, apt), curl's default meter, tqdm (`45/100 [`), `3 of 12` / `3 di 12`
and rsync's `to-chk=`.

It works on Linux (WSL included). Items the machine does not have, for
example the GPU without `nvidia-smi` or `vcgencmd`, simply do not appear.

## Development

```bash
claude plugin validate .
claude plugin test .
```

The tests use simulated data and draw the panel at 34, 48 and 106 columns,
checking that no line is wider than the panel. The job tests
(`tests/lavori.test.tsx`) read progress from real curl, wget, rsync and git
output (`tests/campioni.ts`).

## License

MIT
