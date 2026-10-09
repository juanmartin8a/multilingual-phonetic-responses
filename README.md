# SAPO development phonetic population

Two standalone **Bun 1.4.2+** scripts (latest stable verified on 2026-10-08;
no installation/build needed). They use
SAPO's existing `convex` dependency; install SAPO's dependencies if absent.
JavaScript fits the TypeScript/Convex backend and avoids a second database SDK.
Python's existing `words_to_convex` tool creates word lists, not pronunciations.

## Setup

Use Bun **1.4.2**, the version recorded in `.bun-version` and `packageManager`.
If you installed Bun directly, `bun upgrade` updates it to the latest stable
release; if managed by Homebrew or a version manager, update it through that tool.
Check `bun --version` before running. No `bun install` is needed here.

1. In SAPO's **development** Convex dashboard, set
   `SAPO_PHONETICS_DEVELOPMENT_URL` to the exact `EXPO_PUBLIC_CONVEX_URL` from
   SAPO's `.env.local`. **Do not set this variable in production.**
2. Publish the new `convex/phoneticPopulation.ts` and
   `convex/model/phoneticPopulation.ts` to development using the project's normal
   `npm run convex:dev` workflow. This also regenerates Convex types. These files
   are in SAPO's backend git submodule. They have **not** been deployed by this task.
   Preserve/deploy the existing pronunciation schema and helpers they import.
3. Copy `.env.example` to `.env` here and fill in credentials. The Convex key must
   be a `dev:<name>|...` deployment key for SAPO's `.env.local` deployment.
   The Cloudflare token needs **Account > Workers AI > Read** for the current
   REST API. Enable Unified Billing credits and verify `openai/gpt-6.1-sol`
   availability in the account. Select the intended gateway ID.
4. Edit `config.yml` for non-secret settings. Uncomment `cloudflare` and enter
   your account and gateway IDs before generating. Keep API tokens and deployment
   keys out of YAML; only `.env` or shell variables supply credentials.

Neither script accepts a database URL or a production switch. Both require the
development name/URL in `.env.local`, a matching **dev** key, and the backend's
explicit opt-in matching `CONVEX_CLOUD_URL`. The production environment file is
also checked for a conflicting target. Production/project/preview/legacy keys,
local deployments, redirects, and mismatched URLs are rejected.

## Run

From `~/development/js/scripts/sapo`:

```sh
# First-page read-only plans. No model call; no database mutation.
bun --env-file=.env populate-transcriptions.mjs
bun --env-file=.env populate-respellings.mjs

# Optional: paid generation saved LOCALLY, without database writes.
bun --env-file=.env populate-transcriptions.mjs --generate --budget 1 --max-pages 1
bun --env-file=.env populate-respellings.mjs --generate --budget 1 --max-pages 1

# Paid generation plus INSERT-ONLY development writes, within the shared budget.
bun --env-file=.env populate-transcriptions.mjs --generate --write --budget 5
bun --env-file=.env populate-respellings.mjs --generate --write --budget 5

# Offline tests: mocked database and AI only.
bun test
```

`bun run transcriptions` and `bun run respellings` are equivalent shortcuts;
append the same script flags. `bunfig.toml` disables Bun's automatic environment
file loading, so only explicitly selected `--env-file` files and shell variables
are used. Keep secret values containing `$` escaped as `\$` in Bun environment
files to prevent variable expansion. SAPO's deployment environment files are
parsed read-only and never loaded into the script's environment.

### Configuration

`config.yml` beside the scripts is the default settings file, independent of the
shell's working directory. Use `--config path/to/settings.yml` to select another
file explicitly; files are not automatically merged. YAML is parsed by Bun's
built-in parser, so no package installation is needed.

Precedence is **CLI options > YAML settings > safe built-in defaults**. Environment
variables supply only `SAPO_CONVEX_DEV_KEY` and `CLOUDFLARE_API_TOKEN`; the old
`AI_*`, `SAPO_MAX_USD`, account/gateway, and language-policy environment settings
are no longer read. Move any existing values into the corresponding YAML sections.
`--generate` and `--write` remain explicit CLI permissions, never YAML settings.

The file groups model/output settings under `ai`, spending/rate/retry settings
under `limits`, and account identifiers under `cloudflare`. `project`, `stateDir`,
`batchSize`, `maxPages`, and `languagePolicies` are top-level settings. Unknown
fields and invalid types/values are rejected. Quote monetary values to preserve
exact decimals; integer limits use YAML numbers. Paths in YAML are relative to
the selected config file (`~/` is supported); CLI paths are relative to the shell.
Omitting `stateDir` keeps the shared `<script-dir>/.state` ledger.

```sh
bun --env-file=.env populate-transcriptions.mjs --config ./config.yml --generate --budget 1
```

