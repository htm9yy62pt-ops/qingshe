/**
 * 让编译后的 harness 能解析项目里的 '@/xxx' 路径别名（tsc 不会重写 require 路径）。
 * 用法：node -r ./scripts/harness-alias.cjs .harness/scripts/route-harness.js
 */
const Module = require('module');
const path = require('path');

const SRC = path.join(__dirname, '..', '.harness', 'src');
const originalResolve = Module._resolveFilename;

Module._resolveFilename = function (request, ...rest) {
  if (typeof request === 'string' && request.startsWith('@/')) {
    return originalResolve.call(this, path.join(SRC, request.slice(2)), ...rest);
  }
  return originalResolve.call(this, request, ...rest);
};