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

1. Publish the new `convex/phoneticPopulation.ts` and
   `convex/model/phoneticPopulation.ts` to development using the project's normal
   `npm run convex:dev` workflow. This also regenerates Convex types. These files
   are in SAPO's backend git submodule.
   Preserve/deploy the existing pronunciation schema and helpers they import.
2. Copy `.env.example` to `.env.local` here and fill in credentials. The Convex key must
   be a `dev:<name>|...` deployment key for SAPO's `.env.local` deployment.
   In Cloudflare **AI > AI Gateway**, create/select your gateway, then go to
   **Provider Keys > Add API Key**. Select **OpenAI**, enter your OpenAI project
   key, and save it with alias **default**. Verify your OpenAI project has API
   billing enabled and access to `gpt-6.1-sol`. Open the gateway's
   **Settings > Create authentication token**, and save the
   token as `CLOUDFLARE_API_TOKEN`. The token needs **Account > AI Gateway > Run**,
   scoped to your account (not Workers AI Read). Enable **Authenticated Gateway**
   and **Require provider credentials** in the gateway settings. No Cloudflare
   Unified Billing credits are required, and no OpenAI key is needed locally.
3. Edit `config/transcriptions.yml` or `config/respellings.yml` for the script
   you want to run. Uncomment `cloudflare` and enter your account and gateway
   IDs in that file before generating. Keep API tokens and deployment
   keys out of YAML; only `.env.local` or shell variables supply credentials.

Neither script accepts a database URL or a production switch. Both require the
development name/URL in SAPO's `.env.local` and a matching **dev** key. The
backend checks the requested URL against Convex's built-in `CONVEX_CLOUD_URL`;
no custom backend URL variable is needed. The production environment file is
also checked for a conflicting target. Production/project/preview/legacy keys,
local deployments, redirects, and mismatched URLs are rejected.

## Run

From `~/development/js/sapo-mpr`:

