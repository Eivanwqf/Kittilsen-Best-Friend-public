// M0 验证脚本：TS → Python bge-m3 GPU sidecar → 1024 维向量 + 余弦相似度 sanity check
// 验证：输出 1024 维、同义句 cos>0.7、无关句 cos<0.6、CUDA provider 生效
// 调用链：embed-env.sh（设置 CUDA 库路径）→ venv python → bge_m3_loader
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const WRAPPER = path.join(ROOT, 'scripts/embed-env.sh');

const INLINE = `
import json, sys
sys.path.insert(0, 'scripts')
from bge_m3_loader import BgeM3Embedder
texts = json.loads(sys.argv[1])
emb = BgeM3Embedder('.python/models/BAAI--bge-m3')
vecs = emb.embed(texts)
gpu = 'CUDAExecutionProvider' in emb.session.get_providers()
print(json.dumps({'vecs': vecs, 'gpu': gpu}))
`;

function embed(texts: string[]): { vecs: number[][]; gpu: boolean } {
  const out = execFileSync(WRAPPER, ['-c', INLINE, JSON.stringify(texts)], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 120_000,
  });
  const last = out.trim().split('\n').at(-1)!; // 跳过 loader 的 print
  return JSON.parse(last) as { vecs: number[][]; gpu: boolean };
}

// 句对：相似 / 无关（中文 embedding 无关句 cos 基线 ~0.4-0.5）
const pairs: Array<[string, string]> = [
  ['课题分离：把别人的课题和我的课题分开', '我最近在想课题分离这件事'],
  ['课题分离：把别人的课题和我的课题分开', '窗外在下雨，很适合睡觉'],
  ['健身计划：胸+肩+背轮流训练', '我昨天练了胸，今天练肩'],
];

const flat = pairs.flat();
const { vecs, gpu } = embed(flat);
const [a, b, _c, d] = vecs; // a/b = 同义对，d = 无关句（第 2 对的第二个）

function cos(x: number[], y: number[]): number {
  let dot = 0;
  for (let i = 0; i < x.length; i++) dot += x[i]! * y[i]!;
  return dot; // loader 已 L2 归一化
}

const dims = a.length;
const simSimilar = cos(a, b);
const simUnrelated = cos(a, d);

console.log(`gpu: ${gpu}`);
console.log(`dim: ${dims}`);
console.log(`cos(课题分离, 同义句) = ${simSimilar.toFixed(3)}`);
console.log(`cos(课题分离, 无关句) = ${simUnrelated.toFixed(3)}`);

const ok = gpu && dims === 1024 && simSimilar > 0.7 && simUnrelated < 0.6 && simSimilar > simUnrelated;
console.log(ok ? 'EMBED CHECK PASS' : 'EMBED CHECK FAIL');
process.exit(ok ? 0 : 1);
