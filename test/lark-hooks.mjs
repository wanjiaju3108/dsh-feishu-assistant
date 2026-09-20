/**
 * 把插件里的 `@larksuiteoapi/node-sdk` 换成 `fake-lark.mjs`。
 *
 * 必须和 harness 里 import 假 SDK 用的是同一个 URL（先 realpath 再转 URL），否则会加载成
 * 两个模块实例，`registry` 就对不上了。
 */

import { realpathSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

const STUB = pathToFileURL(realpathSync(fileURLToPath(new URL('./fake-lark.mjs', import.meta.url)))).href;

export async function resolve(specifier, context, next) {
  if (specifier === '@larksuiteoapi/node-sdk') return { url: STUB, shortCircuit: true };
  return next(specifier, context);
}
