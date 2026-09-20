/**
 * dsh-feishu-assistant — 设置页路由的请求守卫与读写。
 */

import { MAX_BODY_BYTES } from './constants.js';

/**
 * 请求守卫：只服务本机回环，且写入要求同源。
 *
 * @param req 请求
 * @param res 响应
 * @param method 允许的方法
 * @returns 通过时为 true；已写响应时为 false
 */
export function guard(req, res, method) {
  const address = req.socket?.remoteAddress ?? '';
  const loopback = address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
  if (!loopback) {
    sendJson(res, 403, { error: '只允许本机访问' });
    return false;
  }
  if (req.method !== method) {
    res.setHeader('allow', method);
    sendJson(res, 405, { error: `只接受 ${method}` });
    return false;
  }
  const origin = req.headers?.origin;
  if (origin && method !== 'GET') {
    let sameOrigin = false;
    try {
      sameOrigin = new URL(origin).host === req.headers?.host;
    } catch {
      sameOrigin = false;
    }
    if (!sameOrigin) {
      sendJson(res, 403, { error: '写入要求同源请求' });
      return false;
    }
  }
  return true;
}

/**
 * 读取并解析请求体 JSON。
 *
 * @param req 请求
 * @returns 解析结果
 */
export function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('error', reject);
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      if (!text) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(text));
      } catch {
        reject(new Error('请求体不是合法 JSON'));
      }
    });
  });
}

/**
 * 输出 JSON 响应。
 *
 * @param res 响应
 * @param status HTTP 状态码
 * @param body 响应体
 */
export function sendJson(res, status, body) {
  const text = JSON.stringify(body);
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.end(text);
}

/**
 * 归一化错误信息。
 *
 * @param error 任意错误值
 * @returns 可读文本
 */
export function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