```sh
# First-page read-only plans. No model call; no database mutation.
bun --env-file=.env.local populate-transcriptions.mjs
bun --env-file=.env.local populate-respellings.mjs

# Optional: paid generation saved LOCALLY, without database writes.
bun --env-file=.env.local populate-transcriptions.mjs --generate --budget 1 --max-pages 1
bun --env-file=.env.local populate-respellings.mjs --generate --budget 1 --max-pages 1

# Paid generation plus INSERT-ONLY development writes, within the shared budget.
bun --env-file=.env.local populate-transcriptions.mjs --generate --write --budget 5
bun --env-file=.env.local populate-respellings.mjs --generate --write --budget 5

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

`populate-transcriptions.mjs` defaults to `config/transcriptions.yml`;
`populate-respellings.mjs` defaults to `config/respellings.yml`. Each file contains
only settings for its script, so changing one does not change the other. Both
scripts share parsing and validation code, but never load each other's settings.
Default config paths are independent of the shell's working directory. Use
`--config path/to/settings.yml` to replace the selected script's config explicitly;
files are not merged. YAML is parsed by Bun's built-in parser, so no package
installation is needed.

Precedence is **CLI options > YAML settings > safe built-in defaults**. Environment
variables supply only `CONVEX_KEY` and `CLOUDFLARE_API_TOKEN`; the old
`AI_*`, `SAPO_MAX_USD`, account/gateway, and language-policy environment settings
are no longer read. Move any existing values into the corresponding YAML sections.
`--generate` and `--write` remain explicit CLI permissions, never YAML settings.
`OPENAI_API_KEY` is not read; store your provider key in the gateway dashboard,
not in local environment files. The gateway uses the OpenAI key's `default` alias.

The file groups model/output settings under `ai`, spending/rate/retry settings
under `limits`, and account identifiers under `cloudflare`. `project`, `stateDir`,
`batchSize`, `maxPages`, and `languagePolicies` are top-level settings. Unknown
fields and invalid types/values are rejected. Quote monetary values to preserve
exact decimals; integer limits use YAML numbers. Paths in YAML are relative to
the selected config file (`~/` is supported); CLI paths are relative to the shell.
For these files in `config/`, `stateDir: ../.state` refers to the existing shared
ledger. Omitting `stateDir` also keeps the shared `<script-dir>/.state` ledger.
Configuration independence does not split spending: both scripts retain that
ledger and lock unless you explicitly select different state directories.
`languagePolicies` in the transcription config controls source pronunciation;
in the respelling config it controls source pronunciation and target scripts.

```sh
bun --env-file=.env.local populate-transcriptions.mjs --config ./config/transcriptions.yml --generate --budget 1
```

Both `config/*.yml` files can be committed because they contain no credentials. All `.env*`
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
  Each request restricts output keys to an enum of its input keys to prevent
  mistyped IDs. Duplicate keys still fail local validation; rejection messages
  identify the offending record and saved response file.
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

All inference goes through AI Gateway's OpenAI provider-native endpoints:
`https://gateway.ai.cloudflare.com/v1/<account>/<gateway>/openai/responses`
or `/openai/chat/completions`. Only
`cf-aig-authorization: Bearer <CLOUDFLARE_API_TOKEN>` is sent for authentication.
There is no provider `Authorization` header: AI Gateway injects the OpenAI key
stored under its `default` alias. OpenAI bills your API project directly. Requests
carry `cf-aig-no-wholesale: true` to prevent Unified Billing fallback; a missing or
invalid stored key fails at the gateway/provider, without falling back to credits.
No direct OpenAI URL, Workers AI endpoint, tools,
web searches, background jobs, or hidden SDK retries are used.
Defaults: `gpt-6.1-sol`, `reasoning.effort: high`, standard service tier,
20 words/call, 25,000 output tokens (including reasoning), one in-flight request,
10 RPM. The output cap follows OpenAI's initial reasoning-budget guidance and can
be reduced after measuring real usage. Reasoning tokens are included in
output usage and are **not double-counted**. Temperature/top-p are omitted.

This integration supports **OpenAI only**; other providers are rejected rather
than sent your OpenAI key. Keep `ai.provider: openai`. Change `ai.model` and **all
four `ai.pricesUsdPerMillion` values** together. Model names must be native OpenAI
names, without an `openai/` prefix. A CLI model override cannot reuse a different
YAML model's price table; select a matching config file instead. `ai.api` defaults
to `responses`; set it to `chat` for Chat Completions. Set `ai.reasoningEffort: omit`
for a model without that parameter.
Structured output support and normalized usage counters are required; unsupported
models fail closed, never silently fall back to free-form text. Alternate models
must report usage consistently with these APIs. Native provider-only
features and non-token billing aren't supported. Set your actual OpenAI rates
including regional premiums; prices aren't inferred from a model name. Explicit
cache-write usage reporting is required whenever its price differs from ordinary
input. Models without cache-write billing can set that price equal to input.

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
gateway-side spending limit as defense in depth. Review your OpenAI project budget
and usage alerts too; the local ledger does not track requests made by other apps.

429/408/5xx/network failures retry with exponential backoff, jitter, and
`Retry-After`, subject to fresh budget reservations and persistent rolling RPM/TPM
limits. **Unknown billing is never treated as zero**: crashes/timeouts/rejections
without usage retain the full reservation. Saved responses are settled/reused on
restart; incomplete/refused/invalid outputs are charged but never written or
automatically regenerated. Valid item caches avoid repeat generation even if
batch size changes. Requests with the input-key enum have a different response
cache key from older unconstrained requests. After upgrading, resume with the
same command: valid item results are reused, and an older rejected batch gets a
new constrained request under the existing cumulative budget. Keep all state
files; the rejected request's charge remains in the ledger.
Gateway response caching is skipped to avoid replaying usage
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
provider through Cloudflare. Use these scripts only with the verified development deployment.

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
item cache keys, budget tracking, and development-only backend are unchanged.
HTTP response cache digests now include the provider-native gateway URL; keep the
existing ledger and item results when switching endpoints.

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
- [OpenAI provider endpoint](https://developers.cloudflare.com/ai-gateway/usage/providers/openai/):
  provider-native Responses/Chat Completions URLs.
- [BYOK (Store Keys)](https://developers.cloudflare.com/ai-gateway/configuration/bring-your-own-keys/):
  dashboard provider-key storage, default aliases, and omitting provider authorization.
- [Authenticated Gateway](https://developers.cloudflare.com/ai-gateway/configuration/authentication/):
  AI Gateway Run permission and `cf-aig-authorization` for provider-native requests.
- [Unified Billing credential precedence](https://developers.cloudflare.com/ai-gateway/features/unified-billing/#credential-precedence):
  stored keys take precedence over credits; `cf-aig-no-wholesale` prevents fallback.
- [Gateway request handling](https://developers.cloudflare.com/ai-gateway/configuration/request-handling/):
  explicit retry/timeout controls; client owns retries for budget visibility.

The test suite covers YAML configuration/validation, explicit-only environment
loading, and the installed Convex client with mocked HTTP. Existing state files
require no conversion.

Stored-key BYOK verification: **30 tests passed on the installed Bun 1.4.0**;
both CLI help commands passed. The project still pins Bun 1.4.2; that version
was not installed or verified during this change. Tests cover gateway authentication,
absence of provider authorization, provider-native routes, disabled billing
fallback, and credential-free
state/logs, including provider errors that echo credentials.

Verification is offline/mocked. No paid model access, phonetic accuracy, live
gateway usage normalization, deployment, or bulk database writes were exercised.
