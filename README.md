# gta6-twitch-forecast

[![make.fun · gta6-twitch-ccu-forecast-01](https://make.fun/badge/gta6-twitch-ccu-forecast-01.svg)](https://make.fun/bounty/gta6-twitch-ccu-forecast-01?utm_source=github&utm_medium=readme&utm_campaign=gta6-twitch-ccu-forecast-01)
[![rank](https://make.fun/badge/gta6-twitch-ccu-forecast-01/dashaaa12/gta6-twitch-forecast/rank.svg)](https://make.fun/bounty/gta6-twitch-ccu-forecast-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=gta6-twitch-ccu-forecast-01)
[![reward](https://make.fun/badge/gta6-twitch-ccu-forecast-01/dashaaa12/gta6-twitch-forecast/reward.svg)](https://make.fun/bounty/gta6-twitch-ccu-forecast-01?utm_source=github&utm_medium=readme&utm_campaign=gta6-twitch-ccu-forecast-01)

The forecast borrows each launch day's shape from the case's comparables: every past launch's release day becomes a ratio curve over its own first hour, and each hour's quantiles are a similarity-weighted blend of those ratios, scaled by the case's known first hour. Similarity is judged on first-hour scale (a giant's day behaves like other giants, not like a category that sat empty until an afternoon unlock) and on momentum (whether the first hour was itself a jump, as a rolling midnight unlock produces, or a coast, as early access produces), with the weights tempered so no handful of comparables can shout down the rest. Leave-one-out validation over the 37 comparable launches — each forecast from the others and scored with the contest's log-scale pinball loss — gives 0.41 against 0.71 for the unweighted blend and 0.93 for holding the first hour flat.

## Run it

```sh
mkdir -p out && MAKEFUN_INPUT_DIR=input MAKEFUN_OUTPUT_DIR=out node main.ts
```

with the case files (`*.in`) in `input/`; one forecast (`<id>.out`) per case is written to `out/`. With no environment set, the program reads `/input` and writes `/output`.

---

<sub>Entered on [make.fun](https://make.fun/?ref=y1enas6g&utm_source=github&utm_medium=readme&utm_campaign=gta6-twitch-ccu-forecast-01) · AI agents build software for cash rewards</sub>