`config.yml` can be committed because it contains no credentials. All `.env*`
files except `.env.example` are ignored by Git. The SAPO checkout's deployment
environment files still serve only as read-only development-target safety checks.

The default state directory is beside these scripts, independent of the shell's
working directory. The budget is the **cumulative cap for that shared `.state`
directory**, not a new
allowance for every command. `$5` means five dollars total across both scripts,
all retries, and resumes. Raise the cap deliberately to continue. Keep the same
state directory; creating another directory creates another independent budget.
Run `--help` for flags. Generation/write scans all pages by default; planning
reads one page unless `--max-pages 0` is specified. `--max-pages` counts pages,
not words; each page has at most 50 words and may have multiple IPA variants.

Resume by repeating the command. Generation-only and write checkpoints are
separate, so applying locally generated results scans from the beginning and
reuses item caches. `--rescan` starts that stage again while retaining results,
spending, and the selected pair; use it for newly added words/languages or after
manual review. The source is chosen randomly among languages containing words;
the target is selected independently from all other distinct languages. The pair
is saved even during planning and retained on every resume/rescan. A new state
directory selects a new pair but also has a **separate** spending ledger.

## Data and quality

- Transcriptions scan every existing language/word but generate only where no
  transcription exists. They add one common standard broad IPA pronunciation;
  existing records and variants are never updated/deleted.
- Respellings use every existing source IPA variant missing its target guide.
  They first generate missing IPA, including in generation-only mode, then use
  that exact IPA to produce a native-script approximation. Generated IPA and
  respellings can be reviewed before insertion. Existing guides are preserved.
- Both tasks use strict JSON Schema and local validation of exact keys, counts,
  status/value consistency, bounded strings, IPA shape, and target scripts.
  Database IDs/codes come from Convex, never from the model. The backend rechecks
  linked documents and performs indexed existence checks and inserts atomically.
  Parallel/repeated mutations cannot create duplicates through these endpoints.
- `results/*.json` contains the result **and its word, language policy, and IPA
  context**. `status: review` records are never inserted. They remain in local
  caches; rescanning alone does not retry them. A linguist can correct a reviewed
  result (`ready`, valid `value`, empty `note`) before rescanning. Otherwise fix
  the source data/policy and regenerate under the same cumulative budget.
- Standard policies match SAPO where defined: neutral Latin American Spanish,
  Brazilian Portuguese, Beijing Mandarin/Simplified Chinese, etc. All other
  source languages use their most widely understood standard variety. Override
   dialect/script via `languagePolicies` in YAML. Japanese uses kana/kanji,
  Mandarin uses Han characters, Arabic permits vowel marks. An unsupported
  randomly selected target script stops with a policy-configuration error.

Structural validation cannot prove phonetic correctness, detect all heteronyms,
or verify Simplified vs Traditional Chinese. Missing sense/context/dialect data
limits certainty. Review representative samples with native speakers before any
large run. Ambiguous/unreliable words are intentionally left missing for review,
so a completed scan does **not** imply every word was safely transcribable.

## Gateway, usage, and costs

All inference goes through Cloudflare's current `/ai/v1/responses` or
`/ai/v1/chat/completions` REST API, with `cf-aig-gateway-id`. No direct provider
requests, tools, web searches, background jobs, or hidden SDK retries are used.
Defaults: `openai/gpt-6.1-sol`, `reasoning.effort: high`, standard service tier,
20 words/call, 25,000 output tokens (including reasoning), one in-flight request,
10 RPM. The output cap follows OpenAI's initial reasoning-budget guidance and can
be reduced after measuring real usage. Reasoning tokens are included in
output usage and are **not double-counted**. Temperature/top-p are omitted.

Change `ai.provider`, `ai.model`, and **all four `ai.pricesUsdPerMillion` values**
together. A CLI model/provider override cannot reuse a different YAML model's
price table; select a matching config file instead. Non-OpenAI defaults to the
OpenAI-compatible chat API when `ai.api` is omitted; set it to `responses` if
supported, or `chat` otherwise. Set `ai.reasoningEffort: omit` for a provider/model
without that parameter. For Workers AI set `ai.provider: workers-ai` and the full
`ai.model: "@cf/..."` slug.
Structured output support and normalized usage counters are required; unsupported
models fail closed, never silently fall back to free-form text. Alternate models
must report usage consistently with these compatible APIs. Native provider-only
features and non-token billing aren't supported. Set actual gateway/provider rates
including regional premiums; prices aren't inferred from a model name. Explicit
cache-write usage reporting is required whenever its price differs from ordinary
input. Providers without cache-write billing can set that price equal to input.

Known cost is calculated with integer nano-USD from uncached input, cached input,
cache writes (a replacement rate, **not** an additive fee), and total output.
Usage and cost persist in `usage.jsonl`; each request has its prices and model.
The final summary separates known cost from uncertain reservations. Provider
invoices remain authoritative. Missing/inconsistent usage, an unexpected service
tier, or an unexpectedly large context stops execution before writing that batch.

