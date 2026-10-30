import { config } from '../config.js';

/**
 * OpenAI Chat Completions를 JSON 모드로 한 번 호출해 파싱한 객체를 돌려준다.
 * 키가 없거나 응답이 잘못되면 예외를 던진다. 호출하는 쪽에서 패턴 풀·규칙 기반 변형기로 대체한다.
 */
export async function askJson(messages, { timeoutMs = 30000 } = {}) {
  if (!config.openaiKey) throw new Error('OPENAI_API_KEY가 없습니다');
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.openaiKey}` },
    body: JSON.stringify({
      model: config.openaiModel,
      response_format: { type: 'json_object' },
      messages,
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`OpenAI 응답 오류 ${res.status}`);
  const data = await res.json();
  try {
    return JSON.parse(data.choices?.[0]?.message?.content ?? '{}');
  } catch {
    throw new Error('OpenAI 응답이 JSON이 아닙니다');
  }
}
