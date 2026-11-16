# dsh-image-relay

> **Give text-only models eyes.** — a plugin for [DeepSeek Harness](https://github.com/deepseek-ai) (DSH)

[简体中文](README.zh-CN.md) | English

You run a strong text-only reasoner (glm-5.3, DeepSeek-V4, …) as your coding agent. You paste a screenshot — and the chat UI refuses the image, or the API answers `400: messages.content.type 参数非法`. The strongest models often can't see; the ones that can see are often weaker at reasoning.

**dsh-image-relay closes that gap.** Before the request leaves your machine, a vision model you configured describes each image, and the description is relayed to your main model as text. The main model never changes. It just sees.

```
┌────────────┐   vision model    ┌──────────────────────────────┐
│ image block│ ────────────────▶ │ [image relay: zai/glm-4.6v]  │
│ (screenshot)│   e.g. glm-4.6v  │ A screenshot of a terminal…  │
└────────────┘                   └──────────────┬───────────────┘
                                                │ text only
                                                ▼
                                          glm-5.3 answers
```

## Features

- **Automatic** — intercepts outgoing chat images (`agent/pre-step`) and `read_image` tool results (`tools/post-execute`). No prompt engineering, no manual steps; the agent doesn't even know a plugin is helping it.
- **Model-agnostic** — picks a vision model from your providers: explicit `visionModel`, then `preferVisionModels` order, then the provider's first advertised vision model. `visionProvider` enables cross-provider relay.
- **Lying-catalog support** — for models whose declared modality doesn't match reality (`relayFor`), image blocks are *replaced* by descriptions, so a text-only endpoint never receives an image block.
- **Persistent content-hash cache** — describe an image once; re-sending it (even in a later session) costs zero extra tokens.
- **Robust** — concurrent multi-image relay, automatic retries, per-call timeout, structured logging. A failed description degrades to a placeholder; it never fails your turn.
- **Private by design** — images go only to the vision model *you* configure. Cache stays on your disk. No telemetry, no third-party servers. MIT licensed.

## Install

Requires [DeepSeek Harness](https://github.com/deepseek-ai) (Desktop or Web profile).

```sh
# in your DSH profile directory (~/.dsh/profiles/<profile>)
pnpm add dsh-image-relay
```

Add the bundle to the profile's `package.json`:

```json
{
  "dsh": {
    "profile": {
      "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "dsh-image-relay"]
    }
  }
}
```

## Configure

In your profile's `cordis.patch.yml`:

```yaml
- id: image-relay
  name: "dsh-image-relay"
  config:
    # Models whose catalog says "image-capable" but the endpoint is text-only.
    # Needed only when you keep a UI-level input override so you can attach.
    relayFor: [glm-5.3]

    # Everything below is optional:
    # visionProvider: deepseek-official  # describe via another provider
    # visionModel: glm-4.6v              # pin the vision model
    # preferVisionModels: [glm-4.6v]     # preference order
    # retries: 1
    # maxTokens: 1024
    # timeoutMs: 120000
    # prompt: 'Describe this image precisely…'
```

For models that are *declared* text-only, no `relayFor` entry is needed — the relay runs automatically and inserts the description beside the harness's image placeholder.

All keys: [`docs/DETAIL.md`](docs/DETAIL.md).

### The glm-5.3 recipe

glm-5.3's chat endpoint accepts text only, but declaring it image-capable (`llm-pi-ai` → `modelOverrides.glm-5.3.input: [text, image]`) lets the DSH UI accept pasted images. Combine that override with `relayFor: [glm-5.3]` and you get: paste freely → glm-4.6v describes → glm-5.3 answers. Full walkthrough in [`docs/DETAIL.md`](docs/DETAIL.md).

## FAQ

**Why not just switch to a vision model?**
Because the strongest reasoners are often text-only, and switching models mid-session costs you context and quality. Relay keeps your main model and adds eyes on demand.

**Does this slow down my turns?**
First sight of an image adds one vision-model call (typically a few seconds). Repeat sends hit the local cache instantly.

**Where do my images go?**
Only to the vision model you configured, through your own credentials. Nothing else. The description cache is a local JSON file you can delete at any time.

## License

[MIT](LICENSE)
