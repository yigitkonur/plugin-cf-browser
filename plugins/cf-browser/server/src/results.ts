import { cfg } from './config.js';
export function plainResult(value: any) {
  return JSON.stringify(value, (_key, v) => v?.type === 'image' && v.data ? { type: 'image', mimeType: v.mimeType, delivered_as_image: true } : v, 2);
}
export function textResult(value: any): any {
  const images: any[] = [];
  const scan = (v: any) => { if (!v || typeof v !== 'object') return; if (v.type === 'image' && v.data && v.mimeType) { images.push(v); return; } for (const x of Object.values(v)) scan(x); };
  scan(value);
  if (value?.__content) return { content: value.__content, ...(value.__isError ? { isError: true } : {}) };
  let text = plainResult(value);
  if (text.length > 24_000 && value.operation_id && !value.result_page) text = JSON.stringify({ operation_id: value.operation_id, status: value.status, result_page: { encoding: 'json', text: plainResult(value.result).slice(0, 12_000), offset: 0, next_offset: 12_000 }, next: 'Use operation action=read with next_offset to continue the saved result. Do not repeat the original call.' });
  if (cfg.token) text = text.split(cfg.token).join('[redacted]');
  return { content: [{ type: 'text', text }, ...images], ...(value.error || value.status === 'failed' || value.status === 'cancelled' ? { isError: true } : {}) };
}
