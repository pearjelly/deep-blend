# 成本：在花钱之前能知道什么

> 这份文档回答一个问题：**一次渲染、一次视觉审查要花多少，而用户在哪一刻能知道它。**
> 账本 C17 问的就是这个 ✓，而在它之前**一个读数都没有** ✓：渲染侧只有一句「参考机每帧多少秒」 ✓，
> token 侧连一个数都没有 ✓。
>
> 它由 `deepblend/tests/contract/cost-model.test.mjs` 盯住：文档里出现的**每一个数**都要能被
> 某条断言或命令**重算**出来 ✓；而产品里那句给用户看的估算，必须**由这个数算出来** ✓，
> 不是另抄一份 ✓。

---

## 1. 渲染：每帧多少秒，和「这一次要多久」

| 数 | 值 | 唯一来源 |
|---|---|---|
| 参考机每帧秒数 | **19.6 – 41.4 s** | `packages/deepblend/tool/lib/render-tools.js` 的 `REFERENCE_SECONDS_PER_FRAME`（1920×1080 / Cycles / 256 samples ✓，M2–M3 期间实测 ✓） |

**用户在哪一刻看到它** ✓：交付渲染超过帧数阈值时，**审批提示**里 ✓——
而它现在把乘法也做完了 ✓：

```
Start a DELIVERY render of 450 frame(s) (1..450) of revision r0002, above the configured
approval threshold of 900. Measured cost on the reference machine: 19.6-41.4 s per frame at
1920x1080 / Cycles / 256 samples, so this request is about 2.5 hours to 5.2 hours of machine time.
```

**为什么是区间不是单个数** ✓：19.6–41.4 是在**一台机器**上量出来的区间 ✓，
写成一个数会读成一句承诺 ✓。

**渲染已经在跑之后** ✓，读数来自**这台机器自己的**帧 ✓，不是参考机 ✓：
job 记录里的 `meanMsPerFrame` 与 `estimatedRemainingMs` ✓
（由 `packages/deepblend/contracts/lib/render-job.js` 的 `estimateRemaining()` 从**已落盘的帧时长**算 ✓），
`blender_job_status` 把它们打给模型与用户 ✓。

---

## 2. Token：一次视觉审查花多少

两次**真实**调用 ✓（`visual-review-live-probe.mjs` ✓，跑的是这个部署真的服务的那个模型 ✓）：

| 送进去的图 | 输入 | 输出 | 其中推理 | 合计 | 结果 |
|---|---|---|---|---|---|
| 单视角 640×360（6 KB） | 345 | 704 | 686 | **1049** | `finish: stop` ✓，模型描述了画面 ✓ |
| 真实 2×2 contact sheet（1014×630，37 KB） | 548 | 192 | 178 | **740** | `finish: stop` ✓，模型描述了画面 ✓ |

**读法**：两次的**图**差了六倍大小 ✓，而总 token 差不多 ✓——
**成本由推理决定，而推理量随问题而变** ✓。所以这里给的也是区间 ✓，不是单个数 ✓。

**一轮视觉循环的上界** ✓：`maxVisualIterations` 默认 5 ✓（`packages/deepblend/bundle/cordis.patch.yml` ✓），
所以一轮循环最多 5 次审查 ✓；按上面两次的读数，**每次在 700–1100 token 之间** ✓。
**单次审查的预算**是 `visualReviewMaxTokens: 24000` ✓——
它比一次正常回答大一个数量级 ✓，理由在 §3 ✓。

---

## 3. 用户能在花钱之前知道什么（今天）

| 花钱的地方 | 事前能知道吗 | 谁说的 |
|---|---|---|
| 一次交付渲染 | **能**：审批提示里给出帧数与估算时长 ✓ | `RENDER_APPROVAL_REQUIRED` 的 `reason` ✓（`recovery.md` §8 ✓） |
| 一次预览渲染 | **能**：采样数被预算削减时**必须说出来** ✓（静默降采样等于 review 了另一张图 ✓） | `maxPreviewSamples` ✓ 与 `RENDER_PROFILE_MISSING` ✓ |
| 一轮视觉循环 | **部分**：次数上界写在配置里 ✓（5 ✓），每次的 token 量今天只有 §2 那两次读数 ✓ | `maxVisualIterations` ✓ |
| 一次会话总共花多少 token | **不能** ✓ | — |

**仍然不知道的** ✓（这一行没有判据，写在这里是因为**不知道也要写下来** ✓）：

1. **一次视觉审查在真实循环里的 token 量** ✓ 与探针那两次不同 ✓——
   探针送一张图问一个问题 ✓，循环里的提示词更长（要它按视角/相机/帧回报 ✓），
   而**更长的问题 → 更多推理** ✓。要量它，得让循环真的跑一次并读它自己的 `usage` ✓——
   循环把 `usage` 记在**空回答**的错误详情里 ✓（`host/lib/index.js` 的 `visualReviewFailed` ✓），
   **成功的那次不记** ✓。这是下一轮可以补的一格 ✓。
2. **一次会话的累计成本** ✓：产品的任何地方都不聚合 token ✓，
   harness 自己会报 ✓，但 DeepBlend 没有把它汇总给用户 ✓。

---

## 4. 怎么复核

```bash
# 渲染侧：那个数只有一处定义，改它就改了三处（审批提示两处 + 工具描述）
grep -n "REFERENCE_SECONDS_PER_FRAME" packages/deepblend/tool/lib/render-tools.js

# 那次估算真的被算出来了（帧数 × 每帧秒数），而不是一句「hours of machine time」
node deepblend/tests/contract/tool-plane-output.test.mjs

# token 侧：两次真实调用，读它自己的 usage 行
node deepblend/tools/visual-review-live-probe.mjs
node deepblend/tools/visual-review-live-probe.mjs .deepblend/projects/mid-engine-supercar/revisions/r0006/contact-sheets/round-0.png
```
