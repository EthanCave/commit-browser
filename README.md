<!--
   - This Source Code Form is subject to the terms of the Mozilla Public
   - License, v. 2.0. If a copy of the MPL was not distributed with this
   - file, You can obtain one at http://mozilla.org/MPL/2.0/.
   -->
<img src="./configs/branding/commit/commit-icon.svg" width="96" align="left">

### Commit

**A web browser that versions your tabs like code.**

Commit is a Firefox-based browser (a fork of [Zen](https://github.com/zen-browser/desktop)) where every space is a git repository. Commit a layout, branch it, check out yesterday, sync it to another computer, and drive the whole thing from a terminal-style console with pipes.

<br clear="left">

```
❯ ls -a | ai "school stuff" | mv School
ai kept 6 of 41 (on this Mac). Moved 6 tabs to School.

❯ checkout "when I was planning the Tokyo trip"
Found 3f2a91c (3 weeks ago): Planning Tokyo trip: flights and two hotels

❯ do dessert places near me that are open now
  searching: late night dessert Houston open now
  reading: https://…
- Sleek Creperie & Cafe (Uptown): open now, closes at 2 AM [1]
…
```

---

## Features

**Your tabs, in git**
- Every space has its own history: `status`, `diff`, `commit`, `log`, `branch`, `switch`, `checkout`, `stash`, `restore`.
- Essentials have their own history; a default branch per space.
- `push` / `pull` / `clone` sync every space and your Essentials through a GitHub repo, so a new computer gets your whole setup with one command.
- Time travel: an hourly snapshot of every space. `checkout yesterday`, `diff "last tuesday"`, `timeline`.
- Status dots on tabs show what changed since the last commit.

**A console (Ctrl+\`)**
- `cd github`, `open gh/owner/repo`, `g <search>`, `ls`, `pwd`: navigate by typing; `cd` remembers sites from your history.
- `grep <text>` searches the text of every open page; `blame` says where a tab came from; `cherry-pick` copies tabs from another branch, space or time.
- `share` / `import` a space as a secret gist or a code.
- `focus 25m` blocks distracting sites and keeps you in one space.
- `top`, `unload`, `gc`: memory and CPU by site, and putting background tabs to sleep.
- Pipes over tabs and history:
  `history week | grep -v youtube | ai "COMP 215" | open`
  Lists: `ls [-a]`, `history <when>` · filters: `grep`, `head`, `tail`, `sort`, `uniq`, `ai` · actions: `close`, `sleep`, `mv <space>`, `open`, `copy`, `wc`.

**Everyday browsing**
- Spotify and Apple Music (the Mac apps) in the sidebar media bar, plus `np`, `play <song>`, `pause`, `next`.
- Videos pop out into picture-in-picture when you switch tabs.
- Touch ID passkeys through the macOS keychain.
- uBlock Origin installed on first run; old tabs auto-archive.
- Cmd+T's "switch to tab" stays inside the current space.

**Optional AI** (bring your own keys; nothing is sent until you add one)
- `ai "<description>"` in a pipe filters by meaning **on your Mac** with EmbeddingGemma through [Ollama](https://ollama.com): free, private, ~20 ms per search. `ai!` asks Claude instead.
- `commit` with no message: Claude writes one from what changed.
- A catch-up card when you return to a space after time away.
- `tidy` proposes folders, moves and closes; nothing changes until `tidy apply`.
- `ask <question>` answers from the pages you have open, with citations.
- `do <task>` researches the web (with [Tavily](https://tavily.com) if you're signed in to its CLI) and reports back with sources, local time and open-now hours. It can only search and read.
- Claude Haiku handles the quick jobs and Sonnet the reading-heavy ones; typical use is a few dollars a month.

## Install

1. Download `Commit-<version>.dmg` from [Releases](../../releases) and drag Commit to Applications.
2. Commit isn't notarized by Apple yet, so macOS will refuse to open it the first time. Either:
   - open **System Settings → Privacy & Security**, scroll down and click **Open Anyway** next to Commit, or
   - run `xattr -dr com.apple.quarantine /Applications/Commit.app` in Terminal.

Requires an Apple Silicon Mac. Tested on macOS 26.

### Optional setup

| For | Do this (in the console, Ctrl+\`) |
|---|---|
| Syncing spaces between computers | `remote add origin <your GitHub repo URL>`, then `push`; on the other computer, `clone <url>` |
| Claude features | `ai key` (an [Anthropic API key](https://console.anthropic.com); kept in Commit's password store) |
| Local search | install [Ollama](https://ollama.com), then `ai local setup` (downloads EmbeddingGemma, 0.6 GB) |
| Web research with Tavily | `npm install -g @tavily/cli && tvly login` in Terminal |
| "Near me" in `do` | `ai location <city>` |

Type `help` in the console for everything, and `ai` to see what's set up.

### What leaves your computer

- Nothing AI-related until you add a key. Page text is sent to Claude only when you run `ask`; commit messages and catch-up send tab titles and URLs; `do` sends your task, plus searches to Tavily.
- `ai` filters and `checkout "<description>"` run locally when Ollama is installed.
- `push` sends your layouts (tab titles and URLs) to the GitHub repo you choose.

## Build from source

Commit builds like Zen (see [Zen's build docs](https://docs.zen-browser.app/building)). On a Mac with Xcode:

```bash
npm install
npm run init
npm run build
npm start
```

Tests for Commit's own code: `npm run test:commit`. Commit's features live in `src/zen/git`, `src/zen/ai`, `src/zen/media`, `src/zen/focus` and `src/zen/archive`.

## Credits and license

Commit is built on [Zen Browser](https://github.com/zen-browser/desktop) and [Mozilla Firefox](https://www.mozilla.org/firefox/), and is not affiliated with either. Developed with the help of Claude Code.

Licensed under the [Mozilla Public License 2.0](./LICENSE), like the projects it's built on.
