export const TYPES = {
  sqli: { label: 'SQLi', name: 'SQL Injection' },
  xss: { label: 'XSS', name: 'Cross-Site Scripting' },
  path: { label: 'Path', name: 'Path Traversal' },
  cmd: { label: 'CMDi', name: 'Command Injection' },
};
export const TYPE_KEYS = Object.keys(TYPES);

// 룰에 붙는 정규화 플래그: 검사 전에 요청을 원래 모습으로 되돌린다
export const ALL_FLAGS = ['i', 'url', 'url2', 'cmt', 'ws'];
export const FLAG_LABEL = { i: '대소문자', url: 'URL디코딩', url2: '이중디코딩', cmt: '주석제거', ws: '공백정리' };
