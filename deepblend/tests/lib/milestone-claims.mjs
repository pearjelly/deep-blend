#!/usr/bin/env node
/**
 * The "do not restate a milestone's status" rule, in one place.
 *
 * WHY THIS EXISTS
 * ---------------
 * `README.zh.md` §「当前状态与下一步」 said `M0、M1、M2、M3、M4 验收均已闭环` and, eleven lines
 * later, `按 SPEC §0.3，M5 应在新的会话中开始` — six rounds after M5 had finished, in the section
 * whose whole job is to describe the present. There is no machine-readable "current milestone" to
 * compare prose against, so the rule is the other one: DO NOT RESTATE IT. `milestone-status.md` is
 * the register and the front door points at it.
 *
 * The patterns were written against the shapes that actually rotted rather than as a general
 * principle, because a loose rule ("a milestone near the word 闭环") flags 「M2 视觉闭环」 — the name
 * of a capability, in a directory listing, and correct. Each pattern asks for a CLAIM: a verdict
 * about verification, a milestone list with a verdict, a plan stated as the present, or a progress
 * report.
 *
 * WHY IT MOVED HERE (round 26): the rule now covers a third and fourth document — the issue and pull
 * request templates a contributor reads before running anything. A rule enforced by a copy of itself
 * in each suite is the defect this repository keeps paying for; the copy is what rots.
 *
 * Run: imported by the suites; not runnable on its own.
 *
 * Owner: DeepBlend Studio — M5
 */

/**
 * The shapes, in the order they were found rather than by generality.
 * @type {RegExp[]}
 */
export const MILESTONE_STATUS_CLAIMS = [
  // "M0、M1、M2、M3、M4 验收均已闭环" — a list of milestones with a verdict on the end.
  /M\d(?:\s*[、,和]\s*M\d)+[^\n。]{0,16}(闭环|完成|验收)/,
  // "M5 验收已闭环" / "M3 已完成" — one milestone, its verification, and a verdict.
  /M\d[^\n。]{0,8}验收[^\n。]{0,8}(闭环|完成|通过)/,
  /M\d[^\n。]{0,6}(已闭环|已完成|已验收)/,
  // "按 SPEC §0.3，M5 应在新的会话中开始" — a plan stated as the present.
  /M\d[^\n。]{0,24}(应在|将在|尚未开始|即将开始|还没有开始)/,
  // "M5 已经开始" — progress, which the register owns.
  /M\d[^\n。]{0,12}(已经开始|正在进行|仍未完成)/,
]

/**
 * The first status claim in this text, or `null`.
 *
 * Returns the whole LINE the claim sits on rather than the matched fragment: the fragment is what the
 * pattern needed to be precise, and the failure message is read by whoever has to fix the sentence.
 *
 * @param {string} text
 * @returns {string|null}
 */
export function findMilestoneStatusClaim(text) {
  for (const pattern of MILESTONE_STATUS_CLAIMS) {
    const found = pattern.exec(text)
    if (found === null) continue
    const start = text.lastIndexOf('\n', found.index) + 1
    const end = text.indexOf('\n', found.index)
    return text.slice(start, end === -1 ? text.length : end).trim()
  }
  return null
}
