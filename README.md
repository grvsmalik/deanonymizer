# deanonymizer

deanonymizer is a command-line system for defensive OSINT exposure
measurement. It estimates re-identification risk from public Reddit and Hacker
News corpora (now supports web, GitHub & StackOverflow too!) by aggregating weak signals, scoring identity hypotheses, and
emitting evidence-linked remediation guidance.

## Research basis

The design follows the inference setting discussed in:

- [arXiv:2602.16800](https://arxiv.org/abs/2602.16800)

Operational premise: low-entropy disclosures that appear non-identifying in
isolation may become identifying under cross-post and cross-platform fusion.

## Formal objective

Given a subject handle set H and public artifact set D, produce a risk report R
containing:

- identity-relevant feature extractions
- evidence-backed linkage claims
- calibrated confidence labels
- prioritized mitigation actions

## Threat model

- Observer model: passive adversary with access to publicly available text and
  metadata only
- Data boundary: no private APIs, credentialed access, or hidden datasets
- Attack primitive: probabilistic entity linkage via feature composition
- Security goal: minimize attributable identity surface from public traces

## Pipeline

1. Acquisition
   - Reddit artifacts from [Arctic Shift API](https://arctic-shift.photon-reddit.com)
   - Hacker News artifacts from [HN Algolia Search API](https://hn.algolia.com/api)
   - GitHub profile fields + public events (commits, issues, PRs, review
     comments) via the [GitHub REST API](https://docs.github.com/en/rest);
     commit author name and email from `PushEvent` payloads are folded in
     inline. Optional `GITHUB_TOKEN` raises the rate limit.
   - Stack Overflow answers, questions, comments, and profile fields via
     the [Stack Exchange API v2.3](https://api.stackexchange.com)
   - Shallow link-follower for any external website declared in a GitHub
     or Stack Overflow profile: fetches the root page, then up to 5
     same-origin sub-paths prioritized by identity-shaped routes
     (`/about`, `/cv`, `/resume`, `/contact`, `/bio`, `/me`,
     `/portfolio`, …). Preserves `mailto:` and `http(s)://` href values
     before HTML stripping so contact emails behind a link survive.
2. Canonicalization
   - Heterogeneous source records mapped into a unified item schema
   - Temporal and textual normalization for bounded-context inference
3. Feature extraction and attribution
   - LLM pass: detection of location, affiliation, temporal routine,
     self-disclosed demographics, cross-platform handles, external URLs,
     and stylometric cues, with attribution binding from each claim to
     quote-level evidence and permalink
   - Deterministic regex pass that runs in parallel and bypasses the
     model: extracts emails (with `[at]` / `[dot]` obfuscation handling)
     and cross-platform social handles for LinkedIn, Twitter/X, GitHub,
     YouTube, Instagram, Bluesky, Reddit, Hacker News, Telegram, GitLab,
     Stack Overflow, and Mastodon from URL patterns in the corpus.
     False-positive paths like `twitter.com/home` are filtered and the
     audited account itself is excluded.
4. Risk synthesis
   - Confidence-calibrated findings: low, medium, high
   - Explicit exact-user section and public proof URL set
   - Direct-identifier block (emails + discovered handles) rendered
     before the LLM findings, so concrete leaks always appear regardless
     of how the model chose to summarize them
   - Finding-level remediation recommendations

## Output properties

- Human-readable report with ranked findings and rationale, grouped by
  confidence (high → medium → low)
- Dedicated `direct identifiers extracted` block surfacing emails and
  cross-platform handles found by the deterministic regex pass
- JSON serialization for longitudinal tracking and downstream analytics;
  `AuditResult.directIdentifiers` exposes the raw email + social handle
  hits alongside the model findings
- Optional strict validation: fail if no external proof URL exists beyond
  audited platform profile endpoints

## Installation

```bash
npm install
```

### LLM backend

The analysis stage runs on any of three interchangeable backends, selected
automatically from the environment (override with `--provider`):

**Anthropic (native, default when only this key is set)**

```bash
export ANTHROPIC_API_KEY=sk-ant-...
# default model is the fast claude-haiku-4-5
# optional: export ANTHROPIC_MODEL=claude-sonnet-4-6  # slower, higher quality
```

**Any OpenAI-compatible endpoint** — OpenAI, Google Gemini, Ollama, Groq,
Together, etc. Point `OPENAI_BASE_URL` at the provider's Chat Completions
surface:

```bash
# OpenAI
export OPENAI_API_KEY=sk-...
export OPENAI_MODEL=gpt-4o-mini

# Google Gemini (OpenAI-compatible endpoint)
export OPENAI_API_KEY=...your-gemini-key...
export OPENAI_BASE_URL=https://generativelanguage.googleapis.com/v1beta/openai/
export OPENAI_MODEL=gemini-2.0-flash

# Ollama (local, no key required)
export OPENAI_BASE_URL=http://localhost:11434/v1
export OPENAI_MODEL=llama3
```

**Claude Code CLI (no API key)** — routes the analysis through your existing
[Claude Code](https://claude.com/claude-code) session by shelling out to
`claude -p`, so no `ANTHROPIC_API_KEY` is needed. Select it explicitly:

```bash
npm run audit -- my_reddit_handle --provider claude-code
# optional: pin the model or point at a non-default CLI binary
export CLAUDE_CODE_MODEL=claude-sonnet-4-6
export CLAUDE_CODE_BIN=/path/to/claude
```

Tradeoffs vs. the native Anthropic SDK path: no prompt caching, no `max_tokens`
control, and slower per-call startup (CLI cold start), so it is opt-in rather
than auto-detected. The JSON-repair fallback covers the lack of a
`response_format: json_object` equivalent.

Selection order: `--provider` flag → `LLM_PROVIDER` env → auto-detect
(`OPENAI_*` / `--base-url` → openai; `ANTHROPIC_API_KEY` → anthropic).
`claude-code` is never auto-detected — request it via `--provider claude-code`
or `LLM_PROVIDER=claude-code`. Existing Anthropic-only setups keep working
unchanged. Native Anthropic prompt caching is preserved on the Anthropic path;
the OpenAI path requests `response_format: json_object` where supported and
still runs the JSON-repair fallback for endpoints that ignore it.

## Usage

```bash
# Reddit only
npm run audit -- my_reddit_handle

# Reddit + Hacker News
npm run audit -- my_reddit_handle --hn my_hn_handle

# Hacker News only
npm run audit -- --hn my_hn_handle

# GitHub only (also follows the linked website + sub-pages)
npm run audit -- --github my_gh_handle

# Stack Overflow only (accepts numeric user_id or profile URL)
npm run audit -- --so 1234567

# All four platforms at once — cross-platform handle correlation is the
# strongest signal the analyzer can flag
npm run audit -- my_reddit_handle --hn my_hn_handle --github my_gh_handle --so 1234567

# Audit through the Claude Code CLI (no API key needed)
npm run audit -- my_reddit_handle --provider claude-code

# JSON output
npm run audit -- my_reddit_handle --json -o report.json

# Strict proof validation
npm run audit -- my_reddit_handle --require-external-proof

# Faster wall-clock analysis (parallel chunk workers)
npm run audit -- my_reddit_handle --concurrency 3

# Run against a local Ollama model
npm run audit -- my_reddit_handle --base-url http://localhost:11434/v1 --model llama3

# Force a specific provider/model for one run
npm run audit -- my_reddit_handle --provider openai --model gpt-4o-mini
```

## CLI options

| Flag | Default | Description |
|------|---------|-------------|
| [reddit-username] / --reddit | none | Reddit user to audit (accepts u/name) |
| --hn <username> | none | Hacker News user to audit |
| --github <username> | none | GitHub user to audit (uses public REST API; set `GITHUB_TOKEN` to raise rate limit) |
| --so <id_or_url> | none | Stack Overflow user to audit (numeric user_id or profile URL) |
| -n, --max <n> | 300 | Maximum items fetched per platform |
| --max-chars <n> | 120000 | Maximum analysis transcript budget |
| --concurrency <n> | all (≤8) | Number of chunk workers processed in parallel |
| --provider <name> | auto-detect | LLM provider: `anthropic`, `openai`, or `claude-code` |
| --base-url <url> | none | OpenAI-compatible base URL (Gemini/Ollama/Groq/…); implies `openai` |
| --model <name> | provider default | Override the model name |
| --json | false | Emit JSON instead of text report |
| --require-external-proof | false | Fail if no proof URL exists beyond audited profile pages |
| -o, --out <file> | stdout | Write output to file |
| --i-am-authorized | false | Skip interactive authorization prompt for scripted runs |

## Reproducibility and calibration

- Increase -n to expand retrieval depth
- Increase --max-chars to reduce context truncation
- Pin the model (ANTHROPIC_MODEL / OPENAI_MODEL / CLAUDE_CODE_MODEL / --model) to control inference backend variance
- Store JSON outputs for temporal diff and regression analysis

## Build

```bash
npm run build
```

## Continuous integration

A GitHub Actions workflow at `.github/workflows/ci.yml` runs `npm run
lint`, `npm run format:check`, `tsc --noEmit`, `npm test`, and `npm run
build` on every push and pull request against `main`, across a Node 20 /
22 / 24 matrix.

## Limitations

- Findings are probabilistic and should not be interpreted as identity proof
- Recall is upper-bounded by source completeness and truncation constraints
- Stylometric separability is population- and domain-dependent
- Confidence calibration depends on evidence density and artifact quality
- GitHub's public events feed is capped at roughly 300 events from the
  last 90 days, so commit author emails that only appear in older
  history won't be picked up unless you supply `GITHUB_TOKEN` and walk
  repos directly (not yet implemented)
- The website link-follower is single-hop with same-origin sub-page
  expansion; JavaScript-rendered SPAs (Next.js client-rendered, Notion
  exports, etc.) return mostly empty bodies because there is no headless
  browser in the pipeline
- `@users.noreply.github.com` addresses are filtered out of the direct
  identifier extractor since they are the privacy-preserving default
  rather than a leak
