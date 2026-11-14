// 多智能体协作编排：纯逻辑，真正的“发言”由调用方注入的 call() 完成（提示词智能体、Claude Code / Codex / Pi 等都可以）。
//   pipeline   接力：按顺序执行，后一位看到前面所有人的产出，最后一位的产出就是结果
//   roundtable 圆桌：多人轮流讨论若干轮，最后由最后一位综合出结论
//   supervisor 主管调度：第一位是主管，每一步决定“让谁做什么”或“结束并给出最终答案”
export const MODES = ['pipeline', 'roundtable', 'supervisor'];
export const LIMITS = { participants: 6, rounds: 4, steps: 16, contextChars: 24000, stepChars: 60000 };

export function validatePlan({ mode, participants, rounds }) {
  if (!MODES.includes(mode)) throw new Error('协作方式必须是 pipeline / roundtable / supervisor');
  if (!Array.isArray(participants) || participants.length < 1 || participants.length > LIMITS.participants) throw new Error(`参与者需要 1–${LIMITS.participants} 位`);
  if (mode !== 'pipeline' && participants.length < 2) throw new Error('这种协作方式至少需要 2 位参与者');
  const labels = new Set();
  for (const item of participants) {
    if (!item.label || labels.has(item.label)) throw new Error('每位参与者都要有不重复的名称');
    labels.add(item.label);
  }
  if (mode === 'roundtable' && (!Number.isInteger(rounds) || rounds < 1 || rounds > LIMITS.rounds)) throw new Error(`讨论轮数需要 1–${LIMITS.rounds}`);
}

const clip = (text, max) => text.length > max ? '…（前文已省略）\n' + text.slice(text.length - max) : text;
const render = transcript => clip(transcript.map(item => `【${item.label}】\n${item.text}`).join('\n\n'), LIMITS.contextChars);
const roleLine = p => `你的名称：${p.label}${p.role ? `\n你的职责：${p.role}` : ''}`;

export function buildPrompt({ mode, task, participant, transcript, round, rounds, last, roster, instruction }) {
  const history = transcript.length ? `\n\n目前的协作记录：\n${render(transcript)}` : '';
  if (mode === 'pipeline') {
    return `你正在参与一个多智能体接力任务。\n\n总任务：${task}\n${roleLine(participant)}${history}\n\n请完成属于你的部分，直接给出你的产出（不要复述任务）。${last ? '你是最后一位，你的产出就是最终结果。' : '后面的成员会基于你的产出继续。'}`;
  }
  if (mode === 'roundtable') {
    if (last === 'summary') return `你正在参与一个多智能体圆桌讨论，现在需要你综合所有发言。\n\n议题：${task}\n${roleLine(participant)}${history}\n\n请给出最终结论和可执行的方案，指出仍存在的分歧或风险。`;
    return `你正在参与一个多智能体圆桌讨论（第 ${round}/${rounds} 轮）。\n\n议题：${task}\n${roleLine(participant)}${history}\n\n请从你的职责出发发表看法：补充新信息、指出他人的问题或表示同意并说明理由。保持简洁，不要重复已有观点。`;
  }
  // supervisor 下的工人
  return `你是一个多智能体团队里的成员，主管给你分配了工作。\n\n总任务：${task}\n${roleLine(participant)}\n\n主管的指示：${instruction}${history}\n\n请完成指示的工作并直接给出产出。`;
}

function supervisorPrompt({ task, supervisor, workers, transcript, remaining }) {
  const roster = workers.map(w => `- ${w.label}${w.role ? '：' + w.role : ''}`).join('\n');
  return `你是多智能体团队的主管。你自己不直接干活，而是把工作分配给成员，直到任务完成。\n\n总任务：${task}\n${roleLine(supervisor)}\n\n可分配的成员：\n${roster}\n${transcript.length ? `\n目前的协作记录：\n${render(transcript)}\n` : ''}\n你最多还能安排 ${remaining} 次工作。只输出一个 JSON 对象，不要其他文字：\n- 继续分配：{"next":"成员名称","instruction":"给他的具体指示"}\n- 任务已完成：{"next":"FINISH","final":"面向用户的最终答案"}`;
}