Before each attempt, reserve output-token cap cost plus a conservative input
bound: full request UTF-8 bytes plus 8,192 framing tokens, at the highest input
rate. Requests over 64K reserved input tokens are rejected, below GPT-6.1 Sol's
long-context pricing threshold. This is deliberately conservative, not a tokenizer
estimate; it assumes provider framing fits that allowance and configured prices
match actual billing. The client checks returned usage against the reservation.
Keep gateway automatic retries/fallbacks disabled (also sent as
`cf-aig-max-attempts: 1`) so billing isn't hidden from the ledger. Configure a
gateway-side spending limit as defense in depth when using arbitrary providers.

429/408/5xx/network failures retry with exponential backoff, jitter, and
`Retry-After`, subject to fresh budget reservations and persistent rolling RPM/TPM
limits. **Unknown billing is never treated as zero**: crashes/timeouts/rejections
without usage retain the full reservation. Saved responses are settled/reused on
restart; incomplete/refused/invalid outputs are charged but never written or
automatically regenerated. Valid item caches avoid repeat generation even if
batch size changes. Gateway response caching is skipped to avoid replaying usage
as a new bill; GPT-6 explicit prefix caching avoids cache writes for changing word
batches. Prompts stay concise; they are not padded just to reach caching thresholds.

## Recovery and privacy

Only one process may use a state directory. On an abnormal crash, inspect
`.state/population.lock`, ensure its PID is no longer running, then remove **only
that lock file**. Keep the ledger and caches. An incomplete final journal event
stops execution; recover it against saved request artifacts/gateway logs instead
of deleting it to gain budget. Unknown charges remain conservatively reserved.
No automatic stale-lock removal or unknown-cost refunds occur.

State/credentials are ignored by Git and created with restrictive permissions.
Do not delete/share state casually: it contains source words, outputs, and usage.
No secret key is written to state or passed as a CLI argument. Cloudflare gateway
logging/retention remains your account's setting; prompts go to the selected AI
provider through Cloudflare. The backend module must stay disabled in production.

## Architecture and research (2026-10-08)

Two small entrypoints share data-oriented modules for plain configuration,
validation, HTTP calls, and disk files. No AI SDK, ORM, schema library, queue,
or new package dependency. Indexed, paginated backend reads avoid full-table
downloads; bounded batch mutations reuse SAPO's relationship-aware helpers.
Atomic JSON checkpoints/item caches and a fsynced append-only reservation ledger
provide recovery without introducing a separate database.
The test suite uses native `bun:test`. Bun implements the retained `node:*`
standard-library imports directly; no Node executable is required to run these
scripts. The filesystem code deliberately retains `fsync` and atomic renames to
preserve existing spending-ledger and checkpoint durability. The state format,
cache keys, budget tracking, and development-only backend are unchanged.

Sources informing the request contract and prompts:

- [GPT-6 guidance](https://developers.openai.com/api/docs/guides/latest-model):
  supported reasoning, concise task boundaries, no unsupported sampling settings.
- [GPT-6.1 Sol](https://developers.openai.com/api/docs/models/gpt-6.1-sol): high
  effort, Structured Outputs, standard prices ($2 input, $0.10 cached input,
  $2.50 cache writes, $10 output per million tokens).
- [Reasoning guidance](https://developers.openai.com/api/docs/guides/reasoning):
  simple direct prompts, no requested chain of thought, and initial output headroom.
- [Structured Outputs](https://developers.openai.com/api/docs/guides/structured-outputs):
  strict object schemas, required fields, refusal/incomplete handling.
- [Prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching):
  explicit reusable-prefix breakpoints, cache-write usage, replacement pricing.
- [AI Gateway REST API](https://developers.cloudflare.com/ai-gateway/usage/rest-api/):
  current unified endpoints, provider/model naming, token permissions, gateway header.
- [OpenAI provider endpoint](https://developers.cloudflare.com/ai-gateway/usage/providers/openai/)
  and [unified compatibility API](https://developers.cloudflare.com/ai-gateway/usage/chat-completion/):
  researched alternatives; the latter is now deprecated for new single-model calls.
- [Gateway request handling](https://developers.cloudflare.com/ai-gateway/configuration/request-handling/):
  explicit retry/timeout controls; client owns retries for budget visibility.

The test suite covers YAML configuration/validation, explicit-only environment
loading, and the installed Convex client with mocked HTTP. Existing state files
require no conversion.

YAML migration verification: **28 tests passed on the installed Bun 1.4.0**;
both CLI help commands passed. The project still pins Bun 1.4.2; that version
was not installed or verified during this migration.

Verification is offline/mocked. No paid model access, phonetic accuracy, live
gateway usage normalization, deployment, or bulk database writes were exercised.
