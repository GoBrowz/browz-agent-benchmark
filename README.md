# Browz agent benchmark

The same Claude agent, with the same prompt, does the same 50 public web tasks twice: once through the
[Browz](https://gobrowz.com) MCP server and once through a plain browser MCP. We score each run from the answer the
agent gives, checked against a fixed expected value. This kit holds everything behind
[gobrowz.com/agent-benchmark](https://gobrowz.com/agent-benchmark): the task list, the exact prompts, the runner for
both setups, the scorer and the raw logs of the run we published, so you can check our numbers and record your own.

## Our published run (2 Nov 2026)

| | Browz MCP | Plain browser MCP |
|---|---:|---:|
| Tasks succeeded | 46/50 (92%) | 38/50 (76%) |
| …on open sites | 32/32 | 29/32 |
| …on bot-protected sites | 14/18 | 9/18 |
| Runs blocked or challenged out | 3 (6%) | 12 (24%) |
| Median steps (tool calls) | 3 | 3 |
| Median time per task | 22.7 s | 23.3 s |

Check it from the raw logs in this kit, with no browser and no account:

```sh
node score.mjs results/2026-11-02
```

It re-scores every run record in `results/2026-11-02/runs/` and prints the score table and a per-site table.

## Run it yourself (one command)

```sh
ANTHROPIC_API_KEY=<your key> ./run.sh /Applications/Browz.app
```

That runs both setups on all 50 tasks (one lane each, side by side; about 30 minutes in our run), writes the run to
`runs/<date>/` and prints the score. Options go after the run folder, for example a three-task trial:

```sh
ANTHROPIC_API_KEY=<your key> ./run.sh /Applications/Browz.app runs/trial --tasks wiki-tungsten,arxiv-attention,mdn-teapot
node bench.mjs --browz /Applications/Browz.app --out runs/x --dry-run    # prints the settings and prompts, runs nothing
```

A stopped run resumes where it stopped: run the same command again. Every option is listed at the top of `bench.mjs`.

### What you need

- **Node.js 22 or later** (`npx` comes with it).
- **Claude Code** (`npm install -g @anthropic-ai/claude-code`). Our run used Claude Code 2.1.316.
- **Your own Claude credential** in the environment: `ANTHROPIC_API_KEY`, or `CLAUDE_CODE_OAUTH_TOKEN` from
  `claude setup-token`. It is passed to `claude` through the environment only and never written to disk. A full run
  used about US$6 of API usage in our run (both setups).
- **Browz** ([download](https://gobrowz.com/download)), free plan is enough. Pass the app (`Browz.app` on macOS),
  the install folder on Windows, or the extracted AppImage on Linux. The kit starts Browz's own `browz-agent` and
  `browz-mcp` from it with a **new, empty data folder** (`BROWZ_KEYSTORE=off`, a random port), so your own profiles stay
  untouched. On macOS the engine is inside the app. On Windows and Linux the installer carries the engine
  as a signed package that Browz unpacks on its first start, so start Browz once and pass `--engine <path to the
  unpacked engine>` if the runner cannot find it. We have run the kit on macOS.
- **Google Chrome**, for the plain browser setup.

## Method

- **Tasks:** `tasks.json`, 50 fixed, read-only public tasks in the style of WebVoyager: Wikipedia, arXiv, GitHub, MDN,
  package registries and documentation (32 tasks on open sites), and search engines, shops, travel, property, recipes,
  jobs, news and sport (18 tasks on sites known to run bot protection). No task signs in, signs up, buys or submits a
  form other than a site search.
- **Setups:** *Browz MCP*: the `browz-mcp` server, with a fresh ephemeral Browz session per task, headless.
  *Plain browser MCP*: the open-source Playwright MCP server (`@playwright/mcp@0.0.84`, `--headless --isolated
  --browser chrome`), a fresh isolated browser context per task. Each run has only its own setup's MCP server connected.
- **Agent:** Claude Code in print mode (`claude -p`), model `sonnet`, at most 30 turns and 300 s per task,
  `--strict-mcp-config`, only the setup's MCP tools allowed, every built-in tool that reaches the web or the disk
  disallowed (`Bash`, `WebFetch`, `WebSearch`, `Read`, `Write` and the rest: `DISALLOWED` in `bench.mjs`), no
  session persistence, project settings only.
- **Prompt:** `prompt()` in `bench.mjs`. Both setups get the same task text and rules; only the first two lines, which
  name the setup's tools, differ. The agent must end with `ANSWER: …` and `BLOCKED: yes|no`.
- **Scoring:** `scorer.mjs`. A task succeeds when the answer passes the task's check (exact, one of, pattern, number
  range, price or non-empty text), the browser actually visited the task's site, the agent did not report a block and
  the run did not time out. A run counts as *blocked* when the agent reports a block page, CAPTCHA or bot check, or when
  a block-page signature appears in what the browser showed and the answer is wrong. Steps are tool calls; tokens and
  cost are what Claude Code reports for the run.
- **Harness failures** (a browser or `claude` that did not start, a usage limit) are not task results: they are kept
  under `<run>/errors/` and retried on the next run.
- **Recorded per task:** `runs/<setup>/<task>.json`: every tool call with its input and the first 4,000 characters of
  its result, the agent's final text, turns, tokens, cost and wall time, and the score.

## Variance

**One run, one network, one day.** Our numbers are one run of each setup, on one Mac on a residential connection in
Australia, on 2 Nov 2026. Sites change, and bot protection varies with the IP address, its reputation, the time of day
and the site's own settings, so your run will differ. Treat any single run, ours included, as a measurement of that
run.

What moved the result in our run, and is most likely to move in yours:

- Tasks that ended on a block page or bot check (in our run: Reddit, Etsy and Indeed in both setups; npm, DuckDuckGo,
  Google, IMDb, Zillow, Walmart and Allrecipes in one). These depend most on your network.
- Tasks whose answer changes over time (a news headline, prices, listings) are checked loosely (a price, non-empty
  text); tasks with a fixed answer (a year, a symbol, a licence) are checked exactly.
- Model behaviour: the same prompt can take a different path on a different day, especially on long tasks
  (the longest run in ours took 39 steps).

Our published run used `browz-mcp` and the Browz engine (Chromium 156) built from our source on 2 Nov 2026; the kit runs
the same MCP server from an installed Browz app.

## Check a run folder before you share it

```sh
node redact.mjs runs/<date> --check     # scan only
node redact.mjs runs/<date>             # redact in place, then scan
```

The runner already passes every record through `redact.mjs` before writing it. It removes API keys and bearer tokens,
OAuth client ids in URLs, email addresses, home and temp folder paths, this machine's host and user names, and private
and public IP addresses. The published logs went through the same redaction; one more change was made to them: an open
model's name in one Hugging Face listing, which is also another browser's product name, is shown as `<name>`.

## Submit a result

Open an issue with the **Benchmark result** template in this repository and attach your run folder as a .zip
(`meta.json`, `summary.json`, `scores.json`, `runs/`). The template asks for the date, your network (region and kind,
never an IP address), OS, versions, model and settings, the score table and any change to the method. We list every
submitted result that comes with its run folder, whatever it shows.

## Files

| | |
|---|---|
| `run.sh` | one command: run, then score |
| `bench.mjs` | the runner for both setups |
| `score.mjs` | re-scores a run folder and prints the tables |
| `scorer.mjs` | the scoring rules (pure functions) |
| `redact.mjs` | redaction and the leak scan |
| `tasks.json` | the 50 tasks and their checks |
| `results/2026-11-02/` | our published run: `meta.json`, `summary.json`, `scores.json`, `runs/` |
| `test/` | `npm test`: the kit's own tests, with a stub in place of Claude |

## License

MIT, see [LICENSE](LICENSE). Copyright (c) 2026 Covenant Alpha Pty Ltd.