// 容错解析主管的 JSON（可能被包在代码块或夹杂文字里）
export function parseDecision(text) {
  const candidates = [text, ...(text.match(/```(?:json)?\s*([\s\S]*?)```/g) || []).map(block => block.replace(/```(?:json)?|```/g, '')), text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)];
  for (const candidate of candidates) {
    try {
      const value = JSON.parse(candidate.trim());
      if (value && typeof value.next === 'string') return { next: value.next.trim(), instruction: String(value.instruction || ''), final: String(value.final || '') };
    } catch { /* 试下一个 */ }
  }
  return null;
}

export async function runCollaboration({ task, mode, participants, rounds = 2, maxSteps = 8, call, emit = () => {}, signal }) {
  validatePlan({ mode, participants, rounds });
  if (!task || !String(task).trim()) throw new Error('请填写任务');
  maxSteps = Math.min(Math.max(1, maxSteps), LIMITS.steps);
  const transcript = [], steps = [];
  let status = 'completed';

  async function speak(participant, prompt, extra = {}) {
    if (signal?.aborted) throw Object.assign(new Error('已停止'), { aborted: true });
    const index = steps.length;
    emit({ type: 'step_start', index, label: participant.label, ...extra });
    const result = await call({ participant, prompt, index, signal, onDelta: text => emit({ type: 'delta', index, text }) });
    const text = String(result.text ?? '').slice(0, LIMITS.stepChars);
    steps.push({ label: participant.label, text, usage: result.usage || null, ...extra });
    emit({ type: 'step_end', index, label: participant.label, text, usage: result.usage || null });
    return text;
  }
  const remember = (participant, text) => transcript.push({ label: participant.label, text });

  let final = '';
  try {
    if (mode === 'pipeline') {
      for (const [i, participant] of participants.entries()) {
        const text = await speak(participant, buildPrompt({ mode, task, participant, transcript, last: i === participants.length - 1 }), { round: 1 });
        remember(participant, text); final = text;
      }
    } else if (mode === 'roundtable') {
      if (participants.length * rounds + 1 > LIMITS.steps + 8) throw new Error('参与者与轮数过多');
      for (let round = 1; round <= rounds; round++) {
        for (const participant of participants) {
          const text = await speak(participant, buildPrompt({ mode, task, participant, transcript, round, rounds }), { round });
          remember(participant, text);
        }
      }
      const closer = participants[participants.length - 1];
      final = await speak(closer, buildPrompt({ mode, task, participant: closer, transcript, last: 'summary' }), { round: rounds + 1, summary: true });
    } else {
      const [supervisor, ...workers] = participants;
      let used = 0, lastWorkerText = '';
      while (true) {
        const remaining = maxSteps - used;
        if (remaining <= 0) { status = 'step_limit'; final = lastWorkerText || '已达到步数上限，未能得到最终答案。'; break; }
        let raw = await speak(supervisor, supervisorPrompt({ task, supervisor, workers, transcript, remaining }), { supervisor: true });
        let decision = parseDecision(raw);
        if (!decision) { // 再给一次机会：只要求格式
          raw = await speak(supervisor, supervisorPrompt({ task, supervisor, workers, transcript, remaining }) + '\n\n注意：上一次的输出不是合法 JSON。请只输出 JSON 对象。', { supervisor: true, retry: true });
          decision = parseDecision(raw);
        }
        if (!decision) { status = 'bad_decision'; final = raw; break; }
        if (decision.next.toUpperCase() === 'FINISH') { final = decision.final || lastWorkerText || raw; break; }
        const worker = workers.find(item => item.label === decision.next);
        if (!worker) { remember(supervisor, `（主管指定了不存在的成员“${decision.next}”，请从名单中选择。）`); used++; continue; }
        remember(supervisor, `→ 分配给 ${worker.label}：${decision.instruction}`);
        const text = await speak(worker, buildPrompt({ mode, task, participant: worker, transcript, instruction: decision.instruction }), { assignedBy: supervisor.label });
        remember(worker, text); lastWorkerText = text; used++;
      }
    }
  } catch (error) {
    if (!error.aborted && !signal?.aborted) throw Object.assign(error, { steps, partial: final });
    status = 'stopped';
    final = final || steps.at(-1)?.text || '';
  }
  emit({ type: 'done', status, final });
  return { status, final, steps };
}
