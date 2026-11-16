# dsh-image-relay

> **给纯文本模型一双眼睛。** —— [DeepSeek Harness](https://github.com/deepseek-ai)（DSH）插件

English | [简体中文](README.zh-CN.md)

你用一个强大的纯文本推理模型（glm-5.3、DeepSeek-V4……）当编码主力，贴一张截图——结果要么 UI 直接拒绝图片，要么 API 回你一句 `400: messages.content.type 参数非法`。最强的模型常常看不见图片；看得见的模型推理又常常更弱。

**dsh-image-relay 补上这块短板。** 请求发出本机之前，由你配置的视觉模型把每张图片描述成文字，转述给主模型。主模型不用换，它只是"看见"了。

```
┌────────────┐   视觉模型         ┌──────────────────────────────┐
│ 图片块      │ ────────────────▶ │ [image relay: zai/glm-4.6v]  │
│ (截图)      │   如 glm-4.6v     │ 一张终端截图，内容是……        │
└────────────┘                   └──────────────┬───────────────┘
                                                │ 纯文本
                                                ▼
                                           glm-5.3 正常回答
```

## 特性

- **全自动** —— 拦截发出的聊天图片（`agent/pre-step`）和 `read_image` 工具结果（`tools/post-execute`）。不需要提示词工程、不需要手动步骤，模型甚至不知道有插件在帮它。
- **模型无关** —— 从你配置的 provider 里挑视觉模型：显式 `visionModel` → `preferVisionModels` 顺序 → provider 第一个支持的视觉模型；`visionProvider` 支持跨 provider 转述。
- **应对"说谎"的模型目录** —— 对声明模态与实际不符的模型（`relayFor`），图片块会被**替换**为描述文本，纯文本端点永远收不到 image 块，不会再 400。
- **按图片哈希的持久缓存** —— 一张图描述一次，重发（哪怕换了会话）零额外 token。
- **健壮** —— 多图并发、自动重试、超时控制、结构化日志；描述失败降级为占位文本，绝不打断你的回合。
- **隐私优先** —— 图片只发给你自己配置的视觉模型，缓存留在本机磁盘。无遥测、无第三方服务器。MIT 协议。

## 安装

```sh
# 在你的 DSH profile 目录（~/.dsh/profiles/<profile>）
pnpm add dsh-image-relay
```

并把 bundle 加进 profile 的 `package.json`：

```json
{
  "dsh": {
    "profile": {
      "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "dsh-image-relay"]
    }
  }
}
```

## 配置

在你 profile 的 `cordis.patch.yml` 里：

```yaml
- id: image-relay
  name: "dsh-image-relay"
  config:
    # 目录声称"支持图片"、实际端点只收文本的模型写在这里。
    # 仅在你保留了 UI 层的 input 覆盖（为了能贴图）时需要。
    relayFor: [glm-5.3]

    # 以下全部可选：
    # visionProvider: deepseek-official  # 用另一个 provider 的视觉模型
    # visionModel: glm-4.6v              # 固定视觉模型
    # preferVisionModels: [glm-4.6v]     # 偏好顺序
    # retries: 1
    # maxTokens: 1024
    # timeoutMs: 120000
    # prompt: '精确描述这张图片……'
```

对**声明为**纯文本的模型无需 `relayFor`：转述自动运行，描述会插在 DSH 图片占位符旁边。

全部配置项见 [`docs/DETAIL.md`](docs/DETAIL.md)。

### glm-5.3 完整配方

glm-5.3 的对话端点只收文本，但把它声明为支持图片（`llm-pi-ai` → `modelOverrides.glm-5.3.input: [text, image]`）可以让 DSH 的 UI 接受贴图。这个覆盖 + `relayFor: [glm-5.3]` 组合起来就是：随意贴图 → glm-4.6v 描述 → glm-5.3 回答。完整步骤见 [`docs/DETAIL.md`](docs/DETAIL.md)。

## 常见问题

**为什么不直接换视觉模型？**
因为最强的推理模型常常是纯文本的，中途换模型损失上下文和质量。转述保持主模型不变，按需加眼睛。

**会拖慢回合吗？**
第一次"看"一张图需要一次视觉模型调用（几秒）。重发同一张图直接命中本地缓存，瞬间完成。

**我的图片会发到哪？**
只发给你配置的视觉模型，走你自己的凭证，别处不去。描述缓存是本地 JSON 文件，随时可删。

## 许可

[MIT](LICENSE)
