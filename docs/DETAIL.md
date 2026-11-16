# Image relay

When the session's model accepts text only (for example glm-5.3 on a text-only route), DSH replaces every image in the request with a placeholder like `[image omitted because this model accepts text only]`, so the model knows an image exists but cannot see it.

This plugin adds the missing half: it picks an **image-capable model from the same provider** (explicit `visionModel` config, then `preferVisionModels` order, then the provider's first advertised vision model) and asks it to describe each image. The description is inserted as a text block right after the image block, marked `[image relay: <provider>/<model>]`.

## What is covered

- Images attached to your chat messages (`agent/pre-step` rewrite of the claimed batch).
- Images returned by the `read_image` tool (`tools/post-execute` transform).

The durable session log keeps the original image blocks untouched; the description text is added beside them, and descriptions are cached per attachment for the session.

## Behavior notes

- If the current model already accepts images, the plugin does nothing.
- If no same-provider vision model is advertised, or a description call fails or times out, the harness placeholder text is sent as before; the turn is never failed by the relay.
- Descriptions cost tokens on the vision model each time a new image is relayed (cached afterwards).

## Configuration (`cordis.patch.yml`)

| Key | Default | Meaning |
| --- | --- | --- |
| `enabled` | `true` | Master switch. |
| `relayFor` | `[]` | Model ids (or `provider/model`) whose declared modality is not trusted: always relay for them and replace the image block with the description text. Use this when the catalog/override says the model accepts images (so the UI lets you attach) but the endpoint is text-only in practice. |
| `always` | `false` | Blanket form of `relayFor`: force relay+replace for every model. Prefer `relayFor`. |
| `visionProvider` | unset | Describe images through a different provider instead of the current route's own (cross-provider relay). |
| `visionModel` | unset | Explicit vision model id; wins over preference order. |
| `preferVisionModels` | `[]` | Ordered preferred vision model ids. |
| `maxTokens` | `1024` | Output-token cap per description request. |
| `timeoutMs` | `120000` | Deadline per description request. |
| `retries` | `1` | Extra attempts when a description call fails or times out. |
| `prompt` | built-in English instruction | Instruction sent with the image to the vision model. |

Descriptions are cached per attachment id and persisted to `description-cache.json` beside `index.js`, so re-sending the same image (even in a later session) costs no extra vision tokens. The cache is capped at 500 entries.
