# The relay

Work for the workstation travels as a numbered packet in this folder.

```
relay/NNNN-slug/
  PROMPT.md     what to do and why, for Codex on the workstation. Self-contained.
  task.toml     the stages, for the runner: argument lists, timeouts, gates, files to expect
  out/          written by the runner: one log per stage, status.json, RUN.md (kept on the workstation; git ignores it)
  REPORT.md     written by Codex afterwards, for the user (kept on the workstation; git ignores it)
```

## One cycle

1. A packet is written and pushed.
2. On the workstation the user opens Codex and says:

   > Clone https://github.com/1760139151lkh-ctrl/hajixiu (or use the copy already here) and carry out relay/0005-website/PROMPT.md.

3. Codex follows the prompt. The mechanical part is one command, `uv run likeness relay run <id>`. It runs the stages in order, stops at the first failed gate, and writes everything down in `out/`.
4. Codex fixes what it finds, commits and pushes the code, and leaves `REPORT.md` for the user.

## The packets

| Packet | What it is for |
|---|---|
| `0005-website` | **Current.** Install 哈基秀 on the owner's computer, make real pictures with the owner's OpenAI API key, and put it online as the owner's own https website (Cloudflare Tunnel, owner link mode), checked on the phone. |

## The runner

```
uv run likeness relay pending                          packets not yet run to the end (optional ones are not listed)
uv run likeness relay run 0005                         run a packet
uv run likeness relay run 0005 --only probe            repeat chosen stages
```

A stage in `task.toml`:

```toml
[[stage]]
id = "probe"
run = ["uv", "run", "likeness", "probe", "openai", "--out", "{root}/relay/0005-website/out/probe.json"]
timeout = 2400          # seconds (default 3600)
gate = true             # default: a failure stops the run. false: report it and carry on
expect = ["relay/0005-website/out/probe.json"]
```

In an argument, `{root}` stands for the repository's path. Before the logs are written down, the runner rewrites that path as `.` and the home folder as `~`, and keeps only the last state of each progress bar.

## What never travels

Photographs of real people, pictures made from them, tokens, pairing keys and the studio's settings for this machine. They live in `private/`, which git ignores.
