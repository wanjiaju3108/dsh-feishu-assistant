/**
 * dsh-feishu-assistant — 系统文件选择框。
 *
 * 设置页在浏览器里跑，拿不到宿主机的绝对路径，所以「选择文件」这一步回到宿主机上做：
 * 用各平台自带的方式弹出原生对话框，把选中的绝对路径回给设置页。插件仍然只读这个
 * 文件，不写它。
 */

import { execFile } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

/** 对话框最长等多久；用户一直不关就当放弃，别把 HTTP 请求永远挂着。 */
const PICK_TIMEOUT_MS = 180 * 1000;

/**
 * 弹出系统文件选择框。
 *
 * 返回的三种结果区分得比较细：选中（path）、用户取消（cancelled）、平台不支持或
 * 弹不出来（error）。设置页对「取消」不吭声，对「错误」要显示出来。
 *
 * @param deps.platform 目标平台，默认当前进程
 * @param deps.current 当前已配置的路径，用来定初始目录
 * @returns { path } | { cancelled: true } | { error }
 */
export async function pickPersonaFile({ platform = process.platform, current = '' } = {}) {
  const start = startDirectory(current);
  try {
    if (platform === 'darwin') return await pickWithAppleScript(start);
    if (platform === 'win32') return await pickWithPowerShell(start);
    if (platform === 'linux') return await pickWithZenity(start);
    return { error: `当前平台（${platform}）没有可用的系统文件选择框` };
  } catch (error) {
    return describeFailure(error);
  }
}

/**
 * 取对话框的初始目录。
 *
 * 只在目录确实存在时才用，否则 AppleScript 的 `default location` 会直接报错。
 *
 * @param current 当前配置的路径
 * @returns 存在的目录绝对路径；没有时返回空串
 */
function startDirectory(current) {
  const value = typeof current === 'string' ? current.trim() : '';
  if (!value) return '';
  try {
    return existsSync(value) && statSync(value).isDirectory() ? value : dirname(value);
  } catch {
    return '';
  }
}

/**
 * macOS：用 osascript 的 `choose file`，用参数传递、不拼 shell，避免注入。
 *
 * @param start 初始目录
 * @returns { path } 或 { cancelled: true }
 */
async function pickWithAppleScript(start) {
  const location = start ? ` default location POSIX file ${quoteAppleScript(start)}` : '';
  const script = `POSIX path of (choose file with prompt "选择人设文件"${location})`;
  const { stdout } = await run('osascript', ['-e', script], { timeout: PICK_TIMEOUT_MS });
  return { path: stdout.trim() };
}

/**
 * Windows：PowerShell 调 WinForms 的 OpenFileDialog。
 *
 * @param start 初始目录
 * @returns { path } 或 { cancelled: true }
 */
async function pickWithPowerShell(start) {
  const initial = start ? `$dialog.InitialDirectory = ${quotePowerShell(start)}; ` : '';
  const script = [
    'Add-Type -AssemblyName System.Windows.Forms;',
    '$dialog = New-Object System.Windows.Forms.OpenFileDialog;',
    '$dialog.Title = "选择人设文件";',
    `$dialog.Filter = "Markdown (*.md)|*.md|所有文件 (*.*)|*.*";`,
    initial,
    'if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { Write-Output $dialog.FileName }',
  ].join(' ');
  const { stdout } = await run(
    'powershell',
    ['-NoProfile', '-STA', '-Command', script],
    { timeout: PICK_TIMEOUT_MS },
  );
  const path = stdout.trim();
  return path ? { path } : { cancelled: true };
}

/**
 * Linux：优先 zenity，退到 kdialog。
 *
 * @param start 初始目录
 * @returns { path } 或 { cancelled: true }
 */
async function pickWithZenity(start) {
  const args = ['--file-selection', '--title=选择人设文件', '--file-filter=Markdown | *.md'];
  if (start) args.push(`--filename=${start}/`);
  const { stdout } = await run('zenity', args, { timeout: PICK_TIMEOUT_MS });
  const path = stdout.trim();
  return path ? { path } : { cancelled: true };
}

/**
 * 把「用户取消」和「真的弹不出来」分开。
 *
 * 三个平台的取消各有各的写法：AppleScript 报 -128，zenity 退出码 1，PowerShell 自己
 * 处理成空输出。剩下的（命令不存在、超时）都是错误。
 *
 * @param error 子进程抛出的错误
 * @returns { cancelled: true } 或 { error }
 */
function describeFailure(error) {
  const stderr = String(error?.stderr ?? '');
  const message = String(error?.message ?? error);
  if (/-128|User canceled|User cancelled/i.test(`${stderr}${message}`)) return { cancelled: true };
  if (error?.code === 1 && !stderr) return { cancelled: true };
  if (error?.code === 'ENOENT') {
    return { error: '这台机器上找不到可用的系统文件选择框（macOS 用 osascript，Windows 用 PowerShell，Linux 用 zenity）' };
  }
  if (error?.killed === true) return { cancelled: true };
  return { error: `弹出文件选择框失败：${stderr.trim() || message}` };
}

/**
 * 包一层 AppleScript 字符串字面量。
 *
 * @param value 原始文本
 * @returns 带引号的 AppleScript 字面量
 */
function quoteAppleScript(value) {
  return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
}

/**
 * 包一层 PowerShell 单引号字面量（单引号内只需转义单引号）。
 *
 * @param value 原始文本
 * @returns PowerShell 单引号字面量
 */
function quotePowerShell(value) {
  return `'${value.replaceAll("'", "''")}'`;
}
