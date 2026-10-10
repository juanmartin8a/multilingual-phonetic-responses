# SAPO development phonetic population

Two standalone Bun scripts generate missing IPA transcriptions and native-script
respellings for SAPO's development database. Generation is always enabled.
By default, finalized results are saved locally. With `--write`, each finalized
batch is inserted into the database and no local files are created or updated.

## Setup

The project pins Bun 1.4.2 in `.bun-version` and `packageManager`. These scripts
use SAPO's existing `convex` dependency; install SAPO's dependencies if absent.
There are no additional package dependencies here.

1. Deploy SAPO's `convex/phoneticPopulation.ts` and
   `convex/model/phoneticPopulation.ts` through its normal development workflow.
2. Copy `.env.example` to `.env.local` here and fill in `CONVEX_KEY` and
   `CLOUDFLARE_API_TOKEN`. The Convex key must match the hosted `dev:` deployment
   in SAPO's `.env.local`.
3. Configure AI Gateway with an OpenAI provider key under alias `default`,
   authenticated gateway access, and an API token with AI Gateway Run permission.
   No local `OPENAI_API_KEY` is used.
4. Set `cloudflare.accountId` and `cloudflare.gatewayId` in each script's YAML
   configuration. Keep credentials in the environment, outside YAML.

Both scripts verify SAPO's development deployment name and URL, require a matching
development key, check for conflicts with production configuration, and reject
redirects. Neither accepts an arbitrary database URL or production flag.

## Run

```sh
# Generate and save finalized results locally.
bun run transcriptions
bun run respellings

# Generate and insert each finalized batch; no local writes.
bun run transcriptions --write
bun run respellings --write

# Override the allowance for this invocation or limit scanned pages.
bun run transcriptions --budget 1 --max-pages 1
bun run respellings --write --budget 5

# Offline tests with mocked AI and database calls.
bun test
```

The package shortcuts explicitly load this checkout's `.env.local`. Direct
invocation is equivalent: `bun --env-file=.env.local populate-transcriptions.mjs`.
`bunfig.toml` disables automatic environment-file loading. SAPO's environment
files are only read to verify the development target.

There is no `--generate` or `--rescan` flag. Every invocation scans from the start,
reusing matching local results or skipping values already present in the database.
Both scripts scan all pages by default; `--max-pages N` limits scan pages, each
containing at most 50 words. It does not count the refresh queries used to resolve
new IPA IDs. `--help` displays the available flags without generating anything.

## Configuration

`populate-transcriptions.mjs` uses `config/transcriptions.yml`;
`populate-respellings.mjs` uses `config/respellings.yml`. Each loads only its own
file. Use `--config PATH` to select a replacement.

CLI options override YAML settings. Environment variables supply only credentials.
YAML paths are relative to the selected file; CLI paths are relative to the shell.
`~/` is supported in YAML paths. Default config and state paths are relative to
these scripts, independent of the working directory.

- `project`: SAPO checkout, default `~/development/react-native/sapo`.
- `stateDir`: local results directory, default `<script-dir>/.state`.
- `batchSize`: 1–1000 words per AI request, default 20. Larger batches group
  database pages. Long inputs/review notes are split to fit request/token limits.
- `maxPages`: scan-page limit; 0 means all pages.
- `ai`: provider, model, API, reasoning effort, output cap, and token prices.
- `limits`: positive per-run USD allowance, RPM/TPM, attempts, and timeout.
- `cloudflare`: account and gateway identifiers.
- `languagePolicies`: source dialect and target Unicode-script overrides.

Unknown settings and invalid types are rejected. Quote monetary values for exact
arithmetic. The integration supports OpenAI provider-native Responses and Chat
Completions endpoints through AI Gateway. Change the model and all four token
prices together; alternate models require explicit prices and structured-output
support. Models without a reasoning parameter can use `reasoningEffort: omit`.

## Local storage and write mode

Default mode stores only:

| Path | Contents |
| --- | --- |
| `results/<hash>.json` | Task, word/entry identity, source language, final value, and generation signature. Respelling results also contain the target language and exact source IPA. |
| `respelling-pair.json` | Source and target language codes for subsequent respelling runs. |

Only valid, finalized results are saved. Review notes, first-pass decisions, raw
provider responses, failed attempts, rejections, usage history, checkpoints, and
locks are not stored. Cache files are written atomically with private permissions.
The default `.state/` directory and credential files are ignored by Git.

The cache signature covers prompts, schemas, language policies, model, reasoning
effort, and API. The filename also identifies the deployment and exact job. Batch
size changes reuse compatible results; incompatible settings generate new ones.

`--write` can read matching results and a language pair from an existing local
cache, so generating locally first and inserting later does not require paying
again for those results. It creates or updates no local state. Without a saved
pair, a write run chooses its source and target in memory.

After each AI batch, required reviews finish before finalized values are inserted.
Database mutations contain at most 50 records. An insertion failure stops further
AI generation; previous inserted batches remain in the database. Any uninserted
in-memory results are lost when the process exits and may need generating again.
Repeating the command discovers progress by scanning existing database values and
local results. There is no separate cache-only insertion mode.

## Data and review

Transcriptions scan populated languages and generate only for words without IPA.
Existing transcriptions and pronunciation variants are preserved.

Respellings choose a populated source and a distinct target language. They process
every source IPA variant missing its target guide. Missing IPA is generated first;
write mode inserts it and reloads real database IDs before linking respellings.
Local mode uses the generated IPA directly, without requiring a database ID.

Requests contain ordered words with positional indexes; database IDs stay local.
Returned indexes and words must match exactly. Values are validated for IPA shape
or target script. Invalid individual records are skipped and reported in the
terminal; rerunning retries them naturally because they were not saved/inserted.
Invalid JSON, refusals, incomplete responses, and billing errors stop the batch.

Valid first-pass items marked for review receive a separate final-editor request
using the same model. Only flagged words, their review notes, and authoritative IPA
where applicable are sent. Every reviewed item must return a valid definitive
value. A failed review prevents the batch from being saved or inserted.

Structural validation cannot prove pronunciation accuracy or resolve every
context-dependent reading. Language policies guide the model's choice.

## Budget and rate limits

Every invocation starts with a fresh budget. Before starting a new paid batch,
the script checks spending committed during that invocation. A batch admitted
below the threshold finishes retries and required reviews even if they exceed
it. The allowance is a stop threshold, not a hard spending cap.

Costs use integer nano-USD and account for uncached input, cached input, cache
writes, and total output, including reasoning. Each attempt temporarily reserves
a conservative input/output cost in memory. Returned usage settles it to known
cost; missing usage or transport failures retain the reservation for that run.
The final terminal summary reports known cost, uncertain cost, and token usage.
Nothing is written to a usage ledger.

RPM/TPM tracking is in memory and resets on restart. Transient HTTP and transport
failures retry with exponential backoff and `Retry-After`; gateway automatic
retries and response caching are disabled. Provider error messages are not logged
because they may echo credentials. Provider billing remains authoritative.
