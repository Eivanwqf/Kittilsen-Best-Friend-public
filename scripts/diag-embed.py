import sys, json
sys.path.insert(0, 'scripts')
import numpy as np
from bge_m3_loader import BgeM3Embedder

emb = BgeM3Embedder('.python/models/BAAI--bge-m3')
texts = [
    '我最近在想课题分离这件事',
    '课题分离：把别人的课题和我的课题分开',
    '2021年读《被讨厌的勇气》的笔记：通往地狱的路是由期望铺成的',
    '阿德勒心理学，目的论，一切烦恼来自人际关系',
    '今天是周六，天气不错',
    '窗外在下雨，很适合睡觉',
    '健身计划：胸+肩+背轮流训练',
    '我昨天练了胸，今天练肩',
]
vecs = np.array(emb.embed(texts))
# 相似度矩阵
sim = vecs @ vecs.T
names = [t[:12] for t in texts]
print('        ' + ''.join(f'{n:>14}' for n in names))
for i in range(len(texts)):
    row = ''.join(f'{sim[i][j]:>14.3f}' for j in range(len(texts)))
    print(f'{names[i]:>7} {row}')
# raw cls norm 检查
import onnxruntime as ort
from transformers import AutoTokenizer
tok = AutoTokenizer.from_pretrained('.python/models/BAAI--bge-m3/onnx')
sess = ort.InferenceSession('.python/models/BAAI--bge-m3/onnx/model.onnx', providers=['CPUExecutionProvider'])
enc = tok(['课题分离'], padding=True, return_tensors='np')
out = sess.run(None, dict(enc))[0]
print('raw cls token norm:', np.linalg.norm(out[0, 0]))
print('raw last token norm:', np.linalg.norm(out[0, -1]))
