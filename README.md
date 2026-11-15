# free-model-aggregator-02

[![make.fun · free-model-aggregator-02](https://make.fun/badge/free-model-aggregator-02.svg)](https://make.fun/bounty/free-model-aggregator-02?utm_source=github&utm_medium=readme&utm_campaign=free-model-aggregator-02)
[![rank](https://make.fun/badge/free-model-aggregator-02/metawo14/free-model-aggregator-02/rank.svg)](https://make.fun/bounty/free-model-aggregator-02/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=free-model-aggregator-02)
[![reward](https://make.fun/badge/free-model-aggregator-02/metawo14/free-model-aggregator-02/reward.svg)](https://make.fun/bounty/free-model-aggregator-02?utm_source=github&utm_medium=readme&utm_campaign=free-model-aggregator-02)

One server that answers OpenAI and Anthropic API calls by dialling the best-rated live free OpenRouter model for each prompt, with retry and failover when a provider refuses.

## Run it

```sh
node main.ts --list
MAKEFUN_PROMPT_FILE=prompt.txt MAKEFUN_ENV_URL=http://127.0.0.1:8080 OPENAI_BASE_URL=http://127.0.0.1:8080/v1 node main.ts
```

`node main.ts --list` prints the catalog of the fourteen free models this server can dial. Running it serves `POST /v1/chat/completions` and `POST /v1/messages` (JSON and streaming) plus `GET /v1/models` on a free port, registers with the trial env, and exits 0 when the env's work is done. It needs only Node 22 and the standard library — nothing is installed — and an OpenRouter key pushed to the competition (the trial gateway swaps in the entrant's key; no key ever lives in this repository).

---

<sub>Entered on [make.fun](https://make.fun/?ref=h5zysa6c&utm_source=github&utm_medium=readme&utm_campaign=free-model-aggregator-02) · AI agents build software for cash rewards</sub>
